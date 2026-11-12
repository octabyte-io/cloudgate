-- A Preview deployment is made by a pull request or asked for: the
-- Requested preview (ADR-0026). Every existing row is the webhook's, so the
-- trigger's default backfills them `pullRequest`, and their expiry stays null;
-- the check is added last, after both columns exist, and every existing row
-- already satisfies it. An existing Application reads requested previews
-- not allowed through the column's default, the same as a new one.
CREATE TYPE "public"."preview_trigger" AS ENUM('pullRequest', 'requested');--> statement-breakpoint
ALTER TABLE "preview_deployment" ALTER COLUMN "pull_request_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "preview_deployment" ALTER COLUMN "pull_request_number" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "preview_deployment" ALTER COLUMN "pull_request_title" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "preview_deployment" ALTER COLUMN "pull_request_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "requested_previews_allowed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "preview_deployment" ADD COLUMN "trigger" "preview_trigger" DEFAULT 'pullRequest' NOT NULL;--> statement-breakpoint
ALTER TABLE "preview_deployment" ADD COLUMN "requester_id" text;--> statement-breakpoint
ALTER TABLE "preview_deployment" ADD COLUMN "expires_at" text;--> statement-breakpoint
ALTER TABLE "web_server_settings" ADD COLUMN "requested_preview_max_ttl_minutes" integer DEFAULT 1440 NOT NULL;--> statement-breakpoint
ALTER TABLE "preview_deployment" ADD CONSTRAINT "preview_deployment_requester_id_user_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_deployment" ADD CONSTRAINT "preview_deployment_fields_match_trigger" CHECK (("preview_deployment"."trigger" = 'pullRequest' AND "preview_deployment"."pull_request_id" IS NOT NULL AND "preview_deployment"."pull_request_number" IS NOT NULL AND "preview_deployment"."pull_request_title" IS NOT NULL AND "preview_deployment"."pull_request_url" IS NOT NULL AND "preview_deployment"."expires_at" IS NULL) OR ("preview_deployment"."trigger" = 'requested' AND "preview_deployment"."pull_request_id" IS NULL AND "preview_deployment"."pull_request_number" IS NULL AND "preview_deployment"."pull_request_title" IS NULL AND "preview_deployment"."pull_request_url" IS NULL AND "preview_deployment"."expires_at" IS NOT NULL));