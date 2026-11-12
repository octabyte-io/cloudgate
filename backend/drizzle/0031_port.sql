CREATE TYPE "public"."protocol_type" AS ENUM('tcp', 'udp');--> statement-breakpoint
CREATE TYPE "public"."publish_mode_type" AS ENUM('ingress', 'host');--> statement-breakpoint
CREATE TABLE "port" (
	"port_id" text PRIMARY KEY NOT NULL,
	"published_port" integer NOT NULL,
	"publish_mode" "publish_mode_type" DEFAULT 'host' NOT NULL,
	"target_port" integer NOT NULL,
	"protocol" "protocol_type" NOT NULL,
	"application_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "port" ADD CONSTRAINT "port_application_id_application_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("application_id") ON DELETE cascade ON UPDATE no action;