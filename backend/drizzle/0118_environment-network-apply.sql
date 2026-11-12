CREATE TYPE "public"."environment_network_status" AS ENUM('creating', 'ready', 'create-failed', 'deleting', 'delete-incomplete');--> statement-breakpoint
ALTER TABLE "deployment" DROP CONSTRAINT "deployment_at_most_one_parent";--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "environment_network_id" text;--> statement-breakpoint
ALTER TABLE "environment_network" ADD COLUMN "status" "environment_network_status" DEFAULT 'creating' NOT NULL;--> statement-breakpoint
ALTER TABLE "environment_network" ADD COLUMN "private_subnet_ids" jsonb;--> statement-breakpoint
ALTER TABLE "environment_network" ADD COLUMN "alb_arn" text;--> statement-breakpoint
ALTER TABLE "environment_network" ADD COLUMN "alb_dns_name" text;--> statement-breakpoint
ALTER TABLE "environment_network" ADD COLUMN "alb_zone_id" text;--> statement-breakpoint
ALTER TABLE "environment_network" ADD COLUMN "default_certificate_arn" text;--> statement-breakpoint
ALTER TABLE "environment_network" ADD COLUMN "leftovers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "infrastructure_state_record" ADD CONSTRAINT "infrastructure_state_record_environment_network_id_environment_network_environment_network_id_fk" FOREIGN KEY ("environment_network_id") REFERENCES "public"."environment_network"("environment_network_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_environment_network_id_environment_network_environment_network_id_fk" FOREIGN KEY ("environment_network_id") REFERENCES "public"."environment_network"("environment_network_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_at_most_one_parent" CHECK (num_nonnulls("application_id", "compose_id", "backup_id", "volume_backup_id", "schedule_id", "environment_network_id") <= 1);