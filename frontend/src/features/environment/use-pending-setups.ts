import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { pendingSetupsApi } from "@/lib/api/endpoints/pending-setups";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useActiveOrganizationId } from "@/lib/auth/client";
import { roleRefusal } from "@/lib/auth/use-permission";

/** Cancel's reason when the role cannot: the route asks `environment: ['update']`. */
export const PENDING_SETUP_CANCEL_REFUSAL = roleRefusal(
  "cancel a Pending setup",
);

/** The Environment's Pending setups, and the notes of those the sweep dropped. */
export function usePendingSetups(environmentId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.environments.pendingSetups(organizationId, environmentId),
    queryFn: () => pendingSetupsApi.list(environmentId),
    enabled: organizationId !== null && environmentId !== "",
  });
}

/**
 * Cancels one Pending setup. The list is read again, and the Environment's
 * plan takes the plan the cancel made again, when it made one: the open
 * plan it replaced still offered the cancelled parts.
 */
export function useCancelPendingSetup(environmentId: string) {
  const { organizationId } = useActiveOrganizationId();
  const queryClient = useQueryClient();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (pendingSetupId: string) =>
      pendingSetupsApi.remove(environmentId, pendingSetupId),
    onSuccess: ({ plan }) => {
      if (plan) {
        queryClient.setQueryData(
          keys.environments.plan(organizationId, environmentId),
          { plan },
        );
      }
    },
    onSettled: () => invalidate.pendingSetups(environmentId),
  });
}
