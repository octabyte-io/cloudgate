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

import { licenseApi } from "@/lib/api/endpoints/license";
import { settingsApi } from "@/lib/api/endpoints/settings";

const useActiveOrganizationId = vi.hoisted(() => vi.fn());

// One system boundary, replaced rather than driven: better-auth's session store,
// which `useInvalidate` reads at render. The other is `settingsApi.assignDomain`
// below — the POST itself — spied on so a test can watch whether the round trip
// was made at all.
vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));

const { AssignDomainCard } = await import("./console-domain-card");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useActiveOrganizationId.mockReset();
});

/**
 * The card as the Platform section mounts it, plus the write it makes.
 *
 * `licensed` is the third boundary, `GET /license/status`: the origin notice
 * names a different route with and without a licence. Left `undefined`
 * the read never answers, which is the in-flight state the notice has to be
 * honest about too.
 */
function mount(licensed?: boolean) {
  useActiveOrganizationId.mockReturnValue({
    organizationId: "org-1",
    pending: false,
  });
  vi.spyOn(licenseApi, "status").mockImplementation(() =>
    licensed === undefined
      ? new Promise(() => {})
      : Promise.resolve({
          licensed,
          status: licensed ? "active" : "inactive",
          validUntil: null,
          features: [],
        } as never),
  );
  const assignDomain = vi
    .spyOn(settingsApi, "assignDomain")
    .mockResolvedValue({} as never);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrap = (children: ReactNode) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(
    wrap(
      <AssignDomainCard
        host="console.example.com"
        https={false}
        certificateType="none"
        letsEncryptEmail={null}
      />,
    ),
  );
  return { assignDomain };
}

describe("AssignDomainCard", () => {
  it("refuses a console host Traefik would drop, at the field, without the round trip", async () => {
    // The host reaches ``Host(`<host>`)`` in `dynamic/cloudgate.yml`, and a
    // label ending in `-` is a rule Traefik discards: the console silently
    // stopped answering on the name and the operator was told nothing. The box
    // accepted anything up to 255 characters until the DTO gained the rule.
    const { assignDomain } = mount();

    fireEvent.change(screen.getByLabelText(/Host/), {
      target: { value: "console-.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText(/Use only letters, numbers, hyphens and dots/),
    ).toBeTruthy();
    expect(assignDomain).not.toHaveBeenCalled();
  });

  it("sends a host without the whitespace it was pasted with", async () => {
    // The policy the shared rule owns rather than each form (X11-5): the
    // backend refuses surrounding whitespace in words of its own
    // (`hostSchema`: 'Domain name cannot have leading or trailing spaces'), and
    // this form resolves it instead of forwarding it — so the value that
    // reaches ``Host(`…`)`` in `dynamic/cloudgate.yml` is the one the rule was
    // applied to, and that refusal is unreachable from here rather than
    // contradicted.
    const { assignDomain } = mount();

    fireEvent.change(screen.getByLabelText(/Host/), {
      target: { value: "  console.example.com  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(assignDomain).toHaveBeenCalled());
    expect(assignDomain.mock.calls[0][0].host).toBe("console.example.com");
  });

  it("still saves an empty host, which is how the console domain is unassigned", async () => {
    // The regression the rule had to leave alone: an empty box is not a
    // malformed host but a deliberate action — the backend reads it as "no
    // console domain" and deletes `dynamic/cloudgate.yml`, which is what the
    // footer warns about.
    const { assignDomain } = mount();

    fireEvent.change(screen.getByLabelText(/Host/), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    // The body, not the argument list: TanStack Query hands a mutationFn its
    // own context as a second argument.
    await waitFor(() => expect(assignDomain).toHaveBeenCalled());
    expect(assignDomain.mock.calls[0][0]).toEqual({
      host: "",
      https: false,
      certificateType: "none",
      letsEncryptEmail: null,
    });
  });
});

/**
 * The constraint a save walks an operator into, said before the save.
 *
 * Saving a console domain produced an HTTPS console on which every sign-in was
 * refused `403 INVALID_ORIGIN`, and this card said nothing about origins, the
 * API or sign-in. The notice has two halves because there are two constraints
 * and only one of them is an allowlist: the backend must trust the origin, and
 * the live screens need `CLOUDGATE_API_URL` changed to match, which is a
 * restart of the console and not a rebuild (ADR-0082).
 */
describe("AssignDomainCard's origin notice", () => {
  const text = () => document.body.textContent ?? "";

  it("says before the save that signing in there needs the origin trusted, and that saving does not add it", () => {
    mount();

    expect(text()).toContain(
      "Nobody can sign in on this domain until the backend trusts its origin",
    );
    expect(text()).toContain("saving does not add it");
  });

  it("says the live screens need CLOUDGATE_API_URL changed and the console restarted, which no allowlist cures", () => {
    mount();

    expect(text()).toContain("CLOUDGATE_API_URL");
    expect(text()).toContain("then restart the console");
    expect(text()).not.toContain("rebuild");
  });

  it("names the Trusted origins card, and no restart, on a licensed Organization", async () => {
    mount(true);

    await waitFor(() =>
      expect(text()).toContain("which takes effect at once with no restart"),
    );
    expect(
      screen.getByRole("link", { name: "Settings → Single sign-on" }).getAttribute("href"),
    ).toBe("/settings/sso");
    expect(text()).not.toContain("restart the backend");
  });

  it("says plainly that the card needs a license, and names the env file and restart, on an unlicensed one", async () => {
    mount(false);

    await waitFor(() =>
      expect(text()).toContain(
        "needs an enterprise license and this Organization has none",
      ),
    );
    expect(text()).toContain("TRUSTED_ORIGINS");
    expect(text()).toContain("restart the backend");
  });

  it("names both routes while the license is not known", () => {
    mount();

    expect(text()).toContain(
      "which takes effect at once and needs an enterprise license. Without a license,",
    );
  });

  it("names the origin a browser will send for the host as it is typed", () => {
    mount();

    fireEvent.change(screen.getByLabelText(/Host/), {
      target: { value: "Panel.Example.com" },
    });

    // Lower-cased, as the browser sends it and better-auth compares it.
    expect(text()).toContain(
      "Browsers signing in there send the origin http://panel.example.com.",
    );
  });
});
