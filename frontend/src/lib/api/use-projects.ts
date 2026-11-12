import { useQuery } from "@tanstack/react-query";

import { useActiveOrganizationId } from "@/lib/auth/client";

import { projectsApi } from "./endpoints/projects";
import { keys } from "./keys";

/**
 * The Organization's Projects, as the signed-in person may see them.
 *
 * Built by F07 inside `features/project/use-projects.ts` and **moved here**
 * when `components/console/access-tree.tsx` — shared by Members'
 * Manage access and the Agents section — needed it, and a component under
 * `components/` does not reach into a feature. Re-exported from the old path,
 * as `useRegistries` was, so no feature's call site changed.
 */
export function useProjects() {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.projects.list(organizationId),
    queryFn: () => projectsApi.list(),
    enabled: organizationId !== null,
  });
}
