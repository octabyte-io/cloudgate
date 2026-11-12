import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const useInstanceMode = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/use-instance-mode", () => ({ useInstanceMode }));
vi.mock("./use-platform", () => ({
  useInstanceVersion: () => ({ data: "1.4.0" }),
  useInstanceReleaseTag: () => ({ data: "v1.4.0" }),
  useUpdateData: () => ({ data: undefined, isFetching: false, error: null }),
}));

const { IdentityCard } = await import("./instance-identity-card");

afterEach(() => {
  cleanup();
  useInstanceMode.mockReset();
});

/** The value beside the "Mode" label. */
function modeRow(): HTMLElement {
  const label = screen.getByText("Mode");
  const row = label.closest("div") ?? label.parentElement;
  if (!row) throw new Error("no Mode row");
  return row as HTMLElement;
}

/**
 * The settings page says which kind of instance this is (ADR-0049), off
 * the `mode` on `GET /settings/about`.
 */
describe("IdentityCard: instance mode", () => {
  it.each([
    ["hosted", "Hosted"],
    ["self-hosted", "Self-hosted"],
  ])("shows %s as %s", (mode, shown) => {
    useInstanceMode.mockReturnValue({ data: mode });
    render(<IdentityCard checked={false} onCheck={() => undefined} />);

    expect(within(modeRow()).getByText(shown)).toBeDefined();
  });

  it("says unknown while the answer has not arrived", () => {
    useInstanceMode.mockReturnValue({ data: undefined });
    render(<IdentityCard checked={false} onCheck={() => undefined} />);

    expect(within(modeRow()).queryByText("Hosted")).toBeNull();
    expect(within(modeRow()).queryByText("Self-hosted")).toBeNull();
  });
});
