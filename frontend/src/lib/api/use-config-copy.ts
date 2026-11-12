import { useQuery } from "@tanstack/react-query";

import { projectConfigApi } from "@/lib/api/endpoints/project-config";
import { keys } from "@/lib/api/keys";
import { useActiveOrganizationId } from "@/lib/auth/client";

/**
 * An Environment's copy of a repository-kept config, read from its Config
 * branch on every fetch. Not refetched on focus: each read reaches the
 * provider's API. Read by the Project config page and, for the locks on
 * config-owned fields, by every Service page of the Environment.
 */
export function useEnvironmentConfigCopy(
  environmentId: string,
  enabled = true,
) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.environments.configCopy(organizationId, environmentId),
    queryFn: () => projectConfigApi.findCopy(environmentId),
    enabled: enabled && organizationId !== null && environmentId !== "",
    refetchOnWindowFocus: false,
  });
}
