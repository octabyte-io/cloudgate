ALTER TABLE "postgres" ADD COLUMN "cloud_delete" jsonb;--> statement-breakpoint
ALTER TABLE "redis" ADD COLUMN "cloud_delete" jsonb;