import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { cloudResourcesApi } from "@/lib/api/endpoints/cloud-resources";
import type { Plan } from "@/lib/api/endpoints/project-config";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useActiveOrganizationId } from "@/lib/auth/client";
import { roleRefusal } from "@/lib/auth/use-permission";

/** `service: update`, Rebuild's statement on a cloud Service. */
export const SERVICE_REBUILD_REFUSAL = roleRefusal(
  "rebuild this Service's Infrastructure state",
);

/** `environment: update`, Rebuild's statement on an Environment network. */
export const NETWORK_REBUILD_REFUSAL = roleRefusal(
  "rebuild this Environment network's Infrastructure state",
);

/**
 * What Cloudgate made for a cloud Service: one `tofu show` of its
 * state on the platform host, so it is read when shown and not polled.
 */
export function useServiceCloudResources(
  applicationId: string,
  enabled = true,
) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.applications.cloudResources(organizationId, applicationId),
    queryFn: () => cloudResourcesApi.ofService(applicationId),
    enabled: enabled && organizationId !== null && applicationId !== "",
    retry: false,
  });
}

/** What Cloudgate made for an Environment network, read when shown. */
export function useNetworkCloudResources(
  environmentId: string,
  environmentNetworkId: string,
  enabled = true,
) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.environments.networkResources(
      organizationId,
      environmentId,
      environmentNetworkId,
    ),
    queryFn: () =>
      cloudResourcesApi.ofNetwork(environmentId, environmentNetworkId),
    enabled: enabled && organizationId !== null,
    retry: false,
  });
}

/**
 * Rebuild from the cloud: the answer is the Environment's new plan,
 * written into its key as "Check for changes" writes its own; the lists and
 * the networks are read again.
 */
function useRebuild(
  environmentId: string,
  rebuild: (confirmName: string) => Promise<Plan>,
) {
  const { organizationId } = useActiveOrganizationId();
  const queryClient = useQueryClient();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: rebuild,
    onSuccess: async (plan) => {
      queryClient.setQueryData(
        keys.environments.plan(organizationId, environmentId),
        { plan },
      );
      await Promise.all([
        invalidate.environmentNetworks(environmentId),
        invalidate.application(),
      ]);
    },
  });
}

export function useRebuildServiceState(
  applicationId: string,
  environmentId: string,
) {
  return useRebuild(environmentId, (confirmName) =>
    cloudResourcesApi.rebuildService(applicationId, confirmName),
  );
}

export function useRebuildNetworkState(
  environmentId: string,
  environmentNetworkId: string,
) {
  return useRebuild(environmentId, (confirmName) =>
    cloudResourcesApi.rebuildNetwork(
      environmentId,
      environmentNetworkId,
      confirmName,
    ),
  );
}
