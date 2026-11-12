ALTER TABLE "redis" ADD COLUMN "elasticache_applied" jsonb;--> statement-breakpoint
-- A redis already on ElastiCache was made with the settings it holds now.
UPDATE "redis" SET "elasticache_applied" = jsonb_build_object('nodeType', "node_type", 'replica', "replica", 'snapshotRetentionDays', "snapshot_retention_days") WHERE "cloud_account_id" IS NOT NULL;
