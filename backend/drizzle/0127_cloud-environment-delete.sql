ALTER TABLE "environment" ADD COLUMN "cloud_delete" jsonb;--> statement-breakpoint
ALTER TABLE "environment_network" ADD COLUMN "dns_records_left" jsonb DEFAULT '[]'::jsonb NOT NULL;