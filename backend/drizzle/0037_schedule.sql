CREATE TYPE "public"."schedule_type" AS ENUM('application', 'compose', 'server', 'cloudgate-server');--> statement-breakpoint
CREATE TYPE "public"."shell_type" AS ENUM('bash', 'sh');--> statement-breakpoint
CREATE TABLE "schedule" (
	"schedule_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"cron_expression" text NOT NULL,
	"app_name" text NOT NULL,
	"service_name" text,
	"shell_type" "shell_type" DEFAULT 'bash' NOT NULL,
	"schedule_type" "schedule_type" DEFAULT 'application' NOT NULL,
	"command" text NOT NULL,
	"script" text,
	"application_id" text,
	"compose_id" text,
	"server_id" text,
	"organization_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"timezone" text,
	"created_at" text NOT NULL,
	CONSTRAINT "schedule_app_name_unique" UNIQUE("app_name")
);
--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "schedule_id" text;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_application_id_application_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("application_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_compose_id_compose_compose_id_fk" FOREIGN KEY ("compose_id") REFERENCES "public"."compose"("compose_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_server_id_server_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("server_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_schedule_id_schedule_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedule"("schedule_id") ON DELETE cascade ON UPDATE no action;