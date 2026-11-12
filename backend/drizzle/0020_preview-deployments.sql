CREATE TABLE "preview_deployment" (
	"preview_deployment_id" text PRIMARY KEY NOT NULL,
	"branch" text NOT NULL,
	"pull_request_id" text NOT NULL,
	"pull_request_number" text NOT NULL,
	"pull_request_title" text NOT NULL,
	"pull_request_url" text NOT NULL,
	"app_name" text NOT NULL,
	"domain" text NOT NULL,
	"preview_status" "application_status" DEFAULT 'idle' NOT NULL,
	"created_at" text NOT NULL,
	"application_id" text NOT NULL,
	CONSTRAINT "preview_deployment_app_name_unique" UNIQUE("app_name")
);
--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "is_preview_deployments_active" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "preview_wildcard" text;--> statement-breakpoint
ALTER TABLE "preview_deployment" ADD CONSTRAINT "preview_deployment_application_id_application_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("application_id") ON DELETE cascade ON UPDATE no action;