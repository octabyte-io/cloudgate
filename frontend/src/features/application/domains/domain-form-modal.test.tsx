import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { domainsApi, type Domain } from "@/lib/api/endpoints/domains";
import { settingsApi } from "@/lib/api/endpoints/settings";

import { addedDescription, DomainFormModal } from "./domain-form-modal";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const domain = {
  domainId: "d1",
  host: "hello.example.test",
  port: 3000,
  path: "/",
  stripPath: false,
  https: false,
  certificateType: "none",
  customCertResolver: null,
} as unknown as Domain;

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** The dialog, plus the two writes it is handed, so a test can watch for them. */
function mount(service?: { names: string[] | undefined; pending: boolean }) {
  const create = vi.fn(async () => {});
  const update = vi.fn(async () => {});
  render(
    withQuery(
      <DomainFormModal
        appName="app-hzr2ng"
        serverIp={null}
        serverId={null}
        domain={domain}
        open
        onOpenChange={() => {}}
        create={create}
        update={update}
        service={service}
        noun={service ? "stack" : undefined}
      />,
    ),
  );
  return { create, update };
}

function open(service?: { names: string[] | undefined; pending: boolean }) {
  mount(service);
  return document.body.textContent ?? "";
}

describe("DomainFormModal", () => {
  it("tells an Application owner a saved change reaches Traefik at once", () => {
    // `DomainsService.update` awaits `regenerateTraefikConfig` in the same
    // request; the dialog used to send them away to redeploy for it.
    const said = open();
    expect(said).toContain("Changes reach Traefik as soon as they are saved.");
    expect(said).not.toContain("next Deployment");
  });

  it("still tells a stack owner it waits for a deploy", () => {
    // The service field is present only for a Compose stack, whose routers do
    // travel as labels injected at deploy time.
    const said = open({ names: ["web"], pending: false });
    expect(said).toContain("Changes reach Traefik on this stack's next Deployment.");
  });

  it("refuses a path Traefik would drop, at the field, without the round trip", async () => {
    // This field's message always said "A path starts with /." and the schema
    // behind it accepted anything non-empty, on both sides. A path
    // carrying a backtick closes the ``PathPrefix(`…`)`` argument in the router
    // rule; one with no leading slash is a router Traefik silently drops.
    const { update } = mount();

    fireEvent.change(screen.getByLabelText(/Path/), {
      target: { value: "/api`) || Host(`victim.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText(/A path starts with \//)).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
  });

  it("prints no DNS record while the host is one the rule refuses", () => {
    // The panel is an instruction, not a read-out: `Type A` / `Name x11_app` /
    // `Value <address>` is something an operator goes and creates at their
    // provider. It read the field rather than a value the rule had passed, so a
    // refused host was still given a record to create (X11-6).
    mount();

    fireEvent.change(screen.getByLabelText(/Host/), {
      target: { value: "x11_app.example.com" },
    });

    expect(
      screen.queryByText("The record to create at your DNS provider"),
    ).toBeNull();
    // And no lookup can be asked for it either, which is what keeps the
    // refusal from hiding an answer. `aria-disabled` rather than `disabled`
    // because that is what an off `Button` carries here (§3.10).
    expect(
      screen
        .getByRole("button", { name: /Check DNS/ })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("prints the DNS record for a host the rule accepts, whitespace and all", () => {
    // The half the gate must not cost: the record is still derived for anything
    // the form would send, and surrounding whitespace is not a malformed host.
    mount();

    fireEvent.change(screen.getByLabelText(/Host/), {
      target: { value: "  api.example.com  " },
    });

    expect(
      screen.getByText("The record to create at your DNS provider"),
    ).toBeTruthy();
    expect(screen.getByText("api")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: /Check DNS/ })
        .getAttribute("aria-disabled"),
    ).not.toBe("true");
  });

  it("names the zone it assumed under a Name it derived from a longer one", () => {
    // The derivation cuts the zone at the last two labels, which is wrong for a
    // public suffix: `api.example.co.uk` prints `api.example` where that zone's
    // form wants `api`, and the operator finds out when the record does not
    // resolve. Fixed as copy rather than as a public-suffix list, so what the
    // panel owes the operator is the assumption it made (H-145).
    mount();

    fireEvent.change(screen.getByLabelText(/Host/), {
      target: { value: "api.example.co.uk" },
    });

    // The derivation itself is unchanged — this is disclosure, not a new cut.
    expect(screen.getByText("api.example")).toBeTruthy();
    // The whole sentence, because half of it is interpolated and this file has
    // already paid for a lost space around an expression once ("This
    // stackruns on…", above): a note that reads "labels —co.uk" is a note
    // nobody trusts.
    expect(
      screen.getByText(/takes your zone to be the last two labels/).textContent,
    ).toBe(
      "Name is the part in front of your zone, and this takes your zone to be the last two labels — co.uk. A longer zone, like example.co.uk, means a shorter Name: take off the labels your zone already covers, or use @ if that leaves none.",
    );
  });

  it("names the zone it assumed when the assumption is the right one", () => {
    // The note is not a warning about suspicious hosts — there is no heuristic
    // that could tell them apart without the list this deliberately does not
    // carry. It states the assumption every time, and for an ordinary domain it
    // reads as confirmation.
    mount();

    fireEvent.change(screen.getByLabelText(/Host/), {
      target: { value: "api.example.com" },
    });

    expect(screen.getByText("api")).toBeTruthy();
    expect(screen.getByText("example.com")).toBeTruthy();
  });

  it("says what @ is instead, where the record is the zone itself", () => {
    // Exactly one line under the table talks about the zone, whichever way the
    // cut fell: the apex case keeps the note it already had.
    mount();

    fireEvent.change(screen.getByLabelText(/Host/), {
      target: { value: "example.com" },
    });

    expect(screen.getByText(/means the zone itself/)).toBeTruthy();
    expect(
      screen.queryByText(/takes your zone to be the last two labels/),
    ).toBeNull();
  });

  it("refuses a Traefik resolver name outside the charset, at the field", async () => {
    // The resolver reaches `…tls.certresolver=<name>` as a Docker label value,
    // and Docker splits a label on its first `=` — so an `=` here truncates the
    // label key. This is the one place the console offers the field, so
    // it is the one place the mirror can be checked.
    const { update } = mount();

    // A certificate is chosen with HTTPS on: Strip the path, then
    // Serve over HTTPS.
    fireEvent.click(screen.getAllByRole("switch")[1]);
    fireEvent.click(screen.getByRole("button", { name: "Custom resolver" }));
    fireEvent.change(screen.getByLabelText(/Traefik resolver/), {
      target: { value: "letsencrypt=x" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText(
        /Use only letters, numbers, underscores and hyphens/,
      ),
    ).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
  });

  it("shows a Check DNS verdict only under the host it was asked about", async () => {
    // The verdict renders against the field's *current* host, so typing over
    // a checked host relabelled the old lookup with the new name — "nope.invalid
    // is behind Cloudflare. It resolves to 104.20.23.154" about a host nobody
    // had looked up. Only Generate cleared it.
    const validate = vi
      .spyOn(domainsApi, "validate")
      .mockResolvedValue({
        isValid: true,
        resolvedIp: "104.20.23.154, 172.66.147.243",
        cdnProvider: "Cloudflare",
      });
    mount();

    const field = screen.getByLabelText(/Host/);
    fireEvent.change(field, { target: { value: "example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Check DNS/ }));
    expect(
      await screen.findByText("example.com is behind Cloudflare."),
    ).toBeTruthy();

    fireEvent.change(field, { target: { value: "nope.invalid" } });

    expect(screen.queryByText(/nope\.invalid is behind/)).toBeNull();
    expect(screen.queryByText(/104\.20\.23\.154/)).toBeNull();
    expect(validate).toHaveBeenCalledTimes(1);

    // Asking again is what brings a verdict back, and it names the new host.
    fireEvent.click(screen.getByRole("button", { name: /Check DNS/ }));
    await waitFor(() => expect(validate).toHaveBeenCalledTimes(2));
    expect(validate).toHaveBeenLastCalledWith("nope.invalid", undefined);
    expect(
      await screen.findByText("nope.invalid is behind Cloudflare."),
    ).toBeTruthy();
  });
});

/**
 * Where the dialog gets the address it prints and checks against, for a service
 * on Cloudgate's own host.
 *
 * `serverIp` is `null` here because there is no `server` row — not because
 * there is no address. The instance records its own under Settings → Instance,
 * which is also what `generateDomain` writes into a generated host, and once
 * nothing in this dialog read it: the record's Value was the words "this
 * machine's public address" and Check DNS was sent no address to compare
 * against at all.
 */
describe("DomainFormModal on Cloudgate's own host", () => {
  it("prints the instance's own address as the record's Value", async () => {
    vi.spyOn(settingsApi, "ip").mockResolvedValue("203.0.113.10");
    mount();

    fireEvent.change(screen.getByLabelText(/Host/), {
      target: { value: "api.example.com" },
    });

    expect(await screen.findByText("203.0.113.10")).toBeTruthy();
    expect(screen.queryByText(/no address recorded/)).toBeNull();
  });

  it("checks DNS against it, rather than against nothing", async () => {
    vi.spyOn(settingsApi, "ip").mockResolvedValue("203.0.113.10");
    const validate = vi.spyOn(domainsApi, "validate").mockResolvedValue({
      isValid: true,
      resolvedIp: "203.0.113.10",
    } as Awaited<ReturnType<typeof domainsApi.validate>>);
    mount();

    fireEvent.change(screen.getByLabelText(/Host/), {
      target: { value: "api.example.com" },
    });
    // The address arrives from its own request, so the panel has to have it
    // before the button is pressed — the same wait an operator does not notice.
    await screen.findByText("203.0.113.10");
    fireEvent.click(screen.getByRole("button", { name: /Check DNS/ }));

    await waitFor(() =>
      expect(validate).toHaveBeenCalledWith("api.example.com", "203.0.113.10"),
    );
    // And with something to compare, the verdict is the one that means it.
    expect(
      await screen.findByText("api.example.com points here."),
    ).toBeTruthy();
  });

  it("says what to set when the instance records no address", async () => {
    vi.spyOn(settingsApi, "ip").mockResolvedValue("");
    mount();

    fireEvent.change(screen.getByLabelText(/Host/), {
      target: { value: "api.example.com" },
    });

    const link = await screen.findByRole("link", {
      name: "Settings → Instance",
    });
    expect(link.getAttribute("href")).toBe("/settings/instance");
  });
});

/**
 * The Certificate control: a fourth choice for a certificate from
 * Settings → Certificates, and a hint that says what the *selected* choice does
 * — it used to promise Let's Encrypt whichever was picked.
 */
describe("DomainTlsFields", () => {
  const hint = () =>
    screen
      .getByRole("group", { name: "Certificate" })
      .closest("[data-slot=field]")
      ?.querySelector("[data-slot=field-description]")?.textContent ?? "";
  const pressed = () =>
    screen
      .getByRole("group", { name: "Certificate" })
      .querySelector("[aria-pressed=true]")?.textContent;

  it("says what each certificate choice does, under the control", () => {
    mount();
    // By order: Strip the path, then Serve over HTTPS.
    fireEvent.click(screen.getAllByRole("switch")[1]);

    fireEvent.click(screen.getByRole("button", { name: "Let's Encrypt" }));
    expect(hint()).toContain("Let's Encrypt issues one automatically");
    expect(hint()).toContain("served instead");

    fireEvent.click(screen.getByRole("button", { name: "Custom resolver" }));
    expect(hint()).toContain("resolver configured");

    fireEvent.click(screen.getByRole("button", { name: "Stored certificate" }));
    expect(hint()).toContain("whose names cover this host");
    expect(hint()).not.toContain("Let's Encrypt issues one");
    const link = screen.getByRole("link", { name: "Settings → Certificates" });
    expect(link.getAttribute("href")).toBe("/settings/certificates");
  });

  it("holds the certificate at None while HTTPS is off, and says why", async () => {
    const { update } = mount();
    expect(pressed()).toBe("None");
    expect(hint()).toContain("HTTPS is off, so no certificate is served.");
    expect(hint()).not.toContain("Turn HTTPS off");

    // Off, the choice cannot be made.
    fireEvent.click(screen.getByRole("button", { name: "Let's Encrypt" }));
    expect(pressed()).toBe("None");
    expect(
      screen
        .getByRole("button", { name: "Let's Encrypt" })
        .getAttribute("aria-disabled"),
    ).toBe("true");

    // On picks Let's Encrypt; off again puts None back.
    fireEvent.click(screen.getAllByRole("switch")[1]);
    expect(pressed()).toBe("Let's Encrypt");
    fireEvent.click(screen.getAllByRole("switch")[1]);
    expect(pressed()).toBe("None");

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith(
      "d1",
      expect.objectContaining({
        https: false,
        certificateType: "none",
        customCertResolver: null,
      }),
    );
  });

  it("sends stored, with no resolver, for HTTPS from a stored certificate", async () => {
    const { update } = mount();

    // The two switches carry no accessible name (their Fields are `manual`), so
    // by order: Strip the path, then Serve over HTTPS.
    fireEvent.click(screen.getAllByRole("switch")[1]);
    fireEvent.click(screen.getByRole("button", { name: "Stored certificate" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith(
      "d1",
      expect.objectContaining({
        https: true,
        certificateType: "stored",
        customCertResolver: null,
      }),
    );
  });

  it("does not call a stored certificate issued, when HTTPS has no source", async () => {
    const { update } = mount();

    fireEvent.click(screen.getAllByRole("switch")[1]);
    fireEvent.click(screen.getByRole("button", { name: "None" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText(
        "Choose where the certificate comes from, or turn HTTPS off.",
      ),
    ).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
  });
});

/**
 * The toast after an add: it said "answering on it now" to an
 * Application that had never run.
 */
describe("addedDescription", () => {
  it("says an Application that is not running answers only once it runs", () => {
    const said = addedDescription("Application", false, false);
    expect(said).toContain("is not running");
    expect(said).not.toContain("answers on it with no Deployment");
  });

  it("says a running Application answers with no Deployment", () => {
    expect(addedDescription("Application", false, true)).toContain(
      "is running, so it answers on it with no Deployment",
    );
  });

  it("claims neither where the parent has no running status", () => {
    const said = addedDescription("bucket", false, undefined);
    expect(said).toContain("whenever it is running");
  });

  it("sends a stack to its next Deployment, running or not", () => {
    expect(addedDescription("stack", true, true)).toContain(
      "next Deployment of this stack",
    );
  });
});
