ALTER TABLE "infrastructure_state_record" DROP CONSTRAINT "infrastructure_state_record_one_owner";--> statement-breakpoint
ALTER TABLE "deployment" DROP CONSTRAINT "deployment_at_most_one_parent";--> statement-breakpoint
ALTER TABLE "bucket" ADD COLUMN "applied_origins" text[];--> statement-breakpoint
ALTER TABLE "bucket" ADD COLUMN "cloud_account_id" text;--> statement-breakpoint
ALTER TABLE "bucket" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "infrastructure_state_record" ADD COLUMN "bucket_id" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "bucket_id" text;--> statement-breakpoint
ALTER TABLE "bucket" ADD CONSTRAINT "bucket_cloud_account_id_cloud_account_cloud_account_id_fk" FOREIGN KEY ("cloud_account_id") REFERENCES "public"."cloud_account"("cloud_account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infrastructure_state_record" ADD CONSTRAINT "infrastructure_state_record_bucket_id_bucket_bucket_id_fk" FOREIGN KEY ("bucket_id") REFERENCES "public"."bucket"("bucket_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_bucket_id_bucket_bucket_id_fk" FOREIGN KEY ("bucket_id") REFERENCES "public"."bucket"("bucket_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "infrastructure_state_record_bucket_unique" ON "infrastructure_state_record" USING btree ("bucket_id");--> statement-breakpoint
ALTER TABLE "bucket" ADD CONSTRAINT "bucket_place" CHECK (("bucket"."cloud_account_id" IS NULL) = ("bucket"."region" IS NULL) AND ("bucket"."cloud_account_id" IS NULL OR "bucket"."server_id" IS NULL));--> statement-breakpoint
ALTER TABLE "infrastructure_state_record" ADD CONSTRAINT "infrastructure_state_record_one_owner" CHECK (num_nonnulls("infrastructure_state_record"."application_id", "infrastructure_state_record"."environment_network_id", "infrastructure_state_record"."postgres_id", "infrastructure_state_record"."bucket_id") = 1);--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_at_most_one_parent" CHECK (num_nonnulls("application_id", "compose_id", "backup_id", "volume_backup_id", "schedule_id", "environment_network_id", "postgres_id", "bucket_id") <= 1);