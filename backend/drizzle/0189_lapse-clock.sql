-- The deletion clock's marks (ADR-0052): the first failed payment Stripe
-- is still retrying, and when the 3-day and 7-day warnings went out.
ALTER TABLE "subscription" ADD COLUMN "payment_failed_at" timestamp (3);--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "lapse_warned_at" timestamp (3);--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "deletion_warned_at" timestamp (3);
