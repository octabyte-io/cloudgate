-- Every Service carries a Config name: the fixed key a Project config
-- uses for it, apart from the display name and never following its rename
-- (CONTEXT.md, "Config name"). New Services are minted one at create by
-- `environments/config-name.ts`' `mintServiceConfigName`; this migration
-- mints one for every Service that already exists.
--
-- drizzle-kit's output adds the column `NOT NULL` in one step, which aborts on
-- any install that has a Service. So the column is added nullable, the
-- backfill fills it, and only then is it made non-null, unique per
-- Environment and held to the format — the index and check statements at the
-- end are drizzle-kit's own, unedited.
--
-- The backfill, per Environment, takes every Service of all eight kinds
-- **oldest first** (`created_at`, then the kind, then the id, so a tie has one
-- answer on every run) and gives each the slug of its display name — lowercased,
-- each run of anything but `a-z0-9` one hyphen, hyphens trimmed, cut to 63 —
-- or `-2`, `-3`, … when that is taken in the Environment by then. A name that
-- slugs to nothing is named after its kind, and one that would start with a
-- digit gets the kind in front. That is `mintConfigName` spelled in SQL, and
-- the two must agree; `test/environments/config-name.spec.ts` pins the TS one
-- and `config-name-backfill.e2e-spec.ts` this one.
--
-- The backfill is idempotent: it only names a Service whose name is null, and
-- counts every name already given as taken.
ALTER TABLE "application" ADD COLUMN "config_name" text;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "config_name" text;--> statement-breakpoint
ALTER TABLE "libsql" ADD COLUMN "config_name" text;--> statement-breakpoint
ALTER TABLE "mariadb" ADD COLUMN "config_name" text;--> statement-breakpoint
ALTER TABLE "mongo" ADD COLUMN "config_name" text;--> statement-breakpoint
ALTER TABLE "mysql" ADD COLUMN "config_name" text;--> statement-breakpoint
ALTER TABLE "postgres" ADD COLUMN "config_name" text;--> statement-breakpoint
ALTER TABLE "redis" ADD COLUMN "config_name" text;--> statement-breakpoint
DO $$
<<mint_config_names>>
DECLARE
  svc record;
  base text;
  candidate text;
  n integer;
BEGIN
  FOR svc IN
    SELECT s.kind, s.id, s.name, s.environment_id
      FROM (
        SELECT 'application' AS kind, application_id AS id, name, environment_id, created_at, config_name FROM "application"
        UNION ALL SELECT 'compose', compose_id, name, environment_id, created_at, config_name FROM "compose"
        UNION ALL SELECT 'libsql', libsql_id, name, environment_id, created_at, config_name FROM "libsql"
        UNION ALL SELECT 'mariadb', mariadb_id, name, environment_id, created_at, config_name FROM "mariadb"
        UNION ALL SELECT 'mongo', mongo_id, name, environment_id, created_at, config_name FROM "mongo"
        UNION ALL SELECT 'mysql', mysql_id, name, environment_id, created_at, config_name FROM "mysql"
        UNION ALL SELECT 'postgres', postgres_id, name, environment_id, created_at, config_name FROM "postgres"
        UNION ALL SELECT 'redis', redis_id, name, environment_id, created_at, config_name FROM "redis"
      ) s
     WHERE s.config_name IS NULL
     ORDER BY s.environment_id, s.created_at, s.kind, s.id
  LOOP
    base := regexp_replace(
      regexp_replace(lower(svc.name), '[^a-z0-9]+', '-', 'g'),
      '^-+|-+$', '', 'g');
    IF base = '' THEN
      base := svc.kind;
    ELSIF base ~ '^[0-9]' THEN
      base := svc.kind || '-' || base;
    END IF;
    base := regexp_replace(left(base, 63), '-+$', '');
    candidate := base;
    n := 1;
    WHILE EXISTS (
      SELECT 1 FROM (
        SELECT environment_id, config_name FROM "application"
        UNION ALL SELECT environment_id, config_name FROM "compose"
        UNION ALL SELECT environment_id, config_name FROM "libsql"
        UNION ALL SELECT environment_id, config_name FROM "mariadb"
        UNION ALL SELECT environment_id, config_name FROM "mongo"
        UNION ALL SELECT environment_id, config_name FROM "mysql"
        UNION ALL SELECT environment_id, config_name FROM "postgres"
        UNION ALL SELECT environment_id, config_name FROM "redis"
      ) taken
       WHERE taken.environment_id = svc.environment_id
         AND taken.config_name = candidate
    ) LOOP
      n := n + 1;
      candidate := regexp_replace(
        left(base, 63 - length('-' || n)), '-+$', '') || '-' || n;
    END LOOP;
    EXECUTE format(
      'UPDATE %I SET config_name = $1 WHERE %I = $2',
      svc.kind, svc.kind || '_id')
      USING candidate, svc.id;
  END LOOP;
