ALTER TABLE "mysql" ADD COLUMN "native_gcp" jsonb;--> statement-breakpoint
ALTER TABLE "mysql" ADD COLUMN "cloud_sql_endpoint" text;--> statement-breakpoint
ALTER TABLE "mysql" ADD COLUMN "cloud_sql_applied" jsonb;