/** Why Run now is off for a role without `volumeBackup: create`. Shared by
 * every Service's Volume backups list: a Server bucket's and a Compose
 * stack's. */
export const RUN_NOW_REFUSAL =
  "Your role cannot run a volume backup — that needs volume backup create.";

/** Why Restore is off for a role without `volumeBackup: restore`. */
export const RESTORE_REFUSAL =
  "Your role cannot restore a volume — that needs volume backup restore.";
