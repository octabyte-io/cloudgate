import { useMutation, useQueries, useQuery } from "@tanstack/react-query";

import { useForgetVisited } from "@/components/shell/recents";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { environmentsApi } from "@/lib/api/endpoints/environments";
import {
  projectsApi,
  type CreateProjectInput,
  type Project,
  type UpdateProjectInput,
} from "@/lib/api/endpoints/projects";
import { tagsApi, type Tag } from "@/lib/api/endpoints/tags";
import { tokenSpendApi } from "@/lib/api/endpoints/token-spend";
import { keys } from "@/lib/api/keys";
import { useActiveOrganizationId } from "@/lib/auth/client";

/**
 * Everything the Project screens read and write.
 *
 * **The fan-out is the thing to understand here.** `GET /projects` answers with
 * bare `project` rows: no Environment count, no Tags, no children of any kind
 * (`projects.service.ts`). Both of the columns the reference's list has beside
 * the name therefore cost **one request per row** — `GET /environments?projectId=`
 * and `GET /tags?projectId=` — and there is no batch route for either.
 *
 * That is why they are two named hooks and not an inline `useQueries` in a
 * component: the cost is a property of the endpoint, it is the same cost the
 * home page already pays for its count chip, and when a `project` row starts
 * carrying its own counts these two hooks are what change.
 *
 * The keys are the same ones the Project scope's own screens use, so opening a
 * row finds its Environments already cached.
 */

/**
 * Why a Project write is off, one sentence per statement.
 *
 * They live beside the mutations that meet the refusal rather than in the three
 * components that show it, for the reason §1.4 gives about anything a second
 * reader wants: `project-details-form.tsx` and `project-columns.tsx` both say
 * the `update` one, and two copies of a sentence are two sentences the moment
 * one of them is reworded. They stay inside `features/project/` because that is
 * where the surfaces are; nothing here has a second feature asking for it.
 *
 * The wording is CONTEXT.md's. **Rewriting** a Project is what `project:
 * ['update']` grants and what the base member no longer holds, and it deliberately
 * lists what that reaches — a member who is told "you cannot update this
 * Project" while looking at a name field will try the name field. The advice is
 * `errorMessage()`'s for a 403 and is not an accident: it is the same advice a
 * caller gets from the backend's own refusal, so a member who reaches one anyway
 * is not told two different things.
 */
export const PROJECT_UPDATE_REFUSAL =
  "Your role in this Organization cannot rewrite a Project — its name, its description, its variables or its Tags. Ask an owner or an admin to make the change, or to change your role.";

/** `project: ['delete']`, which the base member does not hold either. */
export const PROJECT_DELETE_REFUSAL =
  "Your role in this Organization cannot delete a Project. Ask an owner or an admin to do it, or to change your role.";

/**
 * `project: ['create']`. It takes no id, because a Project has no parent to be
 * entitled to — so this is the one of the three that no `accessedProjects` grant
 * can ever stand in for.
 */
export const PROJECT_CREATE_REFUSAL =
  "Your role in this Organization cannot create a Project. Ask an owner or an admin to make one, or to change your role.";

/** Moved to `lib/api/use-projects.ts`; re-exported so call sites stay. */
export { useProjects } from "@/lib/api/use-projects";

export function useProject(projectId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.projects.detail(organizationId, projectId),
    queryFn: () => projectsApi.findOne(projectId),
    enabled: organizationId !== null && projectId !== "",
  });
}

/**
 * The Project's Token spend over the last 30 days, by Environment,
 * summing only the AI models the caller can read. Not retried: a refusal is
 * an answer, and the fact simply stays away.
 */
export function useProjectTokenSpend(projectId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.projects.tokenSpend(organizationId, projectId),
    queryFn: () => tokenSpendApi.forProject(projectId),
    enabled: organizationId !== null && projectId !== "",
    retry: false,
  });
}

/**
 * How many Environments each of these Projects holds.
 *
 * Returns a lookup rather than an array, because the caller filters and sorts
 * its rows and an index into the request list would go wrong the moment it did.
 * A Project still in flight is **`undefined`, never `0`** — a count that starts
 * at zero and grows tells the reader the Project is empty for as long as the
 * request takes, which is the one thing it must not say (F07's `CountTile`
 * found this the expensive way).
 */
export function useEnvironmentCounts(projects: Project[]) {
  const { organizationId } = useActiveOrganizationId();

  const results = useQueries({
    queries: projects.map((project) => ({
      queryKey: keys.environments.byProject(organizationId, project.projectId),
      queryFn: () => environmentsApi.listByProject(project.projectId),
      enabled: organizationId !== null,
    })),
  });

  const counts = new Map<string, number | undefined>();
  projects.forEach((project, index) => {
    counts.set(project.projectId, results[index]?.data?.length);
  });
  return counts;
}

/** The Tags on each of these Projects, same shape and same reasoning as above. */
export function useProjectTags(projects: Project[]) {
  const { organizationId } = useActiveOrganizationId();

  const results = useQueries({
    queries: projects.map((project) => ({
      queryKey: keys.tags.byProject(organizationId, project.projectId),
      queryFn: () => tagsApi.listByProject(project.projectId),
      enabled: organizationId !== null,
    })),
  });

  const byProject = new Map<string, Tag[] | undefined>();
  projects.forEach((project, index) => {
    byProject.set(project.projectId, results[index]?.data);
  });
  return byProject;
}

export function useCreateProject() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateProjectInput) => projectsApi.create(input),
    onSuccess: () => invalidate.project(),
  });
}

export function useUpdateProject(projectId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: UpdateProjectInput) =>
      projectsApi.update(projectId, input),
    onSuccess: () => invalidate.project(projectId),
  });
}

export function useDeleteProject() {
  const invalidate = useInvalidate();
  const forgetVisited = useForgetVisited();
  return useMutation({
    mutationFn: (projectId: string) => projectsApi.remove(projectId),
    // The Tag subtree goes too: `project_tag` cascades with the Project, so
    // every `tags?projectId=` answer for it is now a 404 waiting to happen.
    // So do its Recents, Environments and services included.
    onSuccess: (_row, projectId) => {
      forgetVisited([projectId]);
      return Promise.all([invalidate.project(projectId), invalidate.tag()]);
    },
  });
}
