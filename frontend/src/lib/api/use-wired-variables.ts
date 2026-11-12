import { useMutation, useQuery } from "@tanstack/react-query";

import { wiredVariablesApi } from "@/lib/api/endpoints/wired-variables";
import type {
  LinkingType,
  WiredVariable,
} from "@/lib/api/endpoints/wired-variables";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useActiveOrganizationId } from "@/lib/auth/client";

/**
 * Keyed under the Service itself, so whatever refreshes the Application or
 * the database — a deploy that clears the notice, a Save — refreshes this.
 */
function linksKey(
  organizationId: string | null,
  serviceType: LinkingType,
  serviceId: string,
) {
  return serviceType === "application"
    ? keys.applications.links(organizationId, serviceId)
    : keys.databases.links(organizationId, serviceType, serviceId);
}

/** A Service's wired variables, the picker's sources and the notice. */
export function useWiredVariables(serviceType: LinkingType, serviceId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: linksKey(organizationId, serviceType, serviceId),
    queryFn: () => wiredVariablesApi.find(serviceType, serviceId),
    enabled: organizationId !== null && serviceId !== "",
  });
}

/**
 * The console Save of a Service's links. Its config and its plan changed with
 * it, so the Service, its Environment and the Project config refresh.
 */
export function useSaveWiredVariables(
  serviceType: LinkingType,
  serviceId: string,
  environmentId?: string,
) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (links: readonly WiredVariable[]) =>
      wiredVariablesApi.save(serviceType, serviceId, links),
    onSuccess: () =>
      serviceType === "application"
        ? invalidate.application({ applicationId: serviceId, environmentId })
        : invalidate.database({
            kind: serviceType,
            databaseId: serviceId,
            environmentId,
          }),
  });
}
