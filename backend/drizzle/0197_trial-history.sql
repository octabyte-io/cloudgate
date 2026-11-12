CREATE TYPE "public"."trial_history_kind" AS ENUM('email', 'card');--> statement-breakpoint
CREATE TABLE "trial_history" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "trial_history_kind" NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "trial_history_kind_value_unique" UNIQUE("kind","value")
);
--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "first_subscribed_at" timestamp (3);--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "trial_ends_at" timestamp (3);--> statement-breakpoint
-- An Organization that holds, or once held, a subscription has used its one
-- free trial: one with a subscription, a Stripe status, or a lapse
-- recorded. The moment it began is kept nowhere the schema can read.
UPDATE "subscription" SET "first_subscribed_at" = coalesce("updated_at", "created_at") WHERE "stripe_subscription_id" IS NOT NULL OR "status" IS NOT NULL OR "lapsed_at" IS NOT NULL;
