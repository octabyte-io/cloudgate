-- Five tables carry mutually exclusive parent columns with nothing in
-- the database saying so — the five 0063's sweep found and left alone after
-- constraining `patch` and `domain` in `0063_exactly-one-parent-id.sql`. Each
-- constraint's own argument is in the `check()` it is generated from
-- (`deployment.schema.ts`, `mount.schema.ts`, `volume-backup.schema.ts`,
-- `schedule.schema.ts`, `backup.schema.ts`); this file is about the two things
-- only a migration decides — what the *existing* rows are, and what happens to
-- the ones that do not fit.
--
-- **The original framing of `deployment` is wrong at the source, and the fix
-- is the reason this file's first constraint is not the one first proposed.**
-- That proposal calls `deployment` "the third table with the same
-- `applicationId`/`composeId` pair" and proposes 0063's
-- `(application_id IS NULL) <> (compose_id IS NULL)`. `deployment` has **five**
-- nullable parent columns; the sweep reports two because `backup`,
-- `volume_backup` and `schedule` are not service tables. That XOR would have
-- refused every backup, volume-backup and schedule run record in the product —
-- `BackupRunRecorderService.start` spreads an `options.fk` of
-- `{ backupId } | { volumeBackupId } | { scheduleId }`, so both columns the XOR
-- names are null on every row it writes, and a scheduled run is the same shape
-- one caller up. `num_nonnulls(…) <= 1` is what the table actually means.
--
-- ---------------------------------------------------------------------------
-- What the existing rows can be. Checked against this repository's history,
-- because `ADD CONSTRAINT` validates every row already stored and 0063's
-- lesson is that a migration which assumes today's DTO shape aborts on
-- somebody's database rather than on ours.
-- ---------------------------------------------------------------------------
--
-- **The four discriminated tables have never been able to disagree with their
-- discriminant, and three separate facts say so.** (1) Every one of
-- `mount` (0033), `backup` (0035), `volume_backup` (0036) and `schedule`
-- (0037) was created with its discriminant *and* every parent column in one
-- `CREATE TABLE` — no column was added later under a `DEFAULT` that could have
-- stamped a wrong discriminant onto rows that predated it, which is the usual
-- way this state arrives. (2) No version of `mount.dto.ts`,
-- `volume-backup.dto.ts`, `schedule.dto.ts` or `backup.dto.ts` in this
-- repository has ever published a parent foreign key as a wire field: all four
-- fold them into `serviceId` plus a discriminant on create and omit them on
-- update, which is the property `test/coding-standards/parent-id-writes.spec.ts`
-- records as the shape to copy. (3) Every insert writes the discriminant and
-- `[FK_FIELD[discriminant]]: serviceId` into the *same* object literal, from
-- the same value — `MountsService.insertMount`, `VolumeBackupsService.create`,
-- `SchedulesService.create`, `BackupsService.create` — and every update spreads
-- a DTO that omits both. So a disagreeing row needs a hand-run `UPDATE`.
--
-- **`deployment` cannot hold a two-parent row from its column history either.**
-- `application_id` was `NOT NULL` until 0027, so every row older than that
-- carries exactly one parent; `compose_id` (0027), `backup_id` (0035),
-- `volume_backup_id` (0036) and `schedule_id` (0037) each arrived as a nullable
-- `ADD COLUMN` with no default, so no existing row gained a second key. The
-- three service-layer writers name one column each. What is *not* ruled out is
-- `DeploymentsService.create`: its `CreateDeploymentInput` declares
-- `applicationId?` and `composeId?` independently and the insert writes both as
-- `?? null`, so a third caller passing both would have stored both. Both
-- callers today pass one. The normalization below is for that shape.
--
-- ---------------------------------------------------------------------------
-- What the normalization does, and the one case it deliberately leaves to
-- abort.
-- ---------------------------------------------------------------------------
--
-- Each `UPDATE` clears the parent columns the row's own discriminant does not
-- name, and **only for rows where the named column is set**. That predicate is
-- the whole of it. A row whose discriminant names a column that *is* set is one
-- every reader already resolves correctly — `serviceIdOf` on all four of those
-- tables reads the discriminant's column and nothing else — so clearing the
-- strays changes what no read path returns, and takes the row off a Service
-- that never authorized it: off a `listByService` listing (which keys on the
-- raw column, not the discriminant, so a stray really does show a mount or a
-- volume backup under the wrong engine) and out of that Service's `ON DELETE
-- CASCADE`. It is 0063's `compose_id` argument applied one table at a time —
-- narrow the row to the parent the application already believes it has, rather
-- than delete a row nobody can restore.
--
-- **A row whose discriminant names a column that is NULL is left alone, and the
-- `ADD CONSTRAINT` will abort on it.** That is the choice, not an oversight.
-- There is nothing to normalize *to*: if `service_type` says `postgres` and
-- only `redis_id` is set, no statement here can tell whether the discriminant
-- or the key is the wrong one, and guessing re-points somebody's mount, volume
-- backup, cron script or database dump at a service they did not choose. An
-- upgrade that stops with a named constraint and an untouched database is
-- recoverable by an operator who can see both columns; a silent re-parent is
-- not. No path in this repository produces such a row (above), so the abort is
-- reserved for a database somebody has already edited by hand.
--
-- Every `UPDATE` is idempotent: run twice, the second matches no row and
-- reports `UPDATE 0`.
--
-- `deployment`'s `UPDATE` keeps the **highest-precedence** owner and clears the
-- rest, where the precedence is `service-scope.ts`' `ownerOf` — application,
-- compose, schedule, volume backup, backup — which is the order the console's
-- two deployment feeds have always titled such a row by. `ownedServiceId()`
-- coalesces the same five columns in the same order. All five assignments read
-- the row's *old* values, so the statement is order-independent within itself.
UPDATE "deployment"
   SET "compose_id" = CASE WHEN "application_id" IS NULL
                           THEN "compose_id" END,
       "schedule_id" = CASE WHEN "application_id" IS NULL
                             AND "compose_id" IS NULL
                            THEN "schedule_id" END,
       "volume_backup_id" = CASE WHEN "application_id" IS NULL
                                  AND "compose_id" IS NULL
                                  AND "schedule_id" IS NULL
                                 THEN "volume_backup_id" END,
       "backup_id" = CASE WHEN "application_id" IS NULL
                           AND "compose_id" IS NULL
                           AND "schedule_id" IS NULL
                           AND "volume_backup_id" IS NULL
                          THEN "backup_id" END
 WHERE num_nonnulls(
         "application_id", "compose_id", "backup_id",
         "volume_backup_id", "schedule_id"
       ) > 1;
--> statement-breakpoint
UPDATE "mount"
   SET "application_id" = CASE WHEN "service_type" = 'application' THEN "application_id" END,
       "compose_id"     = CASE WHEN "service_type" = 'compose'     THEN "compose_id" END,
       "libsql_id"      = CASE WHEN "service_type" = 'libsql'      THEN "libsql_id" END,
       "mariadb_id"     = CASE WHEN "service_type" = 'mariadb'     THEN "mariadb_id" END,
       "mongo_id"       = CASE WHEN "service_type" = 'mongo'       THEN "mongo_id" END,
       "mysql_id"       = CASE WHEN "service_type" = 'mysql'       THEN "mysql_id" END,
       "postgres_id"    = CASE WHEN "service_type" = 'postgres'    THEN "postgres_id" END,
       "redis_id"       = CASE WHEN "service_type" = 'redis'       THEN "redis_id" END
 WHERE (CASE "service_type"
          WHEN 'application' THEN "application_id"
          WHEN 'compose'     THEN "compose_id"
          WHEN 'libsql'      THEN "libsql_id"
          WHEN 'mariadb'     THEN "mariadb_id"
          WHEN 'mongo'       THEN "mongo_id"
          WHEN 'mysql'       THEN "mysql_id"
          WHEN 'postgres'    THEN "postgres_id"
          WHEN 'redis'       THEN "redis_id"
        END) IS NOT NULL
   AND num_nonnulls(
         "application_id", "compose_id", "libsql_id", "mariadb_id",
         "mongo_id", "mysql_id", "postgres_id", "redis_id"
       ) > 1;
--> statement-breakpoint
UPDATE "volume_backup"
   SET "application_id" = CASE WHEN "service_type" = 'application' THEN "application_id" END,
       "compose_id"     = CASE WHEN "service_type" = 'compose'     THEN "compose_id" END,
       "libsql_id"      = CASE WHEN "service_type" = 'libsql'      THEN "libsql_id" END,
       "mariadb_id"     = CASE WHEN "service_type" = 'mariadb'     THEN "mariadb_id" END,
       "mongo_id"       = CASE WHEN "service_type" = 'mongo'       THEN "mongo_id" END,
       "mysql_id"       = CASE WHEN "service_type" = 'mysql'       THEN "mysql_id" END,
       "postgres_id"    = CASE WHEN "service_type" = 'postgres'    THEN "postgres_id" END,
       "redis_id"       = CASE WHEN "service_type" = 'redis'       THEN "redis_id" END
 WHERE (CASE "service_type"
          WHEN 'application' THEN "application_id"
          WHEN 'compose'     THEN "compose_id"
          WHEN 'libsql'      THEN "libsql_id"
          WHEN 'mariadb'     THEN "mariadb_id"
          WHEN 'mongo'       THEN "mongo_id"
          WHEN 'mysql'       THEN "mysql_id"
          WHEN 'postgres'    THEN "postgres_id"
          WHEN 'redis'       THEN "redis_id"
        END) IS NOT NULL
   AND num_nonnulls(
         "application_id", "compose_id", "libsql_id", "mariadb_id",
         "mongo_id", "mysql_id", "postgres_id", "redis_id"
       ) > 1;
--> statement-breakpoint
UPDATE "schedule"
   SET "application_id"  = CASE WHEN "schedule_type" = 'application'      THEN "application_id" END,
       "compose_id"      = CASE WHEN "schedule_type" = 'compose'          THEN "compose_id" END,
       "server_id"       = CASE WHEN "schedule_type" = 'server'           THEN "server_id" END,
       "organization_id" = CASE WHEN "schedule_type" = 'cloudgate-server' THEN "organization_id" END
 WHERE (CASE "schedule_type"
          WHEN 'application'      THEN "application_id"
          WHEN 'compose'          THEN "compose_id"
          WHEN 'server'           THEN "server_id"
          WHEN 'cloudgate-server' THEN "organization_id"
        END) IS NOT NULL
   AND num_nonnulls(
         "application_id", "compose_id", "server_id", "organization_id"
       ) > 1;
--> statement-breakpoint
-- `backup`'s discriminant is the `backup_type`/`database_type` pair, so every
-- engine arm carries `backup_type <> 'compose'` as well: on a compose backup
-- `database_type` is still `NOT NULL` and still names the engine dumped
-- *inside* the stack, so an arm keyed on `database_type` alone would keep an
-- engine key on a row whose owner is the stack. `BackupsService`' `serviceIdOf`
-- tests `backup_type` first for the same reason.
UPDATE "backup"
   SET "compose_id"  = CASE WHEN "backup_type" = 'compose' THEN "compose_id" END,
       "postgres_id" = CASE WHEN "backup_type" <> 'compose' AND "database_type" = 'postgres' THEN "postgres_id" END,
       "mariadb_id"  = CASE WHEN "backup_type" <> 'compose' AND "database_type" = 'mariadb'  THEN "mariadb_id" END,
       "mysql_id"    = CASE WHEN "backup_type" <> 'compose' AND "database_type" = 'mysql'    THEN "mysql_id" END,
       "mongo_id"    = CASE WHEN "backup_type" <> 'compose' AND "database_type" = 'mongo'    THEN "mongo_id" END,
       "libsql_id"   = CASE WHEN "backup_type" <> 'compose' AND "database_type" = 'libsql'   THEN "libsql_id" END
 WHERE (CASE
          WHEN "backup_type" = 'compose'    THEN "compose_id"
          WHEN "database_type" = 'postgres' THEN "postgres_id"
          WHEN "database_type" = 'mariadb'  THEN "mariadb_id"
          WHEN "database_type" = 'mysql'    THEN "mysql_id"
          WHEN "database_type" = 'mongo'    THEN "mongo_id"
          WHEN "database_type" = 'libsql'   THEN "libsql_id"
        END) IS NOT NULL
   AND num_nonnulls(
         "compose_id", "postgres_id", "mariadb_id",
         "mysql_id", "mongo_id", "libsql_id"
       ) > 1;
--> statement-breakpoint
-- The five `ALTER`s below are `drizzle-kit generate`'s own output, unedited.
-- `--name` wrote both the §2.6 filename and the matching `_journal.json` tag,
-- so no rename was needed.
ALTER TABLE "backup" ADD CONSTRAINT "backup_parent_matches_type" CHECK (num_nonnulls("compose_id", "postgres_id", "mariadb_id", "mysql_id", "mongo_id", "libsql_id") = 1
    AND (CASE
           WHEN "backup_type" = 'compose'     THEN "compose_id"
           WHEN "database_type" = 'postgres'  THEN "postgres_id"
           WHEN "database_type" = 'mariadb'   THEN "mariadb_id"
           WHEN "database_type" = 'mysql'     THEN "mysql_id"
           WHEN "database_type" = 'mongo'     THEN "mongo_id"
           WHEN "database_type" = 'libsql'    THEN "libsql_id"
         END) IS NOT NULL);--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_at_most_one_parent" CHECK (num_nonnulls("application_id", "compose_id", "backup_id", "volume_backup_id", "schedule_id") <= 1);--> statement-breakpoint
ALTER TABLE "mount" ADD CONSTRAINT "mount_parent_matches_service_type" CHECK (num_nonnulls("application_id", "compose_id", "libsql_id", "mariadb_id", "mongo_id", "mysql_id", "postgres_id", "redis_id") = 1
    AND (CASE "service_type"
           WHEN 'application' THEN "application_id"
           WHEN 'compose'     THEN "compose_id"
           WHEN 'libsql'      THEN "libsql_id"
           WHEN 'mariadb'     THEN "mariadb_id"
           WHEN 'mongo'       THEN "mongo_id"
           WHEN 'mysql'       THEN "mysql_id"
           WHEN 'postgres'    THEN "postgres_id"
           WHEN 'redis'       THEN "redis_id"
         END) IS NOT NULL);--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_parent_matches_schedule_type" CHECK (num_nonnulls("application_id", "compose_id", "server_id", "organization_id") = 1
    AND (CASE "schedule_type"
           WHEN 'application'      THEN "application_id"
           WHEN 'compose'          THEN "compose_id"
           WHEN 'server'           THEN "server_id"
           WHEN 'cloudgate-server' THEN "organization_id"
         END) IS NOT NULL);--> statement-breakpoint
ALTER TABLE "volume_backup" ADD CONSTRAINT "volume_backup_parent_matches_service_type" CHECK (num_nonnulls("application_id", "compose_id", "libsql_id", "mariadb_id", "mongo_id", "mysql_id", "postgres_id", "redis_id") = 1
    AND (CASE "service_type"
           WHEN 'application' THEN "application_id"
           WHEN 'compose'     THEN "compose_id"
           WHEN 'libsql'      THEN "libsql_id"
           WHEN 'mariadb'     THEN "mariadb_id"
           WHEN 'mongo'       THEN "mongo_id"
           WHEN 'mysql'       THEN "mysql_id"
           WHEN 'postgres'    THEN "postgres_id"
           WHEN 'redis'       THEN "redis_id"
         END) IS NOT NULL);