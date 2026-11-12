ALTER TABLE "infrastructure_state_record" DROP CONSTRAINT "infrastructure_state_record_one_owner";--> statement-breakpoint
ALTER TABLE "deployment" DROP CONSTRAINT "deployment_at_most_one_parent";--> statement-breakpoint
ALTER TABLE "infrastructure_state_record" ADD COLUMN "postgres_id" text;--> statement-breakpoint
ALTER TABLE "postgres" ADD COLUMN "cloud_account_id" text;--> statement-breakpoint
ALTER TABLE "postgres" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "postgres" ADD COLUMN "instance_class" text;--> statement-breakpoint
ALTER TABLE "postgres" ADD COLUMN "storage_gb" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "postgres" ADD COLUMN "max_storage_gb" integer DEFAULT 200 NOT NULL;--> statement-breakpoint
ALTER TABLE "postgres" ADD COLUMN "multi_az" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "postgres" ADD COLUMN "backup_retention_days" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "postgres_id" text;--> statement-breakpoint
ALTER TABLE "infrastructure_state_record" ADD CONSTRAINT "infrastructure_state_record_postgres_id_postgres_postgres_id_fk" FOREIGN KEY ("postgres_id") REFERENCES "public"."postgres"("postgres_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postgres" ADD CONSTRAINT "postgres_cloud_account_id_cloud_account_cloud_account_id_fk" FOREIGN KEY ("cloud_account_id") REFERENCES "public"."cloud_account"("cloud_account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_postgres_id_postgres_postgres_id_fk" FOREIGN KEY ("postgres_id") REFERENCES "public"."postgres"("postgres_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "infrastructure_state_record_postgres_unique" ON "infrastructure_state_record" USING btree ("postgres_id");--> statement-breakpoint
ALTER TABLE "infrastructure_state_record" ADD CONSTRAINT "infrastructure_state_record_one_owner" CHECK (num_nonnulls("infrastructure_state_record"."application_id", "infrastructure_state_record"."environment_network_id", "infrastructure_state_record"."postgres_id") = 1);--> statement-breakpoint
ALTER TABLE "postgres" ADD CONSTRAINT "postgres_place" CHECK (("postgres"."cloud_account_id" IS NULL) = ("postgres"."region" IS NULL) AND ("postgres"."cloud_account_id" IS NULL OR "postgres"."server_id" IS NULL));--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_at_most_one_parent" CHECK (num_nonnulls("application_id", "compose_id", "backup_id", "volume_backup_id", "schedule_id", "environment_network_id", "postgres_id") <= 1);