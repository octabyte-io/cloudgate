ALTER TABLE "redis" ADD COLUMN "memorystore_high_availability" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "redis" ADD COLUMN "memorystore_applied" jsonb;