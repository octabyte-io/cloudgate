import { useQuery } from "@tanstack/react-query";

import { cloudAccountsApi } from "@/lib/api/endpoints/cloud-accounts";
import { keys } from "@/lib/api/keys";
import { useActiveOrganizationId } from "@/lib/auth/client";

/** The Organization's Cloud accounts; reading them never calls AWS. */
export function useCloudAccounts({
  enabled = true,
}: { enabled?: boolean } = {}) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.cloudAccounts.list(organizationId),
    queryFn: () => cloudAccountsApi.list(),
    // Off for a role without `cloudAccount: read`, which the list would refuse.
    enabled: enabled && organizationId !== null,
  });
}
