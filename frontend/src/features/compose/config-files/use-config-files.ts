import { useMutation, useQuery } from "@tanstack/react-query";

import { mountsApi } from "@/lib/api/endpoints/mounts";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useActiveOrganizationId } from "@/lib/auth/client";

/**
 * A Compose stack's **Config files** (`CONTEXT.md`): its `file` mounts, which a
 * Template's setup creates. `GET /mounts` answers each with its content.
 *
 * Under the key the scope's own read uses (`use-scope-queries.ts`), which is
 * what decides whether the tab is offered, so the two never disagree.
 */
export function useConfigFiles(composeId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.mounts.byService(organizationId, composeId),
    queryFn: () => mountsApi.listByService(composeId, "compose"),
    enabled: organizationId !== null && composeId !== "",
    select: (mounts) => mounts.filter((mount) => mount.type === "file"),
  });
}

/**
 * One file's content, written where the stack runs (`PATCH /mounts/:id`).
 *
 * **Only `content` is sent.** The stack's compose file names each file by its
 * path, so a path or a kind that changed here would break it (spec #134); a
 * body without them leaves both as they are.
 *
 * The list is read again before the save resolves, so the editor's next
 * baseline is what the backend kept rather than what was typed.
 */
export function useSaveConfigFile(composeId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ mountId, content }: { mountId: string; content: string }) =>
      mountsApi.update(mountId, { content }),
    onSuccess: () => invalidate.mounts(composeId),
  });
}
