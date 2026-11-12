import { useMutation, useQuery } from "@tanstack/react-query";

import {
  templatesApi,
  type TemplateSetupInput,
} from "@/lib/api/endpoints/templates";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useActiveOrganizationId } from "@/lib/auth/client";

/**
 * The Template catalogue and the saved copy it came from.
 *
 * `staleTime` is an hour, far longer than anything else in this app: the
 * backend re-checks the catalogue at most once an hour anyway, so asking
 * sooner can only return the same copy.
 *
 * **An empty answer is evidence of an empty catalogue.** An unreachable one
 * with no saved copy is a 502 or 504, so this query's `error` and its
 * `data.templates.length === 0` are two different states.
 */
export function useTemplateCatalogue() {
  return useQuery({
    queryKey: keys.templates.catalogue(),
    queryFn: () => templatesApi.list(),
    staleTime: 60 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
  });
}

/**
 * The setup form for one template: in one Project, or ({@link NEW_PROJECT})
 * for a new one. Idle until either is picked.
 */
export function useSetupForm(templateId: string, projectId: string | null) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.templates.setupForm(
      organizationId,
      templateId,
      projectId ?? "",
    ),
    queryFn: () =>
      templatesApi.setupForm(
        templateId,
        projectId === NEW_PROJECT ? null : (projectId ?? ""),
      ),
    enabled: organizationId !== null && projectId !== null,
  });
}

/**
 * The Project picker's value for "New Project from a template" (#1376). A
 * Project id is a nanoid, which never spells it.
 */
export const NEW_PROJECT = "new-project";

/**
 * Sets a Template up; the caller goes to the Plan it opened. A new Project
 * from a template is a Project and an Environment the lists have not seen.
 */
export function useSetUpTemplate() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: TemplateSetupInput) => templatesApi.setUp(input),
    onSuccess: (_result, input) =>
      "newProject" in input ? invalidate.project() : undefined,
  });
}
