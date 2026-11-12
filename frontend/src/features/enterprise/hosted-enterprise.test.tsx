import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AllowanceSource } from "@/lib/api/endpoints/billing";

const mode = vi.hoisted(() => ({
  current: { data: "hosted" as "hosted" | "self-hosted", isPending: false },
}));
const useLicenseStatus = vi.hoisted(() => vi.fn());
const useEnterpriseSettings = vi.hoisted(() => vi.fn());
const facts = vi.hoisted(() => ({
  plan: "starter" as AllowanceSource | null | undefined,
  role: "owner" as string | undefined,
  trialOpen: false,
  /** Stripe's status, and the trial's end while in one, as Billing reads them. */
  status: "active" as string | null,
  trialEndsAt: null as string | null,
  planEnabledWith: [] as boolean[],
  trialEnabledWith: [] as boolean[],
}));

vi.mock("@/lib/api/use-instance-mode", () => ({
  useInstanceMode: () => mode.current,
}));
vi.mock("@/features/enterprise/use-license", () => ({
  useLicenseStatus,
  useEnterpriseSettings,
  useSetEnterpriseFeatures: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));
vi.mock("@/lib/auth/client", () => ({
  useActiveOrganizationId: () => ({ organizationId: "org-1", pending: false }),
}));
vi.mock("@/lib/api/use-organizations", () => ({
  useOrganizations: () => ({
    data: facts.role
      ? [{ id: "org-1", name: "Northwind Labs", member: { role: facts.role } }]
      : undefined,
  }),
}));
vi.mock("@/lib/api/use-billing", () => ({
  usePlan: ({ enabled }: { enabled: boolean }) => {
    facts.planEnabledWith.push(enabled);
    return {
      data:
        enabled && facts.plan !== undefined ? { plan: facts.plan } : undefined,
    };
  },
  useTrialOpen: ({ enabled }: { enabled: boolean }) => {
    facts.trialEnabledWith.push(enabled);
    return enabled && facts.trialOpen;
  },
  useSubscription: ({ enabled }: { enabled: boolean }) => ({
    data: enabled
      ? {
          status: facts.status,
          trialEndsAt: facts.trialEndsAt,
          trial: facts.trialEndsAt ? { endsAt: facts.trialEndsAt } : null,
        }
      : undefined,
    error: null,
  }),
}));
// The confirm itself is tested in its own file; here, only that it opens.
vi.mock("@/components/console/upgrade-confirm", () => ({
  UpgradeConfirm: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="Upgrade to Business?" /> : null,
}));
// The trial's free switch is tested in its own file; here, which one opens.
vi.mock("@/components/console/trial-switch-confirm", () => ({
  TrialSwitchConfirm: ({
    open,
    to,
    endsAt,
  }: {
    open: boolean;
    to: string;
    endsAt: string;
  }) =>
    open ? (
      <div role="dialog" aria-label={`Switch to ${to}?`} data-ends={endsAt} />
    ) : null,
}));

const { LicenseGate } = await import("./license-gate");
const { LicenseSection } = await import("./license/license-section");

afterEach(() => {
  cleanup();
  useLicenseStatus.mockReset();
  useEnterpriseSettings.mockReset();
  mode.current = { data: "hosted", isPending: false };
  facts.plan = "starter";
  facts.role = "owner";
  facts.trialOpen = false;
  facts.status = "active";
  facts.trialEndsAt = null;
  facts.planEnabledWith = [];
  facts.trialEnabledWith = [];
});

function given(licensed: boolean, instanceMode: "hosted" | "self-hosted") {
  mode.current = { data: instanceMode, isPending: false };
  useLicenseStatus.mockReturnValue({
    data: { licensed, status: "inactive", validUntil: null, features: [] },
    isPending: false,
    error: null,
  });
  useEnterpriseSettings.mockReturnValue({
    data: undefined,
    isPending: true,
    error: null,
  });
}

function gate(feature: "sso" | "branding") {
  render(
    <LicenseGate feature={feature} title="Gated" content={<p>the feature</p>}>
      What it does.
    </LicenseGate>,
  );
}

/**
 * The paid features below Business on the Hosted instance (ADR-0054):
 * a feature never set up says it comes with Business, with the one action
 * that changes the answer for this reader, where it said "Contact us" when
 * only Enterprise had them. No license key, ever; Octabyte's
 * install-wide features are simply open; Business and Enterprise see the
 * feature; a Self-hosted instance still points at its License screen.
 */
describe('the "comes with Business" panel', () => {
  it("offers an owner on Starter the upgrade, opening the confirm on the page", () => {
    given(false, "hosted");
    gate("sso");

    expect(screen.queryByText("the feature")).toBeNull();
    expect(
      screen.getByText("Single sign-on comes with the Business plan."),
    ).toBeTruthy();
    expect(screen.getByText(/This Organization is on Starter\./)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Upgrade to Business" }),
    );

    expect(
      screen.getByRole("dialog", { name: "Upgrade to Business?" }),
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/licen[cs]e|Contact us/i);
  });

  it("during a free trial, opens the free switch to Business, not the paid upgrade", () => {
    given(false, "hosted");
    facts.status = "trialing";
    facts.trialEndsAt = "2026-12-05T12:00:00.000Z";
    gate("sso");

    fireEvent.click(
      screen.getByRole("button", { name: "Upgrade to Business" }),
    );

    const dialog = screen.getByRole("dialog", { name: "Switch to business?" });
    expect(dialog.getAttribute("data-ends")).toBe("2026-12-05T12:00:00.000Z");
    expect(
      screen.queryByRole("dialog", { name: "Upgrade to Business?" }),
    ).toBeNull();
  });

  it("with a payment failing on Starter, sends an owner to Billing rather than a confirm that can only refuse", () => {
    given(false, "hosted");
    facts.status = "past_due";
    gate("sso");

    expect(
      screen.getByText(
        "A payment is failing. Settle it on the Billing page, then upgrade.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Go to Billing" }).getAttribute("href"),
    ).toBe("/settings/billing");
    expect(
      screen.queryByRole("button", { name: "Upgrade to Business" }),
    ).toBeNull();
  });

  it("offers an admin the same upgrade", () => {
    given(false, "hosted");
    facts.role = "admin";
    gate("sso");

    expect(
      screen.getByRole("button", { name: "Upgrade to Business" }),
    ).toBeTruthy();
  });

  it("sends an owner with no plan to Billing with Business picked, to subscribe", () => {
    given(false, "hosted");
    facts.plan = null;
    gate("sso");

    expect(
      screen.getByText(/This Organization has no plan yet\./),
    ).toBeTruthy();
    const link = screen.getByRole("link", { name: "Subscribe" });
    expect(link.getAttribute("href")).toBe("/settings/billing?plan=business");
    expect(
      screen.queryByRole("button", { name: "Upgrade to Business" }),
    ).toBeNull();
  });

  it("offers the free trial when Checkout would start one", () => {
    given(false, "hosted");
    facts.plan = null;
    facts.trialOpen = true;
    gate("sso");

    expect(
      screen
        .getByRole("link", { name: "Start 30-day free trial" })
        .getAttribute("href"),
    ).toBe("/settings/billing?plan=business");
  });

  it("tells a member who can upgrade, with no button", () => {
    given(false, "hosted");
    facts.role = "member";
    gate("sso");

    expect(
      screen.getByText("Ask an owner or admin of Northwind Labs to upgrade."),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    // The trial's answer is the subscription, an owner's or admin's read.
    expect(facts.trialEnabledWith).not.toContain(true);
  });

  it("tells a member of an Organization with no plan to ask for the upgrade", () => {
    given(false, "hosted");
    facts.role = "member";
    facts.plan = null;
    gate("sso");

    expect(
      screen.getByText("Ask an owner or admin of Northwind Labs to upgrade."),
    ).toBeTruthy();
  });

  it("opens a paid feature to a Business or Enterprise Organization, with no panel", () => {
    given(true, "hosted");
    facts.plan = "enterprise";
    gate("sso");

    expect(screen.getByText("the feature")).toBeTruthy();
    expect(screen.queryByText(/comes with the Business plan/)).toBeNull();
  });

  it("opens the install-wide features with no license or plan", () => {
    given(false, "hosted");
    gate("branding");

    expect(screen.getByText("the feature")).toBeTruthy();
  });

  it("shows no license-key UI on the License screen, and does not ask for the key", () => {
    given(false, "hosted");
    render(<LicenseSection />);

    expect(screen.getByText("Enterprise")).toBeTruthy();
    expect(
      screen.getByText(
        "Custom roles, single sign-on, SCIM and forward auth come with the Business plan.",
      ),
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/licen[cs]e/i);
    expect(useEnterpriseSettings).toHaveBeenCalledWith({ enabled: false });
  });

  it("names the address to ask about an Enterprise agreement", () => {
    given(false, "hosted");
    render(<LicenseSection />);

    expect(
      screen
        .getByRole("link", { name: "support@octabyte.io" })
        .getAttribute("href"),
    ).toBe("mailto:support@octabyte.io");
  });

  it("tells an Enterprise Organization what it has", () => {
    given(true, "hosted");
    render(<LicenseSection />);

    expect(screen.getByText(/This Organization is Enterprise/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/licen[cs]e/i);
    // Nothing to ask for: it already is.
    expect(
      screen.queryByRole("link", { name: "support@octabyte.io" }),
    ).toBeNull();
  });
});

describe("the Self-hosted counterpart", () => {
  it("still points a locked feature at the License screen, and asks for no plan", () => {
    given(false, "self-hosted");
    gate("branding");

    expect(screen.queryByText("the feature")).toBeNull();
    expect(
      screen.getByRole("link", { name: "Go to License" }).getAttribute("href"),
    ).toBe("/settings/license");
    expect(screen.queryByText(/Business plan/)).toBeNull();
    expect(facts.planEnabledWith.every((enabled) => !enabled)).toBe(true);
  });
});
