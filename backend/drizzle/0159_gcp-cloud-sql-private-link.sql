ALTER TABLE "postgres" ADD COLUMN "cloud_sql_endpoint" text;--> statement-breakpoint
ALTER TABLE "environment_network" ADD COLUMN "private_links" jsonb DEFAULT '[]'::jsonb NOT NULL;