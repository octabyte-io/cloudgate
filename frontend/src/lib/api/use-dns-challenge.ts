import { useMutation, useQuery } from "@tanstack/react-query";

import {
  traefikApi,
  type DnsChallengeInput,
} from "./endpoints/traefik";
import { keys } from "./keys";
import { useInvalidate } from "./use-invalidate";

/**
 * One machine's DNS-01 setup — the platform host when `serverId` is
 * null, a Server otherwise. In `lib/api/` because two features read it: the
 * platform host's Traefik screen and a Server's Settings tab.
 *
 * `?? null` because the route answers a missing setup with Nest's empty body,
 * which the client reads as `undefined`, and a query may not resolve to that.
 * `retry: false` for the reason the Traefik container reads take it: the
 * interesting failure is the 403, and a role does not change between attempts.
 */
export function useDnsChallenge(serverId: string | null) {
  return useQuery({
    queryKey: keys.traefikDnsChallenge(serverId),
    queryFn: async () => (await traefikApi.dnsChallenge(serverId)) ?? null,
    retry: false,
  });
}

/**
 * Save and Remove. Both drop the whole `instance` root, as every Traefik write
 * does: a save recreates that machine's Traefik, so its env read is stale too.
 */
export function useDnsChallengeMutations(serverId: string | null) {
  const invalidate = useInvalidate();
  const settled = { onSettled: () => invalidate.instanceSettings() };
  return {
    save: useMutation({
      mutationFn: (input: Omit<DnsChallengeInput, "serverId">) =>
        traefikApi.writeDnsChallenge({ ...input, serverId }),
      ...settled,
    }),
    remove: useMutation({
      mutationFn: () => traefikApi.removeDnsChallenge(serverId),
      ...settled,
    }),
  };
}
