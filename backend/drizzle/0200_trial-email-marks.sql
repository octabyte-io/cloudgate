ALTER TABLE "subscription" ADD COLUMN "trial_started_sent_at" timestamp (3);--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "trial_reminder_sent_at" timestamp (3);--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "trial_charged_at" timestamp (3);--> statement-breakpoint
-- A trial that began before these marks existed has had its "trial started"
-- email's moment, and one whose end has passed its first charge (or its end),
-- so neither is sent late. A trial still running keeps its 7-day
-- reminder.
UPDATE "subscription" SET "trial_started_sent_at" = coalesce("first_subscribed_at", now()) WHERE "trial_ends_at" IS NOT NULL;--> statement-breakpoint
UPDATE "subscription" SET "trial_charged_at" = "trial_ends_at" WHERE "trial_ends_at" IS NOT NULL AND "trial_ends_at" <= now();
