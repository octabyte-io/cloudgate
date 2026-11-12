import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type { UpgradePreview } from "@/lib/api/endpoints/billing";

const upgrade = vi.hoisted(() => vi.fn());
const refetch = vi.hoisted(() => vi.fn());
const previewState = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

// The preview read and the upgrade write are the boundary; what the confirm
// says, and what it sends back, is what is tested.
vi.mock("@/lib/api/use-billing", () => ({
  useUpgradePreview: () => previewState.current,
  useUpgrade: () => ({ mutateAsync: upgrade, isPending: false }),
}));

const { UpgradeConfirm } = await import("./upgrade-confirm");

const PREVIEW: UpgradePreview = {
  today: 1533,
  monthlyAfter: 4500,
  currency: "usd",
  daysLeft: 23,
  renewsAt: 1_795_000_000,
  prorationDate: 1_793_000_000,
};

function givenPreview(data: UpgradePreview | null, error?: unknown) {
  previewState.current = {
    data,
    error: error ?? null,
    isPending: !data && !error,
    isFetching: false,
    refetch,
  };
}

const money = (minor: number) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
  }).format(minor / 100);

afterEach(() => {
  cleanup();
  upgrade.mockReset();
  refetch.mockReset();
});

/** Starter → Business, with the exact amount charged today. */
describe("UpgradeConfirm", () => {
  it("shows today's prorated amount on the button, and the monthly amount after", () => {
    givenPreview(PREVIEW);
    render(<UpgradeConfirm open onOpenChange={() => {}} />);

    const today = screen.getByLabelText("Today").textContent ?? "";
    expect(today).toContain("Today, for the 23 days left of this month");
    expect(today).toContain(money(1533));
    expect(screen.getByLabelText("Every month after").textContent).toContain(
      money(4500),
    );
    expect(
      screen.getByRole("button", { name: `Upgrade and pay ${money(1533)}` }),
    ).toBeTruthy();
  });

  it("upgrades at the preview's proration time and closes", async () => {
    givenPreview(PREVIEW);
    upgrade.mockResolvedValue({ plan: "business" });
    const onOpenChange = vi.fn();
    render(<UpgradeConfirm open onOpenChange={onOpenChange} />);

    fireEvent.click(
      screen.getByRole("button", { name: `Upgrade and pay ${money(1533)}` }),
    );

    await vi.waitFor(() =>
      expect(upgrade).toHaveBeenCalledWith(PREVIEW.prorationDate),
    );
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("reads a new amount when the one shown is out of date, and stays open", async () => {
    givenPreview(PREVIEW);
    upgrade.mockRejectedValue(
      new ApiError(409, "The amount shown is out of date.", {
        code: "UPGRADE_PREVIEW_STALE",
      }),
    );
    const onOpenChange = vi.fn();
    render(<UpgradeConfirm open onOpenChange={onOpenChange} />);

    fireEvent.click(
      screen.getByRole("button", { name: `Upgrade and pay ${money(1533)}` }),
    );

    await vi.waitFor(() => expect(refetch).toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("offers no payment while the amount is unknown", () => {
    givenPreview(null);
    render(<UpgradeConfirm open onOpenChange={() => {}} />);

    expect(
      screen.queryByRole("button", { name: /Upgrade and pay/ }),
    ).toBeNull();
  });
});