END mint_config_names
$$;
--> statement-breakpoint
ALTER TABLE "application" ALTER COLUMN "config_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "compose" ALTER COLUMN "config_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "libsql" ALTER COLUMN "config_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mariadb" ALTER COLUMN "config_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mongo" ALTER COLUMN "config_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mysql" ALTER COLUMN "config_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "postgres" ALTER COLUMN "config_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "redis" ALTER COLUMN "config_name" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "application_environment_config_name_unique" ON "application" USING btree ("environment_id","config_name");--> statement-breakpoint
CREATE UNIQUE INDEX "compose_environment_config_name_unique" ON "compose" USING btree ("environment_id","config_name");--> statement-breakpoint
CREATE UNIQUE INDEX "libsql_environment_config_name_unique" ON "libsql" USING btree ("environment_id","config_name");--> statement-breakpoint
CREATE UNIQUE INDEX "mariadb_environment_config_name_unique" ON "mariadb" USING btree ("environment_id","config_name");--> statement-breakpoint
CREATE UNIQUE INDEX "mongo_environment_config_name_unique" ON "mongo" USING btree ("environment_id","config_name");--> statement-breakpoint
CREATE UNIQUE INDEX "mysql_environment_config_name_unique" ON "mysql" USING btree ("environment_id","config_name");--> statement-breakpoint
CREATE UNIQUE INDEX "postgres_environment_config_name_unique" ON "postgres" USING btree ("environment_id","config_name");--> statement-breakpoint
CREATE UNIQUE INDEX "redis_environment_config_name_unique" ON "redis" USING btree ("environment_id","config_name");--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_config_name_format" CHECK ("application"."config_name" ~ '^[a-z][a-z0-9-]{0,62}$');--> statement-breakpoint
ALTER TABLE "compose" ADD CONSTRAINT "compose_config_name_format" CHECK ("compose"."config_name" ~ '^[a-z][a-z0-9-]{0,62}$');--> statement-breakpoint
ALTER TABLE "libsql" ADD CONSTRAINT "libsql_config_name_format" CHECK ("libsql"."config_name" ~ '^[a-z][a-z0-9-]{0,62}$');--> statement-breakpoint
ALTER TABLE "mariadb" ADD CONSTRAINT "mariadb_config_name_format" CHECK ("mariadb"."config_name" ~ '^[a-z][a-z0-9-]{0,62}$');--> statement-breakpoint
ALTER TABLE "mongo" ADD CONSTRAINT "mongo_config_name_format" CHECK ("mongo"."config_name" ~ '^[a-z][a-z0-9-]{0,62}$');--> statement-breakpoint
ALTER TABLE "mysql" ADD CONSTRAINT "mysql_config_name_format" CHECK ("mysql"."config_name" ~ '^[a-z][a-z0-9-]{0,62}$');--> statement-breakpoint
ALTER TABLE "postgres" ADD CONSTRAINT "postgres_config_name_format" CHECK ("postgres"."config_name" ~ '^[a-z][a-z0-9-]{0,62}$');--> statement-breakpoint
ALTER TABLE "redis" ADD CONSTRAINT "redis_config_name_format" CHECK ("redis"."config_name" ~ '^[a-z][a-z0-9-]{0,62}$');
