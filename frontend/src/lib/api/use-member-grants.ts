import { useMutation, useQueries } from "@tanstack/react-query";

import { useActiveOrganizationId } from "@/lib/auth/client";

import {
  environmentsApi,
  type Environment,
  type EnvironmentService,
} from "./endpoints/environments";
import {
  organizationsApi,
  type MemberEntitlements,
} from "./endpoints/organizations";
import { keys } from "./keys";
import { useInvalidate } from "./use-invalidate";

/**
 * What a Member holds — its role and its grant — written through the Members
 * routes, and the reads the grant dialog's tree is built from.
 *
 * Built by F16 inside `features/members/use-members.ts` and **moved here**
 * when the Agents section became the second feature to write them: an
 * Agent is a Member, so changing its role or its grant is the Members route
 * against its member row (`writeMemberRole` is the one writer of
 * `member.role`), not a second path to the same column. The fan-out
 * reads came with them, because the access tree that reads through them left
 * `features/` for `components/console/access-tree.tsx` at the same time. Same
 * move `useRegistries` and `useServers` made, for the same reason — §3.5 keeps
 * a hook with its feature until a second feature needs it.
 */

export function useUpdateMemberRole() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ memberId, role }: { memberId: string; role: string }) =>
      organizationsApi.updateMemberRole(memberId, role),
    onSettled: () => invalidate.membership(),
  });
}

/**
 * Replace what a Member may reach.
 *
 * **No query key of its own, and that is the point**: the three `accessed*`
 * columns come back on the `member` row the roster already caches, so the
 * dialog's read is a cache hit and the write invalidates the same list that
 * displayed it. `invalidate.membership()` is what every other member mutation
 * calls and it widens to the whole tenant subtree — which is right here for a
 * reason the role mutation does not have: these grants are what
 * `PermissionService` filters the Project and Environment lists by, so a save
 * changes the answer to `GET /projects` for that person too.
 */
export function useUpdateMemberEntitlements() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      memberId,
      grants,
    }: {
      memberId: string;
      grants: MemberEntitlements;
    }) => organizationsApi.updateMemberEntitlements(memberId, grants),
    onSettled: () => invalidate.membership(),
  });
}

/** One scope of the access dialog's fan-out, kept apart from its neighbours. */
export interface GrantScope<T> {
  /** The parent's id — the Project or the Environment this answers for. */
  id: string;
  rows: T[] | undefined;
  error: unknown;
  isPending: boolean;
}

/**
 * `useQueries`' parallel array read back as one scope per id.
 *
 * Both fan-outs below ended in this exact six-line map, and the pair is the
 * shape the whole dialog turns on: the index is the only thing tying a result
 * to the id that asked for it, so a `?? true` on `isPending` is what keeps an
 * id whose slot has not appeared yet from reading as "answered, and empty" —
 * which the dialog would then class as a stranded grant and strip.
 */
function toGrantScopes<T>(
  ids: string[],
  results: readonly { data?: T[]; error: unknown; isPending: boolean }[],
): GrantScope<T>[] {
  return ids.map((id, index) => ({
    id,
    rows: results[index]?.data,
    error: results[index]?.error,
    isPending: results[index]?.isPending ?? true,
  }));
}

/**
 * The Environments of the **ticked** Projects, one request each.
 *
 * `GET /environments?projectId=` is the only Environment listing there is, so
 * this is `useEnvironmentCounts`' fan-out idiom (`features/project/use-projects.ts`)
 * pointed at a different question. Bounding it by the grant rather than by the
 * Organization is deliberate: an Organization with forty Projects would
 * otherwise cost forty requests to open a dialog about three ticks.
 *
 * Each scope keeps its own error, because a half-failed fan-out must say so
 * under the one group that could not be read rather than failing the dialog —
 * the other two columns are still submittable.
 */
export function useEnvironmentsOfProjects(
  projectIds: string[],
): GrantScope<Environment>[] {
  const { organizationId } = useActiveOrganizationId();

  const results = useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: keys.environments.byProject(organizationId, projectId),
      queryFn: () => environmentsApi.listByProject(projectId),
      enabled: organizationId !== null,
    })),
  });

  return toGrantScopes(projectIds, results);
}

/**
 * What is deployed in the **ticked** Environments, one request each.
 *
 * `GET /environments/:id` is the only route in the API that names Services —
 * there is no flat "every Service in this Organization" listing, and
 * `listByProject` deliberately does not carry them — so the roster has to
 * be reached one Environment at a time, and the ticked Environments are the
 * only ones a grant can be made against anyway.
 */
export function useServicesOfEnvironments(
  environmentIds: string[],
): GrantScope<EnvironmentService>[] {
  const { organizationId } = useActiveOrganizationId();

  const results = useQueries({
    queries: environmentIds.map((environmentId) => ({
      queryKey: keys.environments.detail(organizationId, environmentId),
      queryFn: () => environmentsApi.findOne(environmentId),
      enabled: organizationId !== null,
      select: (detail: { services: EnvironmentService[] }) => detail.services,
    })),
  });

  return toGrantScopes(environmentIds, results);
}
