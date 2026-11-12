-- A Project's config location (one row per Project; a Project created
-- before this has none until a later upgrade step generates one), the Plan
-- table with at most one `open` plan per Environment, and `application.port`,
-- the config-owned `web.port` a plan-created Domain will point at.
--
-- Everything above the backfill at the end is drizzle-kit's own, unedited.
CREATE TYPE "public"."plan_source" AS ENUM('push', 'request', 'save', 'move', 'generate');--> statement-breakpoint
CREATE TYPE "public"."plan_status" AS ENUM('open', 'applied', 'partly-applied', 'dismissed', 'superseded', 'unchanged');--> statement-breakpoint
CREATE TYPE "public"."project_config_kind" AS ENUM('cloudgate', 'repository');--> statement-breakpoint
CREATE TABLE "plan" (
	"plan_id" text PRIMARY KEY NOT NULL,
	"environment_id" text NOT NULL,
	"source" "plan_source" NOT NULL,
	"text_hash" text NOT NULL,
	"settings_fingerprint" text NOT NULL,
	"steps" jsonb NOT NULL,
	"notes" jsonb NOT NULL,
	"status" "plan_status" NOT NULL,
	"requested_by" text,
	"created_at" text NOT NULL,
	"applied_by" text,
	"applied_at" text,
	"dismissed_by" text,
	"dismissed_at" text
);
--> statement-breakpoint
CREATE TABLE "project_config_location" (
	"project_id" text PRIMARY KEY NOT NULL,
	"kind" "project_config_kind" NOT NULL,
	"text" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "project_config_location_text_iff_cloudgate" CHECK (("project_config_location"."kind" = 'cloudgate') = ("project_config_location"."text" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "port" integer DEFAULT 3000 NOT NULL;--> statement-breakpoint
ALTER TABLE "plan" ADD CONSTRAINT "plan_environment_id_environment_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("environment_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan" ADD CONSTRAINT "plan_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan" ADD CONSTRAINT "plan_applied_by_user_id_fk" FOREIGN KEY ("applied_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan" ADD CONSTRAINT "plan_dismissed_by_user_id_fk" FOREIGN KEY ("dismissed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_config_location" ADD CONSTRAINT "project_config_location_project_id_project_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plan_one_open_per_environment" ON "plan" USING btree ("environment_id") WHERE "plan"."status" = 'open';--> statement-breakpoint
CREATE INDEX "plan_environment_created_at_idx" ON "plan" USING btree ("environment_id","created_at");--> statement-breakpoint
-- Backfill `application.port` from the Application's Domains when they all
-- agree on one (a Domain with no port is the 3000 the column defaults to), so
-- a generated config's `port` matches what the Application already serves on.
-- An Application with no Domain, or Domains on several ports, keeps 3000:
-- there is no one port to say, and the Domains themselves are Cloudgate's and
-- untouched either way. Idempotent: a re-run writes the same values.
UPDATE "application" AS a
SET "port" = agreed."port"
FROM (
  SELECT "application_id", MIN(COALESCE("port", 3000)) AS "port"
  FROM "domain"
  WHERE "application_id" IS NOT NULL
  GROUP BY "application_id"
  HAVING COUNT(DISTINCT COALESCE("port", 3000)) = 1
) AS agreed
WHERE a."application_id" = agreed."application_id";