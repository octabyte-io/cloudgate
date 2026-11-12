CREATE TYPE "public"."deployment_status" AS ENUM('pending', 'running', 'done', 'error', 'cancelled');--> statement-breakpoint
CREATE TABLE "deployment" (
	"deployment_id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" "deployment_status" DEFAULT 'pending' NOT NULL,
	"log_path" text NOT NULL,
	"application_id" text NOT NULL,
	"created_at" text NOT NULL,
	"started_at" text,
	"finished_at" text
);
--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_application_id_application_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("application_id") ON DELETE cascade ON UPDATE no action;