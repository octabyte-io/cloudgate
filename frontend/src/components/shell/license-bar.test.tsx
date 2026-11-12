import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LicenseStatusReport } from "@/lib/api/endpoints/license";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2027-03-01T10:00:00.000Z");
const inDays = (n: number) => new Date(NOW.getTime() + n * DAY).toISOString();

const state = vi.hoisted(() => ({
  mode: "self-hosted" as string | undefined,
  role: "owner" as string | undefined,
  userId: "user-0",
  report: undefined as LicenseStatusReport | undefined,
  statusEnabledWith: [] as boolean[],
  checkNow: vi.fn(),
}));

vi.mock("@/lib/api/use-instance-mode", () => ({
  useInstanceMode: () => ({ data: state.mode }),
}));
vi.mock("@/lib/auth/client", () => ({
  useActiveMemberRole: () => ({
    data: state.role ? { role: state.role } : undefined,
  }),
  useActiveOrganizationId: () => ({ organizationId: "org-1" }),
  useSession: () => ({ data: { user: { id: state.userId } } }),
}));
vi.mock("@/features/enterprise/use-license", () => ({
  useLicenseStatus: ({ enabled }: { enabled: boolean }) => {
    state.statusEnabledWith.push(enabled);
    return { data: enabled ? state.report : undefined };
  },
  useCheckLicenseNow: () => ({
    mutate: state.checkNow,
    isPending: false,
    isSuccess: false,
    error: null,
  }),
}));

const { LicenseBar } = await import("./license-bar");
const { STOPPED_BY_LAPSE } = await import(
  "@/features/enterprise/license/license-expiry"
);

/** A Self-hosted license, opted in and active, ending `days` from now. */
function endingIn(days: number): void {
  state.report = {
    licensed: days > 0,
    status: "active",
    validUntil: inDays(days),
    features: [],
    enableEnterpriseFeatures: true,
  };
}

function barText(): string | null {
  return screen.queryByRole("status")?.textContent ?? null;
}

let viewer = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  // A fresh viewer each test: what one hid stays hidden for that viewer only.
  viewer += 1;
  state.userId = `user-${viewer}`;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  state.mode = "self-hosted";
  state.role = "owner";
  state.report = undefined;
  state.statusEnabledWith = [];
  state.checkNow.mockReset();
  try {
    localStorage.clear();
  } catch {
    // No storage in this environment; nothing to clear.
  }
});

describe("LicenseBar", () => {
  it("shows nothing 15 days out", () => {
    endingIn(15);
    const { container } = render(<LicenseBar />);
    expect(container.innerHTML).toBe("");
  });

  it("appears at 14 days, naming validUntil and the days left", () => {
    endingIn(14);
    const { container } = render(<LicenseBar />);
    expect(barText()).toContain("Your Enterprise license ends on");
    expect(barText()).toContain("(in 14 days)");
    expect(container.querySelector("time")?.getAttribute("datetime")).toBe(
      inDays(14),
    );
    expect(
      screen.getByRole("button", { name: "Hide until 3 days are left" }),
    ).toBeTruthy();
  });

  it("gives an owner the way to renew and the check-now button", () => {
    endingIn(4);
    render(<LicenseBar />);
    expect(barText()).toContain("(in 4 days)");
    expect(barText()).toContain("Renew it with Octabyte");
    fireEvent.click(
      screen.getByRole("button", { name: "I've renewed, check now" }),
    );
    expect(state.checkNow).toHaveBeenCalledTimes(1);
    expect(barText()).not.toContain("Ask an owner");
  });

  it("tells an admin to ask an owner, with no check-now button", () => {
    state.role = "admin";
    endingIn(4);
    render(<LicenseBar />);
    expect(barText()).toContain("Ask an owner to renew it.");
    expect(
      screen.queryByRole("button", { name: "I've renewed, check now" }),
    ).toBeNull();
  });

  it("shows a member nothing, and never asks for the status", () => {
    state.role = "member";
    endingIn(-1);
    const { container } = render(<LicenseBar />);
    expect(container.innerHTML).toBe("");
    expect(state.statusEnabledWith).toEqual([false]);
  });

  it("cannot be hidden at 3 days", () => {
    endingIn(3);
    render(<LicenseBar />);
    expect(barText()).toContain("(in 3 days)");
    expect(screen.queryByRole("button", { name: /^Hide/ })).toBeNull();
  });

  it("once hidden stays hidden for that date, and returns at 3 days", () => {
    endingIn(5);
    const { container, rerender } = render(<LicenseBar />);
    fireEvent.click(
      screen.getByRole("button", { name: "Hide until 3 days are left" }),
    );
    expect(container.innerHTML).toBe("");

    // Two days later, the same validUntil: 3 days left now.
    vi.setSystemTime(new Date(NOW.getTime() + 2 * DAY));
    rerender(<LicenseBar />);
    expect(barText()).toContain("(in 3 days)");
  });

  it("comes back for a new validUntil after one was hidden", () => {
    endingIn(10);
    const { container, rerender } = render(<LicenseBar />);
    fireEvent.click(
      screen.getByRole("button", { name: "Hide until 3 days are left" }),
    );
    expect(container.innerHTML).toBe("");

    endingIn(12);
    rerender(<LicenseBar />);
    expect(barText()).toContain("(in 12 days)");
  });

  it.each([0, -1])(
    "after the date (%i days) lists what stopped, cannot be hidden, and offers renew then check again",
    (days) => {
      endingIn(days);
      render(<LicenseBar />);
      const text = barText() ?? "";
      expect(text).toContain("Your Enterprise license ended on");
      expect(text).toContain("Renew with Octabyte, then check again.");
      expect(text).toContain("What has stopped until it is renewed:");
      for (const stopped of STOPPED_BY_LAPSE) expect(text).toContain(stopped);
      expect(screen.queryByRole("button", { name: /^Hide/ })).toBeNull();
      expect(
        screen.getByRole("button", { name: "I've renewed, check now" }),
      ).toBeTruthy();
    },
  );

  it("tells an admin to ask an owner after the date too", () => {
    state.role = "admin";
    endingIn(-1);
    render(<LicenseBar />);
    expect(barText()).toContain("Ask an owner to renew it.");
    expect(barText()).toContain("What has stopped until it is renewed:");
  });

  it("is gone once the license is valid again", () => {
    endingIn(-1);
    const { container, rerender } = render(<LicenseBar />);
    expect(barText()).not.toBeNull();
    endingIn(365);
    rerender(<LicenseBar />);
    expect(container.innerHTML).toBe("");
  });

  it("is gone once Enterprise features are turned off", () => {
    endingIn(-1);
    state.report = { ...state.report!, enableEnterpriseFeatures: false };
    const { container } = render(<LicenseBar />);
    expect(container.innerHTML).toBe("");
  });

  it("never asks for the status on the Hosted instance", () => {
    state.mode = "hosted";
    endingIn(-1);
    const { container } = render(<LicenseBar />);
    expect(container.innerHTML).toBe("");
    expect(state.statusEnabledWith).toEqual([false]);
  });
});
