import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { domainsApi, type DomainValidation } from "@/lib/api/endpoints/domains";
import type { SetupForm } from "@/lib/api/endpoints/templates";

import { newProjectTargets } from "./new-project-targets";
import { SetupFormView } from "./setup-form";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * A Template setup's Domain field, when the host is the operator's own
 * domain: the A record it needs and Check DNS, as the Add a domain dialog
 * shows them, before any Domain row exists. Every address below is one the
 * fixture's generated host carries, written out by hand rather than read
 * back through the code under test.
 */

const SERVER_IP = "198.51.100.7";

const FORM: SetupForm = {
  templateId: "ghost",
  templateName: "Ghost",
  revision: "abc1234",
  setupName: "ghost",
  asked: [],
  domains: [{ name: "ghost", service: "ghost", port: 2368, path: "/" }],
  environments: [
    {
      environmentId: "env-prod",
      name: "production",
      canTake: true,
      reason: null,
      hosts: { ghost: "ghost-ghost-1a2b3c-198-51-100-7.sslip.io" },
      cloudDomains: null,
      machine: { serverId: null },
    },
    {
      environmentId: "env-bare",
      name: "bare",
      canTake: true,
      reason: null,
      hosts: null,
      cloudDomains: null,
      machine: { serverId: null },
    },
    {
      environmentId: "env-aws",
      name: "aws",
      canTake: true,
      reason: null,
      hosts: null,
      cloudDomains: {
        pointsAt: {
          dnsName: "cg-1234567890.eu-central-1.elb.amazonaws.com",
          kind: "load-balancer",
        },
      },
      machine: null,
    },
  ],
  deployTargets: { server: null, platformHost: null, aws: null, gcp: null },
  images: [],
  newProjectHosts: null,
};

function renderForm(
  form: SetupForm = FORM,
  extra: Partial<Parameters<typeof SetupFormView>[0]> = {},
) {
  const onSubmit = vi.fn();
  const ui: ReactElement = (
    <SetupFormView form={form} onSubmit={onSubmit} {...extra} />
  );
  render(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );
  return onSubmit;
}

const hostField = () =>
  screen.getByLabelText(/ghost’s Domain/) as HTMLInputElement;

const typeHost = (value: string) =>
  fireEvent.change(hostField(), { target: { value } });

/** The record's three fields, as the panel's `dl` lists them. */
function record(): Record<string, string> {
  const list = screen
    .getByText("The record to create at your DNS provider")
    .parentElement!.querySelector("dl")!;
  const terms = [...list.querySelectorAll("dt")].map((dt) => dt.textContent!);
  const values = [...list.querySelectorAll("dd")].map((dd) => dd.textContent!);
  return Object.fromEntries(terms.map((term, at) => [term, values[at]]));
}

function answer(result: Partial<DomainValidation>) {
  return vi
    .spyOn(domainsApi, "validate")
    .mockResolvedValue(result as DomainValidation);
}

describe("DomainHostFields, on a Server", () => {
  it("shows the A record for an own domain, pointing at the Server's address, and Check DNS", () => {
    renderForm();
    typeHost("blog.example.com");

    expect(record()).toEqual({ Type: "A", Name: "blog", Value: SERVER_IP });
    expect(screen.getByRole("button", { name: "Check DNS" })).toBeTruthy();
    // Generate is still offered beside it, to go back to the free host.
    expect(
      screen.getByRole("button", { name: "Generate one for me" }),
    ).toBeTruthy();
  });

  it("names the record and the address in the hint, in place of pointing DNS at the Server", () => {
    renderForm();

    const said = document.body.textContent ?? "";
    expect(said).toContain("works right away");
    expect(said).toContain(
      `type it here and add an A record for it pointing at ${SERVER_IP}.`,
    );
    expect(said).not.toContain("point its DNS at the Server");
  });

  it("names an apex domain's record @", () => {
    renderForm();
    typeHost("example.com");

    expect(record()).toEqual({ Type: "A", Name: "@", Value: SERVER_IP });
  });

  it("shows no record and no check for the generated sslip.io host, or one typed", () => {
    renderForm();

    expect(screen.queryByRole("button", { name: "Check DNS" })).toBeNull();
    expect(screen.queryByText(/The record to create/)).toBeNull();
    expect(screen.queryByText(/There is no record to create/)).toBeNull();

    typeHost("blog-203-0-113-10.sslip.io");
    expect(screen.queryByRole("button", { name: "Check DNS" })).toBeNull();
    expect(screen.queryByText(/record to create/)).toBeNull();
  });

  it("shows nothing for a host the rule refuses", () => {
    renderForm();
    typeHost("x11_app.example.com");

    expect(screen.queryByRole("button", { name: "Check DNS" })).toBeNull();
    expect(screen.queryByText(/The record to create/)).toBeNull();
  });
});

