import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const useUpdateData = vi.hoisted(() => vi.fn());

vi.mock("./use-platform", () => ({
  useInstanceGate: () => ({ allowed: true }),
  useUpdateData,
}));

const { InstanceDangerZone } = await import("./instance-danger-zone");

afterEach(() => {
  cleanup();
  useUpdateData.mockReset();
});

/** The check's answer: a newer Cloudgate version is out. */
function newerVersion(data: {
  canUpdateInPlace: boolean;
  upgradeCommand: string | null;
}) {
  useUpdateData.mockReturnValue({
    data: {
      latestVersion: "v0.4.0",
      updateAvailable: true,
      error: null,
      ...data,
    },
    isFetching: false,
    error: null,
  });
  render(<InstanceDangerZone checked />);
}

function updateButton(): HTMLElement {
  return screen.getByRole("button", { name: "Update and restart" });
}

/**
 * "Update this instance" moves the `cloudgate` Docker service, so a native
 * install, which runs two systemd units, has nothing for it to move (spec #39
 * leaves it out of scope). There it stays off and says how that instance
 * upgrades instead, however new the published version is.
 */
describe("InstanceDangerZone: Update this instance", () => {
  it("stays unavailable on an instance that is not a Docker service, pointing at the upgrade command", () => {
    newerVersion({
      canUpdateInPlace: false,
      upgradeCommand: "curl … | sudo CLOUDGATE_VERSION=v0.4.0 sh",
    });

    expect(updateButton().getAttribute("aria-disabled")).toBe("true");
    expect(updateButton().getAttribute("title")).toMatch(
      /not a Docker service.*upgrade command on the card above/,
    );
  });

  it("stays unavailable on the Hosted instance, saying it upgrades itself", () => {
    newerVersion({ canUpdateInPlace: false, upgradeCommand: null });

    expect(updateButton().getAttribute("aria-disabled")).toBe("true");
    expect(updateButton().getAttribute("title")).toMatch(/upgrades itself/);
  });

  it("is available on the cloudgate Docker service when a newer version is out", () => {
    newerVersion({ canUpdateInPlace: true, upgradeCommand: null });

    expect(updateButton().getAttribute("aria-disabled")).not.toBe("true");
    expect(screen.getByText(/Cloudgate version v0\.4\.0/)).toBeDefined();
  });

  it("never calls a Cloudgate version an image", () => {
    newerVersion({ canUpdateInPlace: true, upgradeCommand: null });

    expect(screen.queryByText(/\bimage\b/i)).toBeNull();
  });
});
