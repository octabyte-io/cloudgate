import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const useInstanceMode = vi.hoisted(() => vi.fn());
const useUpdateData = vi.hoisted(() =>
  vi.fn(() => ({ data: undefined, isFetching: false, error: null })),
);

vi.mock("@/lib/api/use-instance-mode", () => ({ useInstanceMode }));
vi.mock("./use-platform", () => ({
  useInstanceVersion: () => ({ data: "1.4.0" }),
  useInstanceReleaseTag: () => ({ data: "v1.4.0" }),
  useUpdateData,
}));

const { IdentityCard } = await import("./instance-identity-card");

afterEach(() => {
  cleanup();
  useInstanceMode.mockReset();
  useUpdateData.mockClear();
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

/**
 * The update notice compares the running version with the latest Cloudgate
 * version on GitHub Releases, and a newer one comes with the command that
 * installs it (ADR-0082).
 */
describe("IdentityCard: the update notice", () => {
  const UPGRADE =
    "curl -fsSL https://raw.githubusercontent.com/octabyte-io/cloudgate/main/install.sh | sudo CLOUDGATE_VERSION=v0.4.0 sh";

  function answer(data: {
    latestVersion: string | null;
    updateAvailable: boolean;
    upgradeCommand: string | null;
    error: string | null;
  }) {
    useInstanceMode.mockReturnValue({ data: "self-hosted" });
    useUpdateData.mockReturnValue({
      data,
      isFetching: false,
      error: null,
    } as never);
    render(<IdentityCard checked onCheck={() => undefined} />);
  }

  it("shows the command that upgrades to a newer Cloudgate version", () => {
    answer({
      latestVersion: "v0.4.0",
      updateAvailable: true,
      upgradeCommand: UPGRADE,
      error: null,
    });

    expect(screen.getByText("v0.4.0")).toBeDefined();
    expect(
      screen.getByLabelText("Command that upgrades to v0.4.0").textContent,
    ).toBe(UPGRADE);
    expect(
      screen.getByRole("button", { name: /upgrade command/i }),
    ).toBeDefined();
  });

  it("shows no upgrade command when this instance runs the latest version", () => {
    answer({
      latestVersion: "v1.4.0",
      updateAvailable: false,
      upgradeCommand: null,
      error: null,
    });

    expect(screen.getByText(/this instance is up to date/)).toBeDefined();
    expect(screen.queryByText(/CLOUDGATE_VERSION/)).toBeNull();
  });

  it("reports a check that did not complete rather than up to date", () => {
    answer({
      latestVersion: null,
      updateAvailable: false,
      upgradeCommand: null,
      error: "GitHub answered 403 when asked for Cloudgate's releases.",
    });

    expect(screen.getByText("The check did not complete")).toBeDefined();
    expect(screen.queryByText(/up to date/)).toBeNull();
  });
});
