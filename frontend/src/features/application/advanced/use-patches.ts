import { useMutation, useQuery } from "@tanstack/react-query";

import {
  patchesApi,
  type CreatePatchInput,
  type UpdatePatchInput,
} from "@/lib/api/endpoints/patches";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useActiveOrganizationId } from "@/lib/auth/client";

/**
 * The patch list, and the repository behind it.
 *
 * Its own module rather than part of `use-advanced.ts` because patches are the
 * one thing on these tabs with **a second resource underneath them**: a clone of
 * the source, on the Server, that has to be made before its files can be listed.
 * That clone is a side effect with a cost — `ensureRepo` runs a `git clone` over
 * SSH — so it is a mutation someone presses, never a query that fires because a
 * tab opened.
 *
 * Two of these three routes answer `text/plain`, which is the trap F09 paid for:
 * a Nest route typed `Promise<string>` is not JSON, and `api.get<string>` hands
 * back `undefined` with a type that says otherwise. `ensureRepo` and `readFile`
 * both use the text methods.
 *
 * `useRepoFile` reads the file **twice** — once as the build will
 * apply it and once as the repository has it — which is what lets the editor
 * show the before-side of an `update` patch. Its own note says why the second read
 * is allowed to 404.
 */

export function usePatches(applicationId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.patches.byEntity(organizationId, applicationId),
    queryFn: () => patchesApi.listByEntity(applicationId, "application"),
    enabled: organizationId !== null && applicationId !== "",
  });
}

export function usePatchMutations(applicationId: string) {
  const invalidate = useInvalidate();
  const done = () => invalidate.patches(applicationId);

  return {
    create: useMutation({
      mutationFn: (input: CreatePatchInput) => patchesApi.create(input),
      onSuccess: done,
    }),
    update: useMutation({
      mutationFn: (args: { patchId: string; input: UpdatePatchInput }) =>
        patchesApi.update(args.patchId, args.input),
      onSuccess: done,
    }),
    toggle: useMutation({
      mutationFn: (args: { patchId: string; enabled: boolean }) =>
        patchesApi.toggle(args.patchId, args.enabled),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (patchId: string) => patchesApi.remove(patchId),
      onSuccess: done,
    }),
    saveFile: useMutation({
      mutationFn: (input: {
        filePath: string;
        content: string;
        patchType?: "create" | "update";
      }) =>
        patchesApi.saveFile({
          id: applicationId,
          type: "application",
          ...input,
        }),
      onSuccess: done,
    }),
    markForDeletion: useMutation({
      mutationFn: (filePath: string) =>
        patchesApi.markForDeletion({
          id: applicationId,
          type: "application",
          filePath,
        }),
      onSuccess: done,
    }),
    /**
     * Clone the source so its files can be listed. **A mutation, pressed.**
     *
     * It shells out to `git clone` on the Server, which for a large repository
     * is seconds and bandwidth. A query would run it because someone opened a
     * tab; this runs it because someone asked to browse.
     */
    ensureRepo: useMutation({
      mutationFn: () => patchesApi.ensureRepo(applicationId, "application"),
    }),
  };
}

/**
 * The clone's tracked files, once there is a clone to ask about.
 *
 * `repoPath` is not sent — the route derives the directory from the entity. It
 * stays here as the gate (a null one means `ensureRepo` has not run yet, so
 * there is nothing to list) and as a key, so a fresh clone refetches.
 */
export function useRepoDirectories(
  applicationId: string,
  repoPath: string | null,
) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: [
      ...keys.patches.repo(organizationId, applicationId),
      "directories",
      repoPath,
    ],
    queryFn: () =>
      patchesApi.readDirectories({
        id: applicationId,
        type: "application",
      }),
    enabled: organizationId !== null && repoPath !== null,
    refetchOnWindowFocus: false,
  });
}

/**
 * One file, **twice** — what the build will use, and what the repository has.
 *
 * `GET /patches/repo/file` answers a patch's content when one exists for the path
 * and the repository's copy otherwise, so a single read could not show what an
 * `update` patch *replaces*: the original became unreachable the moment the patch
 * existed. That was the whole
 * defect, and `source=repo` closes it by skipping that resolution.
 *
 * So this returns both sides, and the second is **deliberately allowed to fail
 * without taking the first down**:
 *
 * - **`applied`** — `source: "patch"`, the default and the historical behaviour.
 *   This is what the editor loads and edits, and it must never be blocked by
 *   anything the "before" side does.
 * - **`original`** — `source: "repo"`. A **404** here is a normal, expected
 *   answer, not an error to surface: a `create` patch is a file the repository
 *   does not have, so there is nothing to compare against and the editor simply
 *   has no before-side. `retry: false` because that 404 is permanent, and
 *   `throwOnError` is never set, so the caller reads `original.data` and treats
 *   `undefined` as "no original".
 *
 * Both hang off `keys.patches.repoFile`, so `invalidate.patches()` drops them
 * together — which it has to: saving a patch changes what `source: "patch"`
 * returns for a path nothing else touched.
 */
export function useRepoFile(applicationId: string, filePath: string | null) {
  const { organizationId } = useActiveOrganizationId();
  const enabled = organizationId !== null && filePath !== null;
  const base = keys.patches.repoFile(
    organizationId,
    applicationId,
    filePath ?? "",
  );

  const applied = useQuery({
    queryKey: base,
    queryFn: () =>
      patchesApi.readFile({
        id: applicationId,
        type: "application",
        filePath: filePath as string,
      }),
    enabled,
    refetchOnWindowFocus: false,
  });

  const original = useQuery({
    queryKey: [...base, "repo"] as const,
    queryFn: () =>
      patchesApi.readFile({
        id: applicationId,
        type: "application",
        filePath: filePath as string,
        source: "repo",
      }),
    enabled,
    refetchOnWindowFocus: false,
    // A 404 means the repository has no such file, which is the right answer for
    // a `create` patch and not worth two more requests to confirm.
    retry: false,
  });

  return {
    /** What the next build will apply. The editor's own content. */
    data: applied.data,
    /** The repository's copy, or `undefined` when it has none (a 404). */
    original: original.data,
    /** The `applied` read only — the before-side never gates the editor. */
    isPending: applied.isPending,
    error: applied.error,
  };
}
