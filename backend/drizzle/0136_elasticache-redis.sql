ALTER TABLE "infrastructure_state_record" DROP CONSTRAINT "infrastructure_state_record_one_owner";--> statement-breakpoint
ALTER TABLE "deployment" DROP CONSTRAINT "deployment_at_most_one_parent";--> statement-breakpoint
ALTER TABLE "infrastructure_state_record" ADD COLUMN "redis_id" text;--> statement-breakpoint
ALTER TABLE "redis" ADD COLUMN "cloud_account_id" text;--> statement-breakpoint
ALTER TABLE "redis" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "redis" ADD COLUMN "node_type" text;--> statement-breakpoint
ALTER TABLE "redis" ADD COLUMN "replica" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "redis" ADD COLUMN "snapshot_retention_days" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "redis" ADD COLUMN "auth_token" text;--> statement-breakpoint
ALTER TABLE "redis" ADD COLUMN "elasticache_endpoint" jsonb;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "redis_id" text;--> statement-breakpoint
ALTER TABLE "infrastructure_state_record" ADD CONSTRAINT "infrastructure_state_record_redis_id_redis_redis_id_fk" FOREIGN KEY ("redis_id") REFERENCES "public"."redis"("redis_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redis" ADD CONSTRAINT "redis_cloud_account_id_cloud_account_cloud_account_id_fk" FOREIGN KEY ("cloud_account_id") REFERENCES "public"."cloud_account"("cloud_account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_redis_id_redis_redis_id_fk" FOREIGN KEY ("redis_id") REFERENCES "public"."redis"("redis_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "infrastructure_state_record_redis_unique" ON "infrastructure_state_record" USING btree ("redis_id");--> statement-breakpoint
ALTER TABLE "infrastructure_state_record" ADD CONSTRAINT "infrastructure_state_record_one_owner" CHECK (num_nonnulls("infrastructure_state_record"."application_id", "infrastructure_state_record"."environment_network_id", "infrastructure_state_record"."postgres_id", "infrastructure_state_record"."bucket_id", "infrastructure_state_record"."redis_id") = 1);--> statement-breakpoint
ALTER TABLE "redis" ADD CONSTRAINT "redis_place" CHECK (("redis"."cloud_account_id" IS NULL) = ("redis"."region" IS NULL) AND ("redis"."cloud_account_id" IS NULL OR "redis"."server_id" IS NULL));--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_at_most_one_parent" CHECK (num_nonnulls("application_id", "compose_id", "backup_id", "volume_backup_id", "schedule_id", "environment_network_id", "postgres_id", "bucket_id", "redis_id") <= 1);