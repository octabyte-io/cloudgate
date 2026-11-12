import { useQuery } from "@tanstack/react-query";

import {
  connectionId,
  gitProvidersApi,
  type GitProviderKind,
  type SourceRepository,
} from "@/lib/api/endpoints/git-providers";
import { keys } from "@/lib/api/keys";
import { useActiveOrganizationId } from "@/lib/auth/client";

/**
 * The three reads a source picker makes, in the order it makes them:
 * which connections of this kind exist, what one of them can reach, and what
 * branches a chosen repository has.
 *
 * **Every one of these leaves the building.** The backend proxies straight
 * through to GitHub, GitLab, Gitea or Bitbucket on each miss, so a stale cache is
 * cheap and a refetch is not. They are `staleTime`-free but never refetched on
 * focus: someone tabbing away to authorise an app and back is the *one* case
 * where a refetch would be welcome, and the "Refresh" control is a better answer
 * than a surprise request while they are mid-form.
 */

export function useGitConnections(kind: GitProviderKind, enabled = true) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.gitProviders.connections(organizationId, kind),
    queryFn: () => gitProvidersApi.connections(kind),
    enabled: enabled && organizationId !== null,
  });
}

export function useRepositories(
  kind: GitProviderKind,
  connection: string,
  enabled = true,
) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.gitProviders.repositories(organizationId, kind, connection),
    queryFn: () => gitProvidersApi.repositories(kind, connection),
    enabled: enabled && organizationId !== null && connection !== "",
    refetchOnWindowFocus: false,
  });
}

/**
 * The branches of one repository.
 *
 * Keyed by the repository's key as well as the connection, so switching
 * repository shows *nothing* while the new list loads rather than the previous
 * repository's branches — which would offer a branch that does not exist in the
 * repository now selected, and let someone save it.
 */
export function useBranches(
  kind: GitProviderKind,
  connection: string,
  repository: SourceRepository | null,
) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.gitProviders.branches(
      organizationId,
      kind,
      connection,
      repository?.key ?? "",
    ),
    queryFn: () => gitProvidersApi.branches(kind, connection, repository!),
    enabled:
      organizationId !== null && connection !== "" && repository !== null,
    refetchOnWindowFocus: false,
  });
}

/** The strategy row's id for each connection, paired with the name to show. */
export function connectionOptions(
  kind: GitProviderKind,
  connections:
    | Awaited<ReturnType<typeof gitProvidersApi.connections>>
    | undefined,
) {
  return (connections ?? []).map((connection) => ({
    id: connectionId(kind, connection),
    name: connection.gitProvider.name,
  }));
}
