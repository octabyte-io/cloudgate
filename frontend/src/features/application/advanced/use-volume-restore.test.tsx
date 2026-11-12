import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDestinationObjects } from "@/lib/api/use-destinations";

import { useVolumeRestoreFlow } from "./use-volume-restore";

const mode = vi.hoisted(() => ({ data: "self-hosted" as string | undefined }));

vi.mock("@/lib/api/use-instance-mode", () => ({
  useInstanceMode: () => mode,
}));
vi.mock("@/lib/api/use-destinations", () => ({
  useDestinationObjects: vi.fn(() => ({ data: [] })),
}));

/**
 * **The restore picker's listing runs from the Service's own Server on the
 * Hosted instance**.
 * The API refuses rclone on Cloudgate's own host there; the Server the
 * Service runs on is the one the restore runs on, so it is the one asked.
 * Self-hosted the listing runs on this host as before.
 */
describe("the volume restore's tarball listing", () => {
  const flow = () =>
    renderHook(() =>
      useVolumeRestoreFlow({
        destinations: [],
        suggestedVolume: "data",
        suggestedPrefix: "shop/",
        serverId: "srv-1",
        open: true,
      }),
    );

  beforeEach(() => vi.mocked(useDestinationObjects).mockClear());
  afterEach(cleanup);

  it("lists from the Service's Server on the Hosted instance", () => {
    mode.data = "hosted";
    flow();

    expect(useDestinationObjects).toHaveBeenLastCalledWith(
      expect.objectContaining({ serverId: "srv-1" }),
    );
  });

  it("lists from this host as before off the Hosted instance", () => {
    mode.data = "self-hosted";
    flow();

    expect(useDestinationObjects).toHaveBeenLastCalledWith(
      expect.objectContaining({ serverId: undefined }),
    );
  });
});
