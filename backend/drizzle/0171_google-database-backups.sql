ALTER TABLE "postgres" ADD COLUMN "cloud_sql_applied" jsonb;--> statement-breakpoint
ALTER TABLE "redis" ADD COLUMN "memorystore_backup_retention_days" integer DEFAULT 1 NOT NULL;