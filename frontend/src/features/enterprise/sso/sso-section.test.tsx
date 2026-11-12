import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type { AllowanceSource } from "@/lib/api/endpoints/billing";
import type { ScimProvider } from "@/lib/api/endpoints/scim";
import type { SsoProvider } from "@/lib/api/endpoints/sso";

const state = vi.hoisted(() => ({
  licensed: false,
  plan: "starter" as AllowanceSource | null,
  role: "owner",
  providers: [] as unknown[],
  scim: [] as unknown[],
  error: null as unknown,
  scheduledAt: null as string | null,
}));

const keepBusiness = vi.hoisted(() => vi.fn());

const query = (data: unknown) => ({
  data,
  isPending: false,
  error: null,
  isFetching: false,
});
const mutation = () => ({ isPending: false, mutateAsync: vi.fn() });

vi.mock("@/lib/api/use-instance-mode", () => ({
  useInstanceMode: () => ({ data: "hosted", isPending: false }),
}));
vi.mock("@/lib/auth/client", () => ({
  useActiveOrganizationId: () => ({ organizationId: "org-1", pending: false }),
}));
vi.mock("@/features/enterprise/use-license", () => ({
  useLicenseStatus: () =>
    query({ licensed: state.licensed, status: "inactive", validUntil: null }),
}));
vi.mock("@/lib/api/use-organizations", () => ({
  useOrganizations: () =>
    query([
      { id: "org-1", name: "Northwind Labs", member: { role: state.role } },
    ]),
}));
vi.mock("@/lib/api/use-billing", () => ({
  usePlan: () => query({ plan: state.plan, scheduledAt: state.scheduledAt }),
  useTrialOpen: () => false,
  useSubscription: () => query({ status: "active", trial: null }),
  useKeepBusiness: () => ({ isPending: false, mutateAsync: keepBusiness }),
}));
vi.mock("@/components/console/upgrade-confirm", () => ({
  UpgradeConfirm: () => null,
}));
vi.mock("./use-sso", () => ({
  useSsoProviders: () =>
    state.error
      ? { data: undefined, isPending: false, error: state.error }
      : query(state.providers),
  useScimProviders: () =>
    state.error
      ? { data: undefined, isPending: false, error: state.error }
      : query(state.scim),
  useSsoRedirectUri: () =>
    query("https://cg.example/api/auth/sso/callback/{providerId}"),
  useTrustedOrigins: () => query(["https://acme.okta.com"]),
  useProvenDomains: () =>
    query([
      {
        domain: "acme.example.com",
        proven: false,
        provenAt: null,
        record: { type: "TXT", name: "_cg.acme.example.com", value: "abc" },
      },
    ]),
  useEnforceSso: () => query(false),
  useSetEnforceSso: mutation,
  useSaveSsoProvider: mutation,
  useRemoveSsoProvider: mutation,
  useAddTrustedOrigin: mutation,
  useRemoveTrustedOrigin: mutation,
  useAddProvenDomain: mutation,
  useCheckProvenDomain: mutation,
  useRemoveProvenDomain: mutation,
  useCreateScimProvider: mutation,
  useRemoveScimProvider: mutation,
}));

const { SsoSection } = await import("./sso-section");

const OKTA = {
  id: "p1",
  providerId: "okta",
  issuer: "https://acme.okta.com/oauth2/default",
  domains: ["acme.example.com"],
  oidcConfig: { clientId: "x" },
  hasSamlConfig: false,
  hasClientSecret: true,
} as unknown as SsoProvider;

const DIRECTORY: ScimProvider = {
  id: "s1",
  providerId: "okta-scim",
  organizationId: "org-1",
  lastRefusedAddAt: "2026-11-11T14:02:00.000Z",
  lastRefusedAddEmail: "sam.ortiz@northwind.dev",
};

afterEach(() => {
  cleanup();
  Object.assign(state, {
    licensed: false,
    plan: "starter",
    role: "owner",
    providers: [],
    scim: [],
    error: null,
    scheduledAt: null,
  });
  keepBusiness.mockReset();
});

const off = (name: string | RegExp) =>
  screen.getByRole("button", { name }).getAttribute("aria-disabled");

/** The SSO page below Business, kept but stopped or never set up. */
describe("SsoSection below Business", () => {
  it("shows kept providers read-only under one strip, with Remove on", () => {
    state.providers = [OKTA];
    state.scim = [DIRECTORY];
    render(<SsoSection />);

    const strips = screen.getAllByRole("status");
    expect(strips).toHaveLength(1);
    expect(strips[0].textContent).toContain(
      "SSO sign-in is off, and SCIM can't add people. This Organization is on Starter. The settings below are kept and work again on Business.",
    );
    expect(
      within(strips[0]).getByRole("button", { name: "Upgrade to Business" }),
    ).toBeTruthy();

    // Both "Add a provider" buttons (SSO and SCIM), Edit, the domain check
    // and the two add forms are off; every removal is on.
    for (const add of screen.getAllByRole("button", {
      name: "Add a provider",
    })) {
      expect(add.getAttribute("aria-disabled")).toBe("true");
    }
    expect(off("Edit")).toBe("true");
    expect(off("Check now")).toBe("true");
    expect(off("Add domain")).toBe("true");
    expect(off("Trust it")).toBe("true");
    for (const remove of screen.getAllByRole("button", { name: /^Remove/ })) {
      expect(remove.getAttribute("aria-disabled")).not.toBe("true");
    }
    expect(off("Stop trusting https://acme.okta.com")).not.toBe("true");
    expect(screen.getByText("Off on Starter")).toBeTruthy();
    expect(screen.getByText("Removing only")).toBeTruthy();
  });

  it("shows the last add SCIM refused, when and for whom", () => {
    state.scim = [DIRECTORY];
    render(<SsoSection />);

    const refused = screen.getByLabelText("Last refused add");
    expect(refused.textContent).toContain("sam.ortiz@northwind.dev");
    expect(refused.querySelector("time")?.getAttribute("dateTime")).toBe(
      DIRECTORY.lastRefusedAddAt,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "SCIM can't add people right now.",
    );
  });

  it("words the strip for a lapse when there is no plan", () => {
    state.plan = null;
    state.providers = [OKTA];
    render(<SsoSection />);

    expect(screen.getByRole("status").textContent).toContain(
      "SSO sign-in is off. This Organization's plan has lapsed. The settings below are kept and work again on Business.",
    );
  });

  it("shows the panel, not the settings, when nothing was set up", () => {
    render(<SsoSection />);

    expect(
      screen.getByText("Single sign-on and SCIM come with the Business plan."),
    ).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("Identity providers")).toBeNull();
  });

  it("shows a member, who may not read the settings, who to ask", () => {
    state.role = "member";
    state.error = new ApiError(
      403,
      "Only owners and admins can manage SSO providers",
    );
    render(<SsoSection />);

    expect(
      screen.getByText("Ask an owner or admin of Northwind Labs to upgrade."),
    ).toBeTruthy();
  });

  it("shows neither strip nor panel to a Business or Enterprise Organization", () => {
    state.licensed = true;
    state.plan = "enterprise";
    state.providers = [OKTA];
    render(<SsoSection />);

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(/Business plan/)).toBeNull();
    expect(off("Edit")).not.toBe("true");
  });
});

const WAITS = "2026-12-01T12:00:00.000Z";
const waitsDay = () =>
  new Date(WAITS).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
  });

/** While a downgrade waits, on Business, the page says when SSO stops. */
describe("SsoSection while a downgrade waits", () => {
  it("says when SSO sign-in stops, with Keep Business for an owner", () => {
    state.licensed = true;
    state.plan = "business";
    state.scheduledAt = WAITS;
    state.providers = [OKTA];
    render(<SsoSection />);

    const strip = screen.getByRole("status");
    expect(strip.textContent).toContain(`SSO sign-in stops on ${waitsDay()}.`);
    fireEvent.click(
      within(strip).getByRole("button", { name: "Keep Business" }),
    );
    expect(keepBusiness).toHaveBeenCalledOnce();
  });

  it("names SCIM too when a directory is connected", () => {
    state.licensed = true;
    state.plan = "business";
    state.scheduledAt = WAITS;
    state.providers = [OKTA];
    state.scim = [DIRECTORY];
    render(<SsoSection />);

    expect(screen.getByRole("status").textContent).toContain(
      `SSO sign-in and SCIM adds stop on ${waitsDay()}.`,
    );
  });

  it("tells a member who can keep Business, with no button", () => {
    state.licensed = true;
    state.plan = "business";
    state.scheduledAt = WAITS;
    state.role = "member";
    state.providers = [OKTA];
    render(<SsoSection />);

    const strip = screen.getByRole("status");
    expect(strip.textContent).toContain(
      "To stay on Business, ask an owner or admin of Northwind Labs.",
    );
    expect(within(strip).queryByRole("button")).toBeNull();
  });

  it("shows no strip when no downgrade waits", () => {
    state.licensed = true;
    state.plan = "business";
    state.providers = [OKTA];
    render(<SsoSection />);

    expect(screen.queryByRole("status")).toBeNull();
  });
});
