import { useQueries, useQuery } from "@tanstack/react-query";

import { environmentsApi } from "@/lib/api/endpoints/environments";
import { projectsApi, type Project } from "@/lib/api/endpoints/projects";
import { serversApi } from "@/lib/api/endpoints/servers";
import { keys } from "@/lib/api/keys";
import { useActiveOrganizationId } from "@/lib/auth/client";
import { reachCounts } from "@/lib/design/server-mark";

/**
 * Everything the home page counts, and nothing it cannot.
 *
 * Two list requests — `GET /servers` and `GET /projects` — plus one per Project
 * *shown*, for its Environment count. That last one needs saying out loud: there
 * is no count on a `project` row and no batch route, so the reference's little
 * count chip (e-console.html:2799) costs one request per row. It is bounded to the
 * five rows the card shows, which is the reason the list is capped at five rather
 * than only the reference's layout.
 *
 * The counts are **derived, never written down** — the reference makes the same
 * point about its own tiles (e-console.html:2740-2744) — so a figure on this page
 * cannot drift from the list beside it.
 */

/** Five. The reference's own cap, and the ceiling on the fan-out above. */
export const HOME_LIST_LIMIT = 5;

export function useHomeData() {
  const { organizationId } = useActiveOrganizationId();
  const enabled = organizationId !== null;

  const servers = useQuery({
    queryKey: keys.servers.list(organizationId),
    queryFn: () => serversApi.list(),
    enabled,
  });

  const projects = useQuery({
    queryKey: keys.projects.list(organizationId),
    queryFn: () => projectsApi.list(),
    enabled,
  });

  const shownProjects: Project[] = (projects.data ?? []).slice(
    0,
    HOME_LIST_LIMIT,
  );

  // The same query keys the Project scope uses, so opening one of these rows
  // finds its Environments already cached.
  const environments = useQueries({
    queries: shownProjects.map((project) => ({
      queryKey: keys.environments.byProject(organizationId, project.projectId),
      queryFn: () => environmentsApi.listByProject(project.projectId),
      enabled,
    })),
  });

  /**
   * How many Environments a Project holds, or `undefined` while we do not know.
   * Not zero: a count that starts at zero and grows tells the reader the Project
   * is empty for as long as the request takes, which is the one thing it must
   * not say.
   */
  const environmentCount = (projectId: string): number | undefined => {
    const index = shownProjects.findIndex(
      (project) => project.projectId === projectId,
    );
    return index === -1 ? undefined : environments[index]?.data?.length;
  };

  return {
    servers,
    projects,
    shownProjects,
    shownServers: (servers.data ?? []).slice(0, HOME_LIST_LIMIT),
    // How the last attempt to reach each one went, not the billing flag
    // that is `active` on every self-hosted Server for ever.
    serverReach: reachCounts(servers.data ?? []),
    environmentCount,
  };
}
