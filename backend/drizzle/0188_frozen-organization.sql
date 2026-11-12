-- The Frozen Organization's two causes (ADR-0052): when it lapsed, and
-- the suspension an Operator sets later, with its reason and Operator.
ALTER TABLE "subscription" ADD COLUMN "lapsed_at" timestamp (3);--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "suspended_at" timestamp (3);--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "suspended_reason" text;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "suspended_by" text;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_suspended_by_user_id_fk" FOREIGN KEY ("suspended_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;