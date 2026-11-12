import { useQuery } from "@tanstack/react-query";

import {
  dockerApi,
  type WorkloadServiceType,
} from "@/lib/api/endpoints/docker";
import { keys } from "@/lib/api/keys";
import { useActiveOrganizationId } from "@/lib/auth/client";

/**
 * How long one answer serves. The read is a `docker ps` — over
 * SSH for a Service on a Server — and it is asked by every tab of a Service
 * page, through the layout's Dock offer (`OfferServiceShell`) as well as the
 * Shell tab, which share this one key. Two minutes rather than the console's
 * 30-second default, so moving around a Service page does not keep dialling
 * its machine; not much longer, because a Deploy replaces the containers and
 * an id from before it names nothing. Never on window focus (the client's
 * default, said here too): alt-tabbing is not a Deploy.
 */
export const SERVICE_CONTAINERS_STALE_MS = 2 * 60_000;

/**
 * **A Service's running containers, found by the Service**:
 * `GET /docker/services/:serviceType/:serviceId/containers`.
 *
 * The one read that hands a container id to a caller with no `docker` action:
 * it is gated on `service:update` on the Service — what the terminal socket
 * asks for — so every id it answers is one `/docker-container-terminal`
 * accepts. Only the containers on the Service's own machine (its Server, or the
 * platform host), running ones only. A Compose stack's rows carry
 * `composeService`.
 *
 * `enabled: false` until there is a Service to ask about — and for one in a
 * Cloud account, which runs no container (the route answers `[]` there too).
 *
 * Not retried on a refusal or an unreached Server (the client's defaults
 * already say so).
 */
export function useServiceContainers(
  serviceType: WorkloadServiceType,
  serviceId: string,
  options: { enabled?: boolean } = {},
) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.docker.ofService(organizationId, serviceType, serviceId),
    queryFn: () => dockerApi.serviceContainers(serviceType, serviceId),
    enabled:
      organizationId !== null &&
      serviceId !== "" &&
      (options.enabled ?? true),
    staleTime: SERVICE_CONTAINERS_STALE_MS,
    refetchOnWindowFocus: false,
  });
}
