ALTER TABLE "license_key" ADD COLUMN "expiry_warned_14_for" timestamp (3);--> statement-breakpoint
ALTER TABLE "license_key" ADD COLUMN "expiry_warned_3_for" timestamp (3);--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "license_expiring" boolean DEFAULT false NOT NULL;