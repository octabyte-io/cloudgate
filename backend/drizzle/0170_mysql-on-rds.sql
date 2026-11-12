ALTER TABLE "infrastructure_state_record" DROP CONSTRAINT "infrastructure_state_record_one_owner";--> statement-breakpoint
ALTER TABLE "existing_database" DROP CONSTRAINT "existing_database_one_service";--> statement-breakpoint
ALTER TABLE "deployment" DROP CONSTRAINT "deployment_at_most_one_parent";--> statement-breakpoint
ALTER TABLE "infrastructure_state_record" ADD COLUMN "mysql_id" text;--> statement-breakpoint
ALTER TABLE "mysql" ADD COLUMN "cloud_account_id" text;--> statement-breakpoint
ALTER TABLE "mysql" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "mysql" ADD COLUMN "instance_class" text;--> statement-breakpoint
ALTER TABLE "mysql" ADD COLUMN "storage_gb" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "mysql" ADD COLUMN "max_storage_gb" integer DEFAULT 200 NOT NULL;--> statement-breakpoint
ALTER TABLE "mysql" ADD COLUMN "multi_az" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mysql" ADD COLUMN "backup_retention_days" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "mysql" ADD COLUMN "rds_applied" jsonb;--> statement-breakpoint
ALTER TABLE "mysql" ADD COLUMN "rds_endpoint" jsonb;--> statement-breakpoint
ALTER TABLE "mysql" ADD COLUMN "restarts_at" text;--> statement-breakpoint
ALTER TABLE "mysql" ADD COLUMN "cloud_delete" jsonb;--> statement-breakpoint
ALTER TABLE "existing_database" ADD COLUMN "mysql_id" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "mysql_id" text;--> statement-breakpoint
ALTER TABLE "infrastructure_state_record" ADD CONSTRAINT "infrastructure_state_record_mysql_id_mysql_mysql_id_fk" FOREIGN KEY ("mysql_id") REFERENCES "public"."mysql"("mysql_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mysql" ADD CONSTRAINT "mysql_cloud_account_id_cloud_account_cloud_account_id_fk" FOREIGN KEY ("cloud_account_id") REFERENCES "public"."cloud_account"("cloud_account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "existing_database" ADD CONSTRAINT "existing_database_mysql_id_mysql_mysql_id_fk" FOREIGN KEY ("mysql_id") REFERENCES "public"."mysql"("mysql_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_mysql_id_mysql_mysql_id_fk" FOREIGN KEY ("mysql_id") REFERENCES "public"."mysql"("mysql_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "infrastructure_state_record_mysql_unique" ON "infrastructure_state_record" USING btree ("mysql_id");--> statement-breakpoint
ALTER TABLE "existing_database" ADD CONSTRAINT "existing_database_mysql_id_unique" UNIQUE("mysql_id");--> statement-breakpoint
ALTER TABLE "infrastructure_state_record" ADD CONSTRAINT "infrastructure_state_record_one_owner" CHECK (num_nonnulls("infrastructure_state_record"."application_id", "infrastructure_state_record"."environment_network_id", "infrastructure_state_record"."postgres_id", "infrastructure_state_record"."mysql_id", "infrastructure_state_record"."bucket_id", "infrastructure_state_record"."redis_id") = 1);--> statement-breakpoint
ALTER TABLE "mysql" ADD CONSTRAINT "mysql_place" CHECK (("mysql"."cloud_account_id" IS NULL) = ("mysql"."region" IS NULL) AND ("mysql"."cloud_account_id" IS NULL OR "mysql"."server_id" IS NULL));--> statement-breakpoint
ALTER TABLE "existing_database" ADD CONSTRAINT "existing_database_one_service" CHECK (num_nonnulls("existing_database"."postgres_id", "existing_database"."mysql_id", "existing_database"."redis_id") = 1);--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_at_most_one_parent" CHECK (num_nonnulls("application_id", "compose_id", "backup_id", "volume_backup_id", "schedule_id", "environment_network_id", "postgres_id", "mysql_id", "bucket_id", "redis_id") <= 1);