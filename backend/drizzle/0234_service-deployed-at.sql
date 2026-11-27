ALTER TABLE "bucket" ADD COLUMN "deployed_at" text;--> statement-breakpoint
ALTER TABLE "libsql" ADD COLUMN "deployed_at" text;--> statement-breakpoint
ALTER TABLE "mariadb" ADD COLUMN "deployed_at" text;--> statement-breakpoint
ALTER TABLE "mongo" ADD COLUMN "deployed_at" text;--> statement-breakpoint
ALTER TABLE "mysql" ADD COLUMN "deployed_at" text;--> statement-breakpoint
ALTER TABLE "postgres" ADD COLUMN "deployed_at" text;--> statement-breakpoint
ALTER TABLE "redis" ADD COLUMN "deployed_at" text;--> statement-breakpoint
-- Back-fill, once (ADR-0093, #181): a row deployed before this column existed has no record of
-- when, so it reads the time this migration runs, not its created_at. A Restore redeploys a
-- Service whose deployed_at is newer than the backup, so the migration time errs toward a
-- redeploy, which is harmless; created_at would read older than a backup taken after a later
-- deploy, and leave older code running under a record of newer. A row never deployed stays null.
UPDATE "bucket" SET "deployed_at" = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') WHERE "application_status" <> 'idle';--> statement-breakpoint
UPDATE "libsql" SET "deployed_at" = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') WHERE "application_status" <> 'idle';--> statement-breakpoint
UPDATE "mariadb" SET "deployed_at" = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') WHERE "application_status" <> 'idle';--> statement-breakpoint
UPDATE "mongo" SET "deployed_at" = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') WHERE "application_status" <> 'idle';--> statement-breakpoint
UPDATE "mysql" SET "deployed_at" = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') WHERE "application_status" <> 'idle';--> statement-breakpoint
UPDATE "postgres" SET "deployed_at" = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') WHERE "application_status" <> 'idle';--> statement-breakpoint
UPDATE "redis" SET "deployed_at" = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') WHERE "application_status" <> 'idle';