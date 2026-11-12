import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applicationsApi,
  type ApplicationDetail,
} from "@/lib/api/endpoints/applications";
import { deploymentsApi, type Deployment } from "@/lib/api/endpoints/deployments";
import { keys } from "@/lib/api/keys";
import { newestLive } from "@/lib/format/deployment-facts";



const useActiveOrganizationId = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));

const { useApplication, useApplicationDeployments } = await import(
  "./use-application"
);

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
    createdAt: "2026-09-18T18:37:00.000Z",
  }) as Deployment;

const row = (applicationStatus: ApplicationDetail["applicationStatus"]) =>
  ({ applicationId: "app-1", applicationStatus }) as ApplicationDetail;

/**
 * The pair the Overview holds, wired the way it wires them: the Deployments
 * list decides whether the row is live.
 */
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = renderHook(
    () => {
      const deployments = useApplicationDeployments("app-1");
      const live = newestLive(deployments.data ?? []);
      return useApplication("app-1", { live: live !== null });
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  return { client, ...view };
}

/**
 * The Application row is read once more when the build ends
 * The engine
 * writes `applicationStatus` at the end of a build, and the list's poll that
 * saw `done` was also the one that switched the row's poll off — so the pill,
 * the Status row and the failure banner kept the status from before the build
 * until a reload.
 */
describe("useApplication — when the Deployment it was live for ends", () => {
  it.each(["done", "error"] as const)(
    "refetches the row once after the newest Deployment moves from running to %s",
    async (ended) => {
      let build: Deployment["status"] = "running";
      vi.spyOn(deploymentsApi, "listByApplication").mockImplementation(() =>
        Promise.resolve([deployment(build)]),
      );
      const findOne = vi
        .spyOn(applicationsApi, "findOne")
        .mockResolvedValue(row("idle"));

      const { client, result } = mount();
      await waitFor(() => expect(result.current.data).toBeDefined());
      const before = findOne.mock.calls.length;

      // The engine writes both columns at the end: the Deployment's, then the
      // Application's. The list's next read is what the page notices.
      build = ended;
      findOne.mockResolvedValue(row(ended));
      await act(() =>
        client.invalidateQueries({
          queryKey: keys.deployments.byApplication("org-1", "app-1"),
        }),
      );

      await waitFor(() =>
        expect(result.current.data?.applicationStatus).toBe(ended),
      );
      expect(findOne.mock.calls.length - before).toBe(1);
    },
  );

  it("does not refetch the row for a list that was never live", async () => {
    vi.spyOn(deploymentsApi, "listByApplication").mockResolvedValue([
      deployment("done"),
    ]);
    const findOne = vi
      .spyOn(applicationsApi, "findOne")
      .mockResolvedValue(row("done"));

    const { client, result } = mount();
    await waitFor(() => expect(result.current.data).toBeDefined());

    await act(() =>
      client.invalidateQueries({
        queryKey: keys.deployments.byApplication("org-1", "app-1"),
      }),
    );

    expect(findOne).toHaveBeenCalledTimes(1);
  });
});
