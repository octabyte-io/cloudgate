CREATE TYPE "public"."certificate_type" AS ENUM('letsencrypt', 'none', 'custom');--> statement-breakpoint
CREATE TYPE "public"."domain_type" AS ENUM('compose', 'application', 'preview');--> statement-breakpoint
CREATE TABLE "domain" (
	"domain_id" text PRIMARY KEY NOT NULL,
	"host" text NOT NULL,
	"https" boolean DEFAULT false NOT NULL,
	"port" integer DEFAULT 3000,
	"path" text DEFAULT '/',
	"internal_path" text DEFAULT '/',
	"strip_path" boolean DEFAULT false NOT NULL,
	"service_name" text,
	"domain_type" "domain_type" DEFAULT 'application',
	"unique_config_key" serial NOT NULL,
	"certificate_type" "certificate_type" DEFAULT 'none' NOT NULL,
	"custom_cert_resolver" text,
	"custom_entrypoint" text,
	"middlewares" text[] DEFAULT ARRAY[]::text[],
	"forward_auth_enabled" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL,
	"application_id" text,
	"compose_id" text
);
--> statement-breakpoint
ALTER TABLE "domain" ADD CONSTRAINT "domain_application_id_application_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("application_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain" ADD CONSTRAINT "domain_compose_id_compose_compose_id_fk" FOREIGN KEY ("compose_id") REFERENCES "public"."compose"("compose_id") ON DELETE cascade ON UPDATE no action;