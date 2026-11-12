import { api } from "../client";

import type { Destination } from "./destinations";
import type { TeardownReport } from "./teardown";

/**
 * `backups.controller.ts` — a scheduled `pg_dump` / `mysqldump` / `mongodump`
 * piped into an S3 destination, and the restore that reads one back.
 *
 * The route list is `POST /` · `GET /?serviceId=&serviceType=` ·
 * `POST /restore` · `GET /files` · `GET /:id` · `POST /:id/run` · `PATCH /:id` ·
 * `DELETE /:id`, and four things about it decide how a screen is built:
 *
 * 1. **The schedules of one backed-up service list by service, not by
 *    Organization**.
 *    `GET /backups` takes `serviceId` **and** `serviceType` — no engine's
 *    `queryById` loads a `backups` relation, so a database's own row still does
 *    not carry them, and the pair is what picks both the FK filtered on and the
 *    parent table the org scope is resolved through. Before this route a backup
 *    could be created and then never named again; `findOne`, `update`, `run` and
 *    `remove` all needed an id nothing handed out.
 * 2. **The dump files list separately, and they always did.** `GET /files`
 *    shells out to `rclone lsjson` against the destination, so *what has been
 *    backed up* and *what is scheduled* are two reads — the first of the bucket,
 *    the second of the rows. That is the opposite of
 *    the old volume-backup restore, which had to type an object key blind.
 * 3. **Restore does not need a backup row at all.** `POST /restore` takes the
 *    target service, the database name, the object key and the destination, so
 *    any dump in the bucket can go into any database. It is not "restore this
 *    schedule", which is why the restore flow worked end to end while the
 *    schedule list did not exist.
 * 4. **Redis is not a backup target.** `backupDatabaseTypes` is the five engines
 *    with a dump tool; `BACKUP_COMMANDS` has no Redis entry
 *    (`backups/commands/index.ts`). The descriptor carries that, not a screen.
 *
 * A run is recorded as a `deployment` row keyed by `backupId`. There is still no
 * list route keyed on a backup — `GET /schedules/:id/deployments` and
 * `GET /volume-backups/:id/deployments` were added and
 * a database backup got neither — so *"did last night's dump succeed"* has no
 * answer here. The logs of one run **are** readable once its deployment id is
 * known nothing hands the id out.
 */

/** The five engines with a dump command. Redis has none. */
export const BACKUP_DATABASE_TYPES = [
  "postgres",
  "mysql",
  "mariadb",
  "mongo",
  "libsql",
] as const;

export type BackupDatabaseType = (typeof BACKUP_DATABASE_TYPES)[number];

/**
 * What a backup can hang off — the five dumpable engines plus a Compose stack,
 * which are the only `backup` FK columns there are (`backup.schema.ts`).
 *
 * Distinct from `BackupDatabaseType` on purpose: `databaseType` on the row says
 * which *dump tool* runs, and for a compose backup that is the engine inside the
 * stack. `serviceType` on the list route says which *table* owns the row.
 */
export const BACKUP_SERVICE_TYPES = [
  ...BACKUP_DATABASE_TYPES,
  "compose",
] as const;

export type BackupServiceType = (typeof BACKUP_SERVICE_TYPES)[number];

export interface Backup {
  backupId: string;
  /** Names the run-log directory. Server-side. */
  appName: string;
  /** Cron expression. */
  schedule: string;
  enabled: boolean | null;
  /** The database *inside* the engine that gets dumped. */
  database: string;
  /** Path fragment between the service's appName and the dump file. */
  prefix: string;
  serviceName: string | null;
  destinationId: string;
  /** Keep the newest N dumps after each run. Null or 0 keeps every one. */
  keepLatestCount: number | null;
  backupType: "database" | "compose";
  databaseType: BackupDatabaseType;
  createdAt: string;
  /** Exactly one of these six is set — whichever `serviceType` named. */
  composeId: string | null;
  postgresId: string | null;
  mysqlId: string | null;
  mariadbId: string | null;
  mongoId: string | null;
  libsqlId: string | null;
}

/**
 * A backup as the list route reports it: the destination travels with the row,
 * so a schedule list can say where its dumps go without a second read.
 *
 * Nothing credential-bearing comes along, and neither shape above declares one:
 * `Destination` has no `secretAccessKey` because no route sends it, and `Backup`
 * has no `metadata` because the list route projects it away — that column is
 * where a **compose** backup keeps the stack engine's user and password.
 */
export type BackupListItem = Backup & { destination: Destination };

export interface CreateBackupInput {
  schedule: string;
  prefix: string;
  database: string;
  destinationId: string;
  databaseType: BackupDatabaseType;
  /** The engine row's id for a database backup. */
  serviceId: string;
  backupType?: "database" | "compose";
  enabled?: boolean;
  keepLatestCount?: number | null;
  serviceName?: string;
}

/** A backup cannot be re-pointed at another service, so `serviceId` is out. */
export type UpdateBackupInput = Partial<{
  schedule: string;
  enabled: boolean;
  prefix: string;
  database: string;
  keepLatestCount: number | null;
  destinationId: string;
  serviceName: string | null;
}>;

/**
 * **Destructive.** Feeds a dump into the running engine.
 *
 * Every engine's restore command drops as it goes — `mongorestore --drop`,
 * `pg_restore` into an existing database, `mysql <` a dump full of
 * `DROP TABLE`. What is in the database now is replaced by what is in the file.
 */
export interface RestoreBackupInput {
  /** The engine row's id. */
  databaseId: string;
  databaseType: BackupDatabaseType;
  /** The database inside the engine the dump goes into. */
  databaseName: string;
  /** Full S3 object key of the dump, inside the destination's bucket. */
  backupFile: string;
  destinationId: string;
  backupType?: "database" | "compose";
}

/** One object in a destination, as `rclone lsjson` prints it. */
export interface BackupFile {
  /** The key relative to the bucket root, including the directory part. */
  Path: string;
  Name: string;
  Size: number;
  IsDir: boolean;
}

export const backupsApi = {
  /**
   * The backup schedules of one backed-up service, newest first.
   *
   * **Both parameters are required and they are not interchangeable.**
   * `serviceType` decides which FK column is filtered on *and* which table the
   * organization scope is resolved through, so a `postgres` id sent with
   * `serviceType: "compose"` reads as absent rather than as forbidden.
   */
  listByService: (params: {
    serviceId: string;
    serviceType: BackupServiceType;
  }) => api.get<BackupListItem[]>("/backups", { query: params }),

  /**
   * The dump files in a destination, newest-nothing — `rclone lsjson` does not
   * sort, and the route caps the answer at 100.
   *
   * `search` is not a plain filter: everything up to the **last slash** is a
   * directory the listing is narrowed to server-side, and the rest matches the
   * file name. So `storefront-db/nightly/` lists that directory, and
   * `storefront-db/nightly/2026-08` lists it filtered.
   */
  listFiles: (params: {
    destinationId: string;
    search?: string;
    serverId?: string | null;
  }) =>
    api.get<BackupFile[]>("/backups/files", {
      query: {
        destinationId: params.destinationId,
        search: params.search ?? "",
        serverId: params.serverId ?? undefined,
      },
    }),

  /** **Destructive.** See `RestoreBackupInput`. */
  restore: (input: RestoreBackupInput) =>
    api.post<unknown>("/backups/restore", input),

  // ── The four that need a backup id ───────────────────────────────────────
  // `listByService` is where that id comes from (note 1 above). At first it
  // came from nowhere and all four were dead. `create`, `update` and `remove`
  // have a screen
  // — the database Backups tab's schedules card — so every route in this module
  // except `findOne` is now reachable from the console.

  findOne: (backupId: string) => api.get<Backup>(`/backups/${backupId}`),

  create: (input: CreateBackupInput) => api.post<Backup>("/backups", input),

  update: (backupId: string, input: UpdateBackupInput) =>
    api.patch<Backup>(`/backups/${backupId}`, input),

  run: (backupId: string) => api.post<unknown>(`/backups/${backupId}/run`),

  remove: (backupId: string) =>
    api.delete<Backup & Pick<TeardownReport, "unreclaimedArtifacts">>(
      `/backups/${backupId}`,
    ),
};
