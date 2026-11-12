CREATE TYPE "public"."application_config_kind" AS ENUM('web', 'static', 'worker', 'web-private', 'cron');--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "config_kind" "application_config_kind" DEFAULT 'web' NOT NULL;--> statement-breakpoint
-- Every existing Application keeps the kind its build type gave it.
UPDATE "application" SET "config_kind" = 'static' WHERE "build_type" = 'static';
