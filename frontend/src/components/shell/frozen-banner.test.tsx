import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Standing } from "@/lib/api/endpoints/billing";

const mode = vi.hoisted(() => ({ data: "hosted" as string | undefined }));
const standing = vi.hoisted(() => ({
  data: undefined as Standing | undefined,
  enabledWith: [] as boolean[],
}));

vi.mock("@/lib/api/use-instance-mode", () => ({
  useInstanceMode: () => mode,
}));
vi.mock("@/lib/api/use-standing", () => ({
  useStanding: ({ enabled }: { enabled: boolean }) => {
    standing.enabledWith.push(enabled);
    return { data: standing.data };
  },
}));

const { FrozenBanner } = await import("./frozen-banner");

function given(overrides: Partial<Standing> = {}): void {
  standing.data = {
    frozen: false,
    causes: [],
    paymentFailed: false,
    lapsedAt: null,
    suspendedReason: null,
    payingOrganization: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  mode.data = "hosted";
  standing.data = undefined;
  standing.enabledWith = [];
});

describe("FrozenBanner", () => {
  it("shows nothing for a paid Organization", () => {
    given();
    const { container } = render(<FrozenBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("shows nothing for an Organization in its free trial", () => {
    // A trialing subscription grants the plan and has no failed payment, so
    // its standing is the paid one: the trial is said on the Billing page
    // only, never in a console-wide strip.
    given({ frozen: false, causes: [], paymentFailed: false });
    const { container } = render(<FrozenBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("shows from the first failed payment, saying nothing has stopped", () => {
    given({ paymentFailed: true });
    render(<FrozenBanner />);
    expect(screen.getByRole("status").textContent).toContain(
      "A payment failed.",
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Nothing has stopped",
    );
    expect(screen.queryByText(/Pay to continue/)).toBeNull();
  });

  it("names the lapse with Pay to continue and the way to a plan", () => {
    given({
      frozen: true,
      causes: ["lapsed"],
      lapsedAt: "2026-11-01T00:00:00.000Z",
    });
    render(<FrozenBanner />);
    expect(
      screen.getByText(/This Organization's plan has ended. Pay to continue./),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Choose a plan" }).getAttribute("href"),
    ).toBe("/settings/billing");
    expect(screen.queryByText(/A payment failed/)).toBeNull();
  });

  it("names both causes, the suspension with its reason first", () => {
    given({
      frozen: true,
      causes: ["suspended", "lapsed"],
      suspendedReason: "Sending spam",
    });
    render(<FrozenBanner />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("Suspended. Contact Octabyte.");
    expect(text).toContain("Reason: Sending spam.");
    expect(text).toContain("Pay to continue.");
    expect(text.indexOf("Suspended")).toBeLessThan(
      text.indexOf("Pay to continue"),
    );
  });

  it("disappears once the Organization is paid again", () => {
    given({ frozen: true, causes: ["lapsed"] });
    const { container, rerender } = render(<FrozenBanner />);
    expect(screen.getByRole("status")).toBeTruthy();
    given();
    rerender(<FrozenBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("never asks for the standing on a Self-hosted instance", () => {
    mode.data = "self-hosted";
    given({ frozen: true, causes: ["lapsed"] });
    const { container } = render(<FrozenBanner />);
    expect(container.innerHTML).toBe("");
    expect(standing.enabledWith).toEqual([false]);
  });
});
