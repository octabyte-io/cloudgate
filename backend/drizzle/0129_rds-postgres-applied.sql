ALTER TABLE "postgres" ADD COLUMN "rds_applied" jsonb;--> statement-breakpoint
-- A postgres already on RDS was made with the settings it holds now.
UPDATE "postgres" SET "rds_applied" = jsonb_build_object('instanceClass', "instance_class", 'storageGb', "storage_gb", 'maxStorageGb', "max_storage_gb", 'multiAz', "multi_az", 'backupRetentionDays', "backup_retention_days") WHERE "cloud_account_id" IS NOT NULL;
