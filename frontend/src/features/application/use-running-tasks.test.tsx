import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import { dockerApi, type SwarmTask } from "@/lib/api/endpoints/docker";

const useActiveOrganizationId = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));

const { useRunningTasks } = await import("./use-application");

beforeEach(() => {
  useActiveOrganizationId.mockReturnValue({
    organizationId: "org-1",
    pending: false,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const APPLICATION = { appName: "app-t64tnx", serverId: null };

function task(state: string, currentState: string): SwarmTask {
  return {
    containerId: `task-${state}-${currentState}`,
    name: "app-t64tnx.1",
    state,
    node: "manager-1",
    currentState,
    error: "",
  };
}

function mount(enabled = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderHook(() => useRunningTasks(APPLICATION, enabled), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

/**
 * The count the Overview's failure banner reads
 * the U-run's
 * rollback left one task Swarm *wanted* running and could not place —
 * `Pending`, "no suitable node" — and that one must not count as serving.
 */
describe("useRunningTasks", () => {
  it("counts a task only when Swarm wants it running and it is", async () => {
    const read = vi.spyOn(dockerApi, "serviceTasks").mockResolvedValue([
      task("running", "Pending 2 minutes ago"),
      task("shutdown", "Failed 3 minutes ago"),
      task("running", "Running 9 minutes ago"),
    ]);

    const { result } = mount();

    await waitFor(() => expect(result.current).toBe(1));
    expect(read).toHaveBeenCalledWith({ appName: "app-t64tnx", serverId: null });
  });

  it("is 0 for a rollback onto a spec no node can run", async () => {
    vi.spyOn(dockerApi, "serviceTasks").mockResolvedValue([
      task("running", "Pending 4 minutes ago"),
      task("shutdown", "Shutdown 4 minutes ago"),
    ]);

    const { result } = mount();

    await waitFor(() => expect(result.current).toBe(0));
  });

  it("is null, not 0, when the read is refused", async () => {
    const read = vi
      .spyOn(dockerApi, "serviceTasks")
      .mockRejectedValue(new ApiError(403, "Forbidden", { path: "/docker" }));

    const { result } = mount();

    await waitFor(() => expect(read).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current).toBeNull();
  });

  it("is null, not 0, when the listing comes back empty", async () => {
    // `getTaskList` answers `[]` for any stderr — "This node is not a swarm
    // manager", "no such service" — so an empty listing is a read that may
    // have failed. A service Swarm cannot place still lists its Pending task.
    const read = vi.spyOn(dockerApi, "serviceTasks").mockResolvedValue([]);

    const { result } = mount();

    await waitFor(() => expect(read).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current).toBeNull();
  });

  it("does not ask while the caller has nothing to ask it for", () => {
    const read = vi.spyOn(dockerApi, "serviceTasks");

    const { result } = mount(false);

    expect(result.current).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});
