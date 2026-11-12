ALTER TABLE "existing_database" ADD COLUMN "service_attachments" jsonb;--> statement-breakpoint
ALTER TABLE "existing_database" ADD COLUMN "endpoints" jsonb;--> statement-breakpoint
ALTER TABLE "existing_database" ADD COLUMN "registration_status" text;