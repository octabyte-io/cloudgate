ALTER TABLE "infrastructure_state_record" DROP CONSTRAINT "infrastructure_state_record_one_owner";--> statement-breakpoint
ALTER TABLE "infrastructure_state_record" ADD COLUMN "compose_id" text;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "cloud_account_id" text;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "stack_vm" jsonb;--> statement-breakpoint
ALTER TABLE "infrastructure_state_record" ADD CONSTRAINT "infrastructure_state_record_compose_id_compose_compose_id_fk" FOREIGN KEY ("compose_id") REFERENCES "public"."compose"("compose_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compose" ADD CONSTRAINT "compose_cloud_account_id_cloud_account_cloud_account_id_fk" FOREIGN KEY ("cloud_account_id") REFERENCES "public"."cloud_account"("cloud_account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "infrastructure_state_record_compose_unique" ON "infrastructure_state_record" USING btree ("compose_id");--> statement-breakpoint
ALTER TABLE "infrastructure_state_record" ADD CONSTRAINT "infrastructure_state_record_one_owner" CHECK (num_nonnulls("infrastructure_state_record"."application_id", "infrastructure_state_record"."environment_network_id", "infrastructure_state_record"."postgres_id", "infrastructure_state_record"."mysql_id", "infrastructure_state_record"."bucket_id", "infrastructure_state_record"."redis_id", "infrastructure_state_record"."compose_id") = 1);--> statement-breakpoint
ALTER TABLE "compose" ADD CONSTRAINT "compose_place" CHECK (("compose"."cloud_account_id" IS NULL) = ("compose"."region" IS NULL) AND ("compose"."cloud_account_id" IS NULL OR "compose"."server_id" IS NULL));