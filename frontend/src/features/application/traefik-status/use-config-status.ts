import { useQuery } from "@tanstack/react-query";

import { traefikApi } from "@/lib/api/endpoints/traefik";
import { keys } from "@/lib/api/keys";
import { useActiveOrganizationId } from "@/lib/auth/client";

/**
 * What Traefik last said about this Application's routers.
 *
 * **A query and not a subscription, and not a poll.** The backend takes this
 * observation when it *writes* the config — it anchors on Traefik's own clock,
 * writes, then reads `docker logs` past the anchor — so there is nothing to
 * poll: between two writes the answer cannot change, and a byte-identical
 * regeneration produces no log line at all. Refetching on a timer would put a
 * live-monitoring frame around a value that is a record of one moment, which is
 * exactly the impression `config-status-notice.tsx` is written to avoid.
 *
 * **What moves it is a write, then.** Every console mutation that rewrites the
 * Application's file — a domain, a redirect, a basic-auth user — calls
 * `invalidate.traefikConfig`, which re-reads this after the backend's own check
 * has had time to land. Invalidating it at the moment of the save would
 * only fetch the previous answer again.
 *
 * It is read on the Domains tab and on the Advanced tab, which is why it lives
 * here rather than beside either: they are two screens of one feature, so the
 * promotion rule keeps it inside `features/application`.
 */
export function useTraefikConfigStatus(applicationId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.traefik.configStatus(organizationId, applicationId),
    queryFn: () => traefikApi.configStatus(applicationId),
    enabled: organizationId !== null && applicationId !== "",
  });
}
