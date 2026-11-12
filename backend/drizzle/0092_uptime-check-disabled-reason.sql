ALTER TYPE "public"."incident_close_reason" ADD VALUE 'port-unpublished';--> statement-breakpoint
ALTER TABLE "uptime_check" ADD COLUMN "disabled_reason" text;--> statement-breakpoint
ALTER TABLE "uptime_check" ADD CONSTRAINT "uptime_check_disabled_reason_only_when_off" CHECK ("disabled_reason" IS NULL OR "enabled" = false);