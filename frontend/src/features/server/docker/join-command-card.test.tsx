import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type { Server } from "@/lib/api/endpoints/servers";

/**
 * The join-command buttons are offered only once there is a Swarm to
 * join. On an unreachable or never-set-up Server both were live, pressing one
 * failed, and the pressed one turned primary as though it had worked.
 */
const useServerAudit = vi.hoisted(() => vi.fn());
const mutate = vi.hoisted(() => vi.fn());

vi.mock("../use-server", async (original) => ({
  ...(await original<typeof import("../use-server")>()),
  useServerAudit,
}));
vi.mock("./use-server-docker", async (original) => ({
  ...(await original<typeof import("./use-server-docker")>()),
  useJoinCommand: () => ({
    mutate,
    isPending: false,
    isError: false,
    isSuccess: false,
  }),
}));

const { JoinCommandCard } = await import("./join-command-card");

const server = {
  serverId: "srv-1",
  name: "vps-a",
  sshKeyId: "key-1",
} as unknown as Server;

const buttons = () => [
  screen.getByRole("button", { name: /worker command/ }),
  screen.getByRole("button", { name: /manager command/ }),
];
const off = (button: HTMLElement) =>
  button.hasAttribute("disabled") ||
  button.getAttribute("aria-disabled") === "true";

afterEach(() => {
  cleanup();
  useServerAudit.mockReset();
});

describe("JoinCommandCard", () => {
  it("keeps both off, and says why, when the Server was not reached", () => {
    useServerAudit.mockReturnValue({
      data: undefined,
      isPending: false,
      error: new ApiError(503, "This Server could not be reached", {
        code: "HOST_UNREACHABLE",
      }),
    });
    render(<JoinCommandCard server={server} />);

    expect(buttons().every(off)).toBe(true);
    expect(document.body.textContent).toContain("could not reach this Server");
  });

  it("keeps both off on a Server with no Swarm yet, pointing at setup", () => {
    useServerAudit.mockReturnValue({
      data: { isSwarmActive: false },
      isPending: false,
      error: null,
    });
    render(<JoinCommandCard server={server} />);

    expect(buttons().every(off)).toBe(true);
    expect(document.body.textContent).toContain("no Swarm yet");
  });

  it("offers both once the Swarm is active", () => {
    useServerAudit.mockReturnValue({
      data: { isSwarmActive: true },
      isPending: false,
      error: null,
    });
    render(<JoinCommandCard server={server} />);

    expect(buttons().some(off)).toBe(false);
    expect(document.body.textContent).not.toContain("no Swarm yet");
  });
});
