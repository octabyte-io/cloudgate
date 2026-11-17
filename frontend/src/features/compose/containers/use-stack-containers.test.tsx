import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { composeApi, type ComposeDetail } from "@/lib/api/endpoints/compose";
import { dockerApi } from "@/lib/api/endpoints/docker";

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId: () => ({ organizationId: "org-1", pending: false }),
}));

const { useStackContainers } = await import("./use-stack-containers");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(composeApi, "loadServices").mockResolvedValue(["web", "worker"]);
  vi.spyOn(dockerApi, "containers").mockResolvedValue([]);
  vi.spyOn(dockerApi, "containersByApp").mockResolvedValue([]);
});

function stack(composeStatus: ComposeDetail["composeStatus"]) {
  return {
    composeId: "cmp-1",
    serverId: null,
    appName: "invoices-a1b2c3",
    composeType: "docker-compose",
    composeStatus,
  } as ComposeDetail;
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/**
 * After Remove containers the tab listed both declared services with every
 * state cell blank, which read as the stack it was before. A stack taken down
 * on purpose with nothing left on its deploy target has no rows, so the tab's
 * empty state says it is stopped and that Start brings it back.
 */
describe("useStackContainers", () => {
  it("has no rows for a stopped stack with no container left, so the empty state shows", async () => {
    const { result } = renderHook(() => useStackContainers(stack("stopped")), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isPending).toBe(false));
    await waitFor(() => expect(composeApi.loadServices).toHaveBeenCalled());
    // Let the declared services land, which is what used to fill the table.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.rows).toEqual([]);
  });

  it("keeps a row per declared service for a stack meant to be up, so the missing one is named", async () => {
    const { result } = renderHook(() => useStackContainers(stack("done")), {
      wrapper,
    });

    await waitFor(() =>
      expect(result.current.rows.map((row) => row.service)).toEqual([
        "web",
        "worker",
      ]),
    );
  });
});
