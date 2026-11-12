ALTER TABLE "ai_usage" ADD COLUMN "agent_id" text;--> statement-breakpoint
UPDATE "ai_usage" SET "agent_id" = coalesce("agent_user_id", 'key:' || "apikey_id");--> statement-breakpoint
ALTER TABLE "ai_usage" ALTER COLUMN "agent_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_usage_daily" ADD COLUMN "agent_id" text;--> statement-breakpoint
UPDATE "ai_usage_daily" SET "agent_id" = coalesce("agent_user_id", 'key:' || "apikey_id");--> statement-breakpoint
ALTER TABLE "ai_usage_daily" ALTER COLUMN "agent_id" SET NOT NULL;
