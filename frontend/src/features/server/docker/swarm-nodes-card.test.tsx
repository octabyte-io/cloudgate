import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";

const useSwarmNodes = vi.hoisted(() => vi.fn());

vi.mock("./use-server-docker", async (original) => ({
  ...(await original<typeof import("./use-server-docker")>()),
  useSwarmNodes,
  useRemoveNode: vi.fn(() => ({ isPending: false, mutateAsync: vi.fn() })),
}));

const { SwarmNodesCard } = await import("./swarm-nodes-card");

afterEach(() => {
  cleanup();
  useSwarmNodes.mockReset();
});

const notReached = new ApiError(503, "This Server could not be reached", {
  code: "HOST_UNREACHABLE",
});

function query(overrides: Record<string, unknown>) {
  return {
    data: undefined,
    error: null,
    isPending: false,
    isFetching: false,
    refetch: vi.fn(),
    ...overrides,
  };
}

/**
 * X11-4, in the card with the most convincing wrong answer. `docker node ls` is
 * manager-only, so this card's `null` branch is written to reassure a worker's
 * operator that *"the cluster is fine and this machine is not the one that can
 * describe it"* — and an unreachable Server arrived as the same `null`, so that is
 * what it was told about a machine nothing had spoken to.
 */
describe("SwarmNodesCard", () => {
  it("says the Server was not reached rather than that it is a worker", () => {
    useSwarmNodes.mockReturnValue(query({ error: notReached }));

    render(<SwarmNodesCard serverId="srv-1" serverName="vps-a" />);

    const text = document.body.textContent ?? "";
    expect(text).toContain("Cloudgate could not reach this Server");
    expect(text).not.toContain("only works on a manager");
    expect(text).not.toContain("the cluster is fine");
    expect(text).not.toContain("No nodes reported");
    // The dropped-space trap, in the sentence about a command that never ran: a
    // text node that wraps across lines *and* carries an entity loses the space
    // it does contain, so this read "lsnever ran" until the `{" "}` went in.
    expect(text).toContain("docker node ls never ran");
  });

  it("keeps the worker's own sentence for a host that answered on stderr", () => {
    useSwarmNodes.mockReturnValue(query({ data: null }));

    render(<SwarmNodesCard serverId="srv-1" serverName="vps-a" />);

    const text = document.body.textContent ?? "";
    expect(text).toContain("only works on a manager");
    expect(text).not.toContain("Cloudgate could not reach this Server");
  });
});
