import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";

const useServerContainers = vi.hoisted(() => vi.fn());

vi.mock("./use-server-docker", async (original) => ({
  ...(await original<typeof import("./use-server-docker")>()),
  useServerContainers,
  useContainerConfig: vi.fn(() => ({
    data: undefined,
    error: null,
    isPending: false,
  })),
  useContainerActions: vi.fn(() => ({})),
}));

const { ContainersCard } = await import("./containers-card");

afterEach(() => {
  cleanup();
  useServerContainers.mockReset();
});

/** The refusal the route publishes for a Server the SSH connection never reached. */
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
 * X11-4. The card had four sentences for four answers and the backend could only
 * make three of them, because a Server the SSH connection never reached was
 * swallowed into `[]` — so the empty state fired, and an operator opening an
 * unreachable Server mid-incident read *"Docker answered and there are no containers
 * on this host."* The three assertions here are the three claims that must not be
 * made about a machine nothing was read from.
 */
describe("ContainersCard", () => {
  it("says the Server was not reached rather than that Docker answered", () => {
    useServerContainers.mockReturnValue(query({ error: notReached }));

    render(<ContainersCard serverId="srv-1" serverName="vps-a" />);

    const text = document.body.textContent ?? "";
    expect(text).toContain("Cloudgate could not reach this Server");
    expect(text).not.toContain("Docker answered");
    expect(text).not.toContain("Nothing is running here");
  });

  it("does not blame the Docker daemon for a connection that never landed", () => {
    useServerContainers.mockReturnValue(query({ error: notReached }));

    render(<ContainersCard serverId="srv-1" serverName="vps-a" />);

    const text = document.body.textContent ?? "";
    // The `null` branch's diagnosis — the daemon is not installed or not running
    // — is a reading of an answer, and there was no answer.
    expect(text).not.toContain("Docker on this host did not answer");
    // And not `errorMessage()`'s sentence for a bare 503 either, which names the
    // backend: the backend answered.
    expect(text).not.toContain("The backend is not answering");
  });

  it("still says Docker answered when Docker answered with no containers", () => {
    useServerContainers.mockReturnValue(query({ data: [] }));

    render(<ContainersCard serverId="srv-1" serverName="vps-a" />);

    const text = document.body.textContent ?? "";
    expect(text).toContain("Nothing is running here");
    expect(text).toContain("Docker answered");
  });

  it("says the daemon would not say when the route answers nothing at all", () => {
    useServerContainers.mockReturnValue(query({ data: null }));

    render(<ContainersCard serverId="srv-1" serverName="vps-a" />);

    const text = document.body.textContent ?? "";
    expect(text).toContain("Docker on this host did not answer");
    expect(text).not.toContain("Cloudgate could not reach this Server");
  });
});
