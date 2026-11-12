import { useMutation, useQueries, useQuery } from "@tanstack/react-query";

import { useActiveOrganizationId } from "@/lib/auth/client";

import { settingsApi, type GpuCounts } from "./endpoints/settings";
import { keys } from "./keys";
import { useInvalidate } from "./use-invalidate";

/**
 * One machine's GPU check — the platform host when `serverId` is null,
 * a Server otherwise. In `lib/api/` because two features read it: Instance
 * settings for the platform host and a Server's Infrastructure tab.
 *
 * `enabled` because the check is behind a button: it cannot fail, so a
 * machine nobody meant to run a GPU on would otherwise show a card of crosses.
 */
export function useGpu(serverId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: keys.instanceGpu(serverId),
    queryFn: () => settingsApi.gpu(serverId),
    enabled,
    retry: false,
  });
}

/** GPU setup on that machine; drops the `instance` root like every host write. */
export function useSetupGpu(serverId: string | null) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => settingsApi.setupGpu(serverId),
    onSettled: () => invalidate.instanceSettings(),
  });
}

/**
 * A host's cards and free cards, for choosing a GPU reservation — the
 * Resources card today, the AI model dialog's Server picker later. Live on the
 * backend, so it is fetched when shown rather than kept: `enabled` is the
 * caller's `service: ['create']`, which the route requires.
 */
export function useGpuCounts(serverId: string | null, enabled: boolean) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.servers.gpuCounts(organizationId, serverId),
    queryFn: () => settingsApi.gpuCounts(serverId),
    enabled: enabled && organizationId !== null,
    retry: false,
  });
}

/**
 * Every listed host's cards and free cards at once, for the AI model
 * dialog's Server picker: one live read per host, on the same keys as
 * {@link useGpuCounts}, so the Resources card reuses what the picker read.
 * Answers by `serverId`, `null` the platform host; a host whose read has not
 * come back, or failed, is simply absent.
 */
export function useGpuCountsEach(
  serverIds: readonly (string | null)[],
  enabled: boolean,
): Map<string | null, GpuCounts> {
  const { organizationId } = useActiveOrganizationId();
  const results = useQueries({
    queries: serverIds.map((serverId) => ({
      queryKey: keys.servers.gpuCounts(organizationId, serverId),
      queryFn: () => settingsApi.gpuCounts(serverId),
      enabled: enabled && organizationId !== null,
      retry: false,
    })),
  });
  const counts = new Map<string | null, GpuCounts>();
  results.forEach((result, index) => {
    if (result.data) counts.set(serverIds[index], result.data);
  });
  return counts;
}
