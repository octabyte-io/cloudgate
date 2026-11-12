import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { isApiError } from "@/lib/api/api-error";
import { applicationsApi } from "@/lib/api/endpoints/applications";
import { composeApi } from "@/lib/api/endpoints/compose";
import {
  databasesApi,
  type DatabaseKind,
} from "@/lib/api/endpoints/databases";
import { environmentsApi } from "@/lib/api/endpoints/environments";
import { projectsApi } from "@/lib/api/endpoints/projects";
import { serversApi } from "@/lib/api/endpoints/servers";
import { keys } from "@/lib/api/keys";
import type { OrganizationScope } from "@/lib/api/keys";

import type { ScopeRoute } from "./scope";

/**
 * Every request the shell's identity needs, and nothing else.
 *
 * Split from `scope-provider.tsx` so that file is only the *shape* of the scope —
 * what the masthead and rail read — and this one is only where the names come
 * from. Each query is `enabled` for exactly the scope that shows it, so entering
 * a Server costs one request and no Project lists.
 */
export type ScopeQueries = ReturnType<typeof useScopeQueries>;

export function useScopeQueries(
  scope: ScopeRoute,
  organizationId: OrganizationScope,
) {
  const id = scope.id;
  const ready = id !== null && organizationId !== null;

  const server = useQuery({
    queryKey: keys.servers.detail(organizationId, id ?? ""),
    queryFn: () => serversApi.findOne(id as string),
    enabled: scope.kind === "server" && ready,
  });

  const project = useQuery({
    queryKey: keys.projects.detail(organizationId, id ?? ""),
    queryFn: () => projectsApi.findOne(id as string),
    enabled: scope.kind === "project" && ready,
  });

  const environment = useQuery({
    queryKey: keys.environments.detail(organizationId, id ?? ""),
    queryFn: () => environmentsApi.findOne(id as string),
    enabled: scope.kind === "environment" && ready,
  });

  // An Environment row carries `projectId` and no project name, so its parent —
  // the "Back to …" pill and the "/" in front of its name — is a second request.
  // A service needs no such chase: every service's `findOne` returns
  // `environment.project` already joined.
  const environmentParent = useQuery({
    queryKey: keys.projects.detail(organizationId, environment.data?.projectId ?? ""),
    queryFn: () => projectsApi.findOne(environment.data?.projectId as string),
    enabled: environment.data !== undefined && organizationId !== null,
  });

  const application = useQuery({
    queryKey: keys.applications.detail(organizationId, id ?? ""),
    queryFn: () => applicationsApi.findOne(id as string),
    enabled: scope.kind === "application" && ready,
  });

  // The engine is part of the address, so it is part of the key and part of the
  // request. `scopeFromPath` has already refused an engine we do not have, which
  // is why this can trust `scope.variant`.
  const database = useQuery({
    queryKey: keys.databases.detail(
      organizationId,
      scope.variant ?? "",
      id ?? "",
    ),
    queryFn: () =>
      databasesApi.findOne(scope.variant as DatabaseKind, id as string),
    enabled: scope.kind === "database" && scope.variant !== null && ready,
  });

  const compose = useQuery({
    queryKey: keys.compose.detail(organizationId, id ?? ""),
    queryFn: () => composeApi.findOne(id as string),
    enabled: scope.kind === "compose" && ready,
  });

  // The switcher's list. Only fetched at the scope that offers one, and only
  // once the parent is known for Environments.
  const servers = useQuery({
    queryKey: keys.servers.list(organizationId),
    queryFn: () => serversApi.list(),
    enabled: scope.kind === "server" && organizationId !== null,
  });

  const projects = useQuery({
    queryKey: keys.projects.list(organizationId),
    queryFn: () => projectsApi.list(),
    enabled: scope.kind === "project" && organizationId !== null,
  });

  const projectId = environment.data?.projectId;
  const environments = useQuery({
    queryKey: keys.environments.byProject(organizationId, projectId ?? ""),
    queryFn: () => environmentsApi.listByProject(projectId as string),
    enabled: projectId !== undefined && organizationId !== null,
  });

  /**
   * The one query that *is* this scope's identity — the one whose 404 means the
   * URL names something that is not there.
   *
   * Worked out here rather than in `resolve-scope.ts` because this is the file
   * that knows which query belongs to which scope, and because a 404 has to be
   * told apart from every other refusal: a 403 means the row exists and this
   * role cannot read it, and a backend that is down means nothing at all about
   * the id. Only 404 gets the not-found screen.
   */
  const identity =
    scope.kind === "server"
      ? server
      : scope.kind === "project"
        ? project
        : scope.kind === "environment"
          ? environment
          : scope.kind === "application"
            ? application
            : scope.kind === "database"
              ? database
              : scope.kind === "compose"
                ? compose
                : null;

  const missing = isApiError(identity?.error) && identity.error.isMissing;

  // Memoized on the *rows*, not the query objects: TanStack hands back a new
  // wrapper on every render, and the shell's whole context hangs off this.
  return useMemo(
    () => ({
      server,
      project,
      environment,
      environmentParent,
      application,
      database,
      compose,
      servers,
      projects,
      environments,
      missing,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
    [
      server.data,
      server.isPending,
      project.data,
      project.isPending,
      environment.data,
      environment.isPending,
      environmentParent.data,
      application.data,
      application.isPending,
      database.data,
      database.isPending,
      compose.data,
      compose.isPending,
      servers.data,
      projects.data,
      environments.data,
      missing,
    ],
  );
}