describe("DomainHostFields, on this Cloudgate host", () => {
  const TARGETS = newProjectTargets(
    [],
    [],
    { server: null, platformHost: null, aws: null, gcp: null },
    { platformHost: true },
  );

  it("points the record at the platform host's public address its generated host carries", () => {
    renderForm(
      {
        ...FORM,
        environments: [],
        newProjectHosts: {
          servers: {},
          platformHost: { ghost: "ghost-ghost-9f8e7d-192-0-2-44.sslip.io" },
        },
      },
      { newProject: { targets: TARGETS } },
    );
    typeHost("shop.example.org");

    expect(record()).toEqual({ Type: "A", Name: "shop", Value: "192.0.2.44" });
  });

  it("says where to set the address when none is recorded", () => {
    renderForm();
    fireEvent.click(screen.getByRole("radio", { name: /bare/ }));
    typeHost("blog.example.com");

    expect(record().Value).toBe("this machine's public address");
    const links = screen.getAllByRole("link", { name: /Settings/ });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute("href")).toBe("/settings/instance");
    }
    expect(screen.getByRole("button", { name: "Check DNS" })).toBeTruthy();
  });
});

describe("DomainHostFields, Check DNS", () => {
  it("asks about the typed host and the Server's address, and says it points here", async () => {
    const validate = answer({ isValid: true, resolvedIp: SERVER_IP });
    renderForm();
    typeHost("blog.example.com");

    fireEvent.click(screen.getByRole("button", { name: "Check DNS" }));

    expect(
      await screen.findByText("blog.example.com points here."),
    ).toBeTruthy();
    expect(validate).toHaveBeenCalledWith("blog.example.com", SERVER_IP);
  });

  it("says a host resolving elsewhere does not point here yet, and that Set up does not wait for it", async () => {
    answer({
      isValid: false,
      resolvedIp: "203.0.113.9",
      error: "Domain resolves to 203.0.113.9, expected 198.51.100.7",
    });
    const onSubmit = renderForm();
    typeHost("blog.example.com");

    fireEvent.click(screen.getByRole("button", { name: "Check DNS" }));

    const verdict = (
      await screen.findByText("blog.example.com does not point here yet.")
    ).parentElement!;
    expect(within(verdict).getByText("203.0.113.9")).toBeTruthy();
    expect(verdict.textContent).toContain("Set up does not wait for them");

    // A failed check warns; it does not hold the setup back.
    fireEvent.click(screen.getByRole("button", { name: /Set up and review/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ hosts: { ghost: "blog.example.com" } }),
    );
  });

  it("says a host with no record does not point here yet", async () => {
    answer({ isValid: false, error: "Domain not found" });
    renderForm();
    typeHost("blog.example.com");

    fireEvent.click(screen.getByRole("button", { name: "Check DNS" }));

    expect(
      await screen.findByText("blog.example.com does not point here yet."),
    ).toBeTruthy();
  });

  it("reads a CDN in front of the host as a note, not a failure", async () => {
    answer({
      isValid: true,
      resolvedIp: "104.16.0.1",
      cdnProvider: "Cloudflare",
      error: "Domain is behind Cloudflare",
    });
    renderForm();
    typeHost("blog.example.com");

    fireEvent.click(screen.getByRole("button", { name: "Check DNS" }));

    expect(
      await screen.findByText("blog.example.com is behind Cloudflare."),
    ).toBeTruthy();
    expect(screen.queryByText(/does not point here yet/)).toBeNull();
  });

  it("keeps a verdict to the host it was asked about", async () => {
    answer({ isValid: true, resolvedIp: SERVER_IP });
    renderForm();
    typeHost("blog.example.com");
    fireEvent.click(screen.getByRole("button", { name: "Check DNS" }));
    await screen.findByText("blog.example.com points here.");

    typeHost("shop.example.com");
    expect(screen.queryByText(/points here/)).toBeNull();
  });
});

describe("DomainHostFields, in a Cloud Environment", () => {
  it("keeps the records and points the check at the stack's Domains tab after Apply", () => {
    renderForm();
    fireEvent.click(screen.getByRole("radio", { name: /aws/ }));
    typeHost("blog.example.com");

    expect(
      screen.getByText(
        "blog.example.com CNAME cg-1234567890.eu-central-1.elb.amazonaws.com",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Once Apply has made the Stack VM, the stack's Domains tab lists its certificate's validation record and checks both records\./,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check DNS" })).toBeNull();
  });
});
