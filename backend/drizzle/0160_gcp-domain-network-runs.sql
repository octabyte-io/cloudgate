ALTER TABLE "deployment" ADD COLUMN "for_service_id" text;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "google_certificate_name" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_for_service_id_application_application_id_fk" FOREIGN KEY ("for_service_id") REFERENCES "public"."application"("application_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_for_service_on_a_network_run" CHECK ("for_service_id" IS NULL OR "environment_network_id" IS NOT NULL);