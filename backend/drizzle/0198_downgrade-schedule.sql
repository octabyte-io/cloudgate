ALTER TABLE "subscription" ADD COLUMN "stripe_schedule_id" text;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "downgrade_at" timestamp (3);