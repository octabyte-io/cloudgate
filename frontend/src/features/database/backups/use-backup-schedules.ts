import { useMutation } from "@tanstack/react-query";

import {
  backupsApi,
  type CreateBackupInput,
  type UpdateBackupInput,
} from "@/lib/api/endpoints/backups";
import type { DatabaseKind } from "@/lib/api/endpoints/databases";
import { useInvalidate } from "@/lib/api/use-invalidate";

/**
 * The three writes a backup schedule needs.
 *
 * They sit beside the card that uses them rather than in `use-database.ts`, the
 * way `application/advanced/use-advanced.ts` sits beside `volume-backups-spec.tsx`:
 * the two reads on a database's backups (`useBackups`, `useBackupFiles`) are
 * shared with the restore flow and the files card, and these three are the form's
 * alone.
 *
 * **The invalidation is deliberately the database's own subtree**, not a key of
 * their own — `useBackups` caches under
 * `keys.databases.detail(org, kind, databaseId)` plus `"backups"`, so
 * `invalidate.database({ kind, databaseId })` is already the fan-out that covers
 * it, and a schedule that has just been added, edited or removed refreshes with
 * the row it hangs off.
 *
 * `onSuccess` rather than `onSettled`, unlike the lifecycle actions in
 * `use-database.ts`: none of these three converges a Swarm service, so none of
 * them can time out in the proxy while carrying on server-side. A failed
 * `POST /backups` really did not write a row.
 */
export function useBackupScheduleMutations(
  kind: DatabaseKind | null,
  databaseId: string,
) {
  const invalidate = useInvalidate();
  const done = () =>
    invalidate.database({ kind: kind ?? undefined, databaseId });

  return {
    create: useMutation({
      mutationFn: (input: CreateBackupInput) => backupsApi.create(input),
      onSuccess: done,
    }),
    update: useMutation({
      mutationFn: (args: { backupId: string; input: UpdateBackupInput }) =>
        backupsApi.update(args.backupId, args.input),
      onSuccess: done,
    }),
    /**
     * **Deletes the row, and nothing in the bucket.** `BackupsService.remove`
     * deletes the `backup` row and unregisters its cron job; the dumps it has
     * already written stay where they are and a restore can still use them.
     */
    remove: useMutation({
      mutationFn: (backupId: string) => backupsApi.remove(backupId),
      onSuccess: done,
    }),
  };
}
