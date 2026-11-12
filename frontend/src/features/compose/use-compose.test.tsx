import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { composeApi, type ComposeDetail } from "@/lib/api/endpoints/compose";
import { deploymentsApi, type Deployment } from "@/lib/api/endpoints/deployments";
import { keys } from "@/lib/api/keys";

const useActiveOrganizationId = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));

const { useCompose } = await import("./use-compose");

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

const deployment = (status: Deployment["status"]) =>
  ({
    deploymentId: "dep-1",
    status,
    createdAt: "2026-09-18T13:06:37.000Z",
  }) as Deployment;

const row = (composeStatus: ComposeDetail["composeStatus"]) =>
  ({ composeId: "cmp-1", composeStatus }) as ComposeDetail;

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = renderHook(() => useCompose("cmp-1"), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { client, ...view };
}

const listMoved = (client: QueryClient) =>
  act(() =>
    client.invalidateQueries({
      queryKey: keys.deployments.byCompose("org-1", "cmp-1"),
    }),
  );

/**
 * A stack's first Deploy left the Overview on `idle`
 * (U-117). The row
 * was polled only while it already said `running`, and Deploy's refresh read it
 * while it still said `idle` — so nothing ever read the `done` the engine wrote
 * at the end. What decides now is the newest Deployment, which the list knows.
 */
describe("useCompose — while a Deployment of the stack is live", () => {
  it("refetches the row once after the newest Deployment moves from running to done", async () => {
    let build: Deployment["status"] = "running";
    vi.spyOn(deploymentsApi, "listByCompose").mockImplementation(() =>
      Promise.resolve([deployment(build)]),
    );
    const findOne = vi
      .spyOn(composeApi, "findOne")
      .mockResolvedValue(row("idle"));

    const { client, result } = mount();
    await waitFor(() => expect(result.current.data).toBeDefined());
    const before = findOne.mock.calls.length;

    build = "done";
    findOne.mockResolvedValue(row("done"));
    await listMoved(client);

    await waitFor(() => expect(result.current.data?.composeStatus).toBe("done"));
    expect(findOne.mock.calls.length - before).toBe(1);
  });

  it("does not refetch the row when no Deployment was ever live", async () => {
    vi.spyOn(deploymentsApi, "listByCompose").mockResolvedValue([
      deployment("done"),
    ]);
    const findOne = vi
      .spyOn(composeApi, "findOne")
      .mockResolvedValue(row("done"));

    const { client, result } = mount();
    await waitFor(() => expect(result.current.data).toBeDefined());
    await listMoved(client);

    expect(findOne).toHaveBeenCalledTimes(1);
  });
});
