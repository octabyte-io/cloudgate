import { useMutation, useQuery } from "@tanstack/react-query";

import {
  tagsApi,
  type CreateTagInput,
  type UpdateTagInput,
} from "@/lib/api/endpoints/tags";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useActiveOrganizationId } from "@/lib/auth/client";

/**
 * The Organization's Tags, and what they are attached to.
 *
 * Every mutation here invalidates the **whole** `tags` subtree rather than a
 * narrowed key, and that is deliberate: renaming a Tag changes the chip on every
 * Project carrying it, deleting one takes it off every Project at once
 * (`project_tag` cascades in the schema), and neither the row nor the response
 * says which Projects those were. See `use-invalidate.ts`.
 */

export function useTags() {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.tags.list(organizationId),
    queryFn: () => tagsApi.list(),
    enabled: organizationId !== null,
  });
}

export function useProjectTagList(projectId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.tags.byProject(organizationId, projectId),
    queryFn: () => tagsApi.listByProject(projectId),
    enabled: organizationId !== null && projectId !== "",
  });
}

export function useCreateTag() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateTagInput) => tagsApi.create(input),
    onSuccess: () => invalidate.tag(),
  });
}

export function useUpdateTag() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ tagId, input }: { tagId: string; input: UpdateTagInput }) =>
      tagsApi.update(tagId, input),
    onSuccess: () => invalidate.tag(),
  });
}

export function useDeleteTag() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (tagId: string) => tagsApi.remove(tagId),
    onSuccess: () => invalidate.tag(),
  });
}

/**
 * Put a Tag on a Project or take it off, in one mutation.
 *
 * One hook rather than two because the caller is always a checkbox: it knows
 * which Tag and whether it should now be on, and splitting that into
 * `useAssign`/`useUnassign` would make every call site branch on `checked` and
 * then hold two pending flags for one control.
 */
export function useSetProjectTag(projectId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ tagId, on }: { tagId: string; on: boolean }) =>
      on
        ? tagsApi.assign(tagId, projectId).then(() => undefined)
        : tagsApi.unassign(tagId, projectId),
    onSuccess: () => invalidate.tag(),
  });
}
