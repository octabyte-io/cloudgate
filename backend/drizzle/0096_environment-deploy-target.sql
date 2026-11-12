-- Every Environment has a Deploy target: where a Service a plan creates
-- in it will run, `{ "kind": "server", "serverId": … }` or
-- `{ "kind": "platform-host" }`. A tagged jsonb value, so the `cloud` kind a
-- later slice adds is a new member and not a rewrite of these rows.
--
-- The column default is the platform host, which is also the backfill's answer
-- for an Environment with no Services. Every other Environment takes the run
-- Server most of its Services already use — counted across all eight Service
-- tables, with the platform host (`server_id` null) one of the candidates —
-- so a plan's first create lands beside what is already there. A tie goes to
-- the candidate whose newest Service is the most recent (`created_at` is
-- ISO-8601 text, so it orders as a string), and then to the lower server id
-- so a tie has one answer on every run.
--
-- Nothing else moves: each Service keeps its own run Server.
ALTER TABLE "environment" ADD COLUMN "deploy_target" jsonb DEFAULT '{"kind":"platform-host"}'::jsonb NOT NULL;--> statement-breakpoint
WITH "services" AS (
  SELECT "environment_id", "server_id", "created_at" FROM "application"
  UNION ALL SELECT "environment_id", "server_id", "created_at" FROM "compose"
  UNION ALL SELECT "environment_id", "server_id", "created_at" FROM "postgres"
  UNION ALL SELECT "environment_id", "server_id", "created_at" FROM "mysql"
  UNION ALL SELECT "environment_id", "server_id", "created_at" FROM "mariadb"
  UNION ALL SELECT "environment_id", "server_id", "created_at" FROM "mongo"
  UNION ALL SELECT "environment_id", "server_id", "created_at" FROM "redis"
  UNION ALL SELECT "environment_id", "server_id", "created_at" FROM "libsql"
), "ranked" AS (
  SELECT
    "environment_id",
    "server_id",
    row_number() OVER (
      PARTITION BY "environment_id"
      ORDER BY count(*) DESC, max("created_at") DESC, "server_id" NULLS FIRST
    ) AS "rank"
  FROM "services"
  GROUP BY "environment_id", "server_id"
)
UPDATE "environment"
SET "deploy_target" = jsonb_build_object('kind', 'server', 'serverId', "ranked"."server_id")
FROM "ranked"
WHERE "ranked"."environment_id" = "environment"."environment_id"
  AND "ranked"."rank" = 1
  AND "ranked"."server_id" IS NOT NULL;
