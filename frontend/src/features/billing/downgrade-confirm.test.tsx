import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DowngradeImpact } from "@/lib/api/endpoints/billing";

const downgrade = vi.hoisted(() => vi.fn());
const impactState = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

// The impact read and the downgrade write are the boundary; what the confirm
// lists, and that one button moves, is what is tested.
vi.mock("@/lib/api/use-billing", () => ({
  useDowngradeImpact: () => impactState.current,
  useDowngrade: () => ({ mutateAsync: downgrade, isPending: false }),
}));

const { DowngradeConfirm } = await import("./downgrade-confirm");
const { SETTINGS_KEPT } = await import("@/components/console/downgrade-impact");
const { formatDay } = await import("@/lib/api/endpoints/billing");

const MOVES_AT = "2026-11-28T09:00:00.000Z";

const NOTHING: DowngradeImpact = {
  ssoProviders: 0,
  ssoOnlyPeople: 0,
  scimProviders: 0,
  customRoleHolders: [],
  protectedApps: 0,
  downgradeAt: MOVES_AT,
};

function givenImpact(data: Partial<DowngradeImpact> | null, error?: unknown) {
  impactState.current = {
    data: data ? { ...NOTHING, ...data } : undefined,
    error: error ?? null,
    isPending: !data && !error,
  };
}

const list = () => screen.queryByRole("list", { name: "What stops" });

afterEach(() => {
  cleanup();
  downgrade.mockReset();
});

/** What moving to Starter stops, against what the Organization uses. */
describe("DowngradeConfirm", () => {
  it("lists every feature in use, with its counts and names, then the closing line", () => {
    givenImpact({
      ssoProviders: 1,
      ssoOnlyPeople: 3,
      scimProviders: 1,
      customRoleHolders: [
        { name: "Ida Rhodes", role: "deployer" },
        { name: "Edsger Dijkstra", role: "auditor" },
      ],
      protectedApps: 2,
    });
    render(<DowngradeConfirm open onOpenChange={() => {}} />);

    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual([
      "SSO sign-in stops. 3 people sign in only with SSO and will use “Forgot password” to set a password.",
      "SCIM can't add people. Removals from your directory still work.",
      "Custom roles allow nothing. 2 people hold one: Ida Rhodes (deployer), Edsger Dijkstra (auditor).",
      "2 protected apps stay protected, but forward auth can’t be added or changed.",
    ]);
    expect(screen.getByText(SETTINGS_KEPT)).toBeTruthy();
  });

  it("leaves out the features never set up", () => {
    givenImpact({ customRoleHolders: [{ name: "Ida Rhodes", role: "x" }] });
    render(<DowngradeConfirm open onOpenChange={() => {}} />);

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain("1 person holds one: Ida Rhodes");
    expect(list()?.textContent).not.toMatch(/SSO|SCIM|forward auth/);
  });

  it("says nothing else changes for an Organization using none of them", () => {
    givenImpact({});
    render(<DowngradeConfirm open onOpenChange={() => {}} />);

    expect(list()).toBeNull();
    expect(screen.queryByText(SETTINGS_KEPT)).toBeNull();
    expect(screen.getByText(/nothing else changes/)).toBeTruthy();
  });

  it("moves on one red Downgrade on <date> button, with nothing to type", async () => {
    givenImpact({ ssoProviders: 1 });
    downgrade.mockResolvedValue({
      scheduledPlan: "starter",
      scheduledAt: MOVES_AT,
    });
    const onOpenChange = vi.fn();
    render(<DowngradeConfirm open onOpenChange={onOpenChange} />);

    expect(screen.queryByRole("textbox")).toBeNull();
    const button = screen.getByRole("button", {
      name: `Downgrade on ${formatDay(MOVES_AT)}`,
    });
    expect(button.className).toContain("text-bad");
    fireEvent.click(button);

    await vi.waitFor(() => expect(downgrade).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("offers no move until it has read what stops", () => {
    givenImpact(null);
    render(<DowngradeConfirm open onOpenChange={() => {}} />);

    expect(screen.queryByRole("button", { name: /Downgrade/ })).toBeNull();
  });
});
