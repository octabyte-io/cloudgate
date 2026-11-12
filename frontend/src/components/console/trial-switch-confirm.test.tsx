import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DowngradeImpact } from "@/lib/api/endpoints/billing";

const trialSwitch = vi.hoisted(() => vi.fn());
const impactState = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
  enabledWith: [] as boolean[],
}));

// The impact read and the switch are the boundary; what the confirm says
// before a free move to Starter is what is tested.
vi.mock("@/lib/api/use-billing", () => ({
  useDowngradeImpact: (enabled: boolean) => {
    impactState.enabledWith.push(enabled);
    return impactState.current;
  },
  useTrialSwitch: () => ({ mutateAsync: trialSwitch, isPending: false }),
}));

const { TrialSwitchConfirm } = await import("./trial-switch-confirm");
const { SETTINGS_KEPT } = await import("./downgrade-impact");

const ENDS = "2026-12-05T12:00:00.000Z";

const IMPACT: DowngradeImpact = {
  ssoProviders: 1,
  ssoOnlyPeople: 2,
  scimProviders: 0,
  customRoleHolders: [{ name: "Ada Lovelace", role: "auditor" }],
  protectedApps: 0,
  downgradeAt: ENDS,
};

function givenImpact(data: DowngradeImpact | null) {
  impactState.current = {
    data: data ?? undefined,
    error: null,
    isPending: !data,
  };
}

afterEach(() => {
  cleanup();
  trialSwitch.mockReset();
  impactState.enabledWith = [];
});

function confirm(to: "starter" | "business") {
  render(
    <TrialSwitchConfirm to={to} endsAt={ENDS} open onOpenChange={() => {}} />,
  );
}

describe("TrialSwitchConfirm", () => {
  it("to Starter, lists what stops now against what the Organization uses, then switches for free", async () => {
    givenImpact(IMPACT);
    trialSwitch.mockResolvedValue({ plan: "starter" });
    confirm("starter");

    expect(screen.getByText("From now, on Starter:")).toBeTruthy();
    const items = screen
      .getByRole("list", { name: "What stops" })
      .querySelectorAll("li");
    expect([...items].map((item) => item.textContent)).toEqual([
      "SSO sign-in stops. 2 people sign in only with SSO and will use “Forgot password” to set a password.",
      "Custom roles allow nothing. 1 person holds one: Ada Lovelace (auditor).",
    ]);
    expect(screen.getByText(SETTINGS_KEPT)).toBeTruthy();
    expect(screen.getByLabelText("Today").textContent).toContain(
      "0 USD, still free",
    );

    fireEvent.click(screen.getByRole("button", { name: "Switch to Starter" }));
    await vi.waitFor(() => expect(trialSwitch).toHaveBeenCalledWith("starter"));
  });

  it("to Starter, offers no switch until what stops has been read", () => {
    givenImpact(null);
    confirm("starter");

    expect(
      screen.getByText("Reading what this Organization uses…"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Switch to Starter" }),
    ).toBeNull();
  });

  it("to Business, lists nothing and asks for no impact", () => {
    givenImpact(IMPACT);
    confirm("business");

    expect(screen.queryByRole("list", { name: "What stops" })).toBeNull();
    expect(impactState.enabledWith).toEqual([]);
    expect(
      screen.getByRole("button", { name: "Switch to Business" }),
    ).toBeTruthy();
  });
});
