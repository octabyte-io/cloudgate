CREATE TABLE "forward_auth_settings" (
	"forward_auth_settings_id" text PRIMARY KEY NOT NULL,
	"auth_domain" text NOT NULL,
	"base_domain" text NOT NULL,
	"https" boolean DEFAULT true NOT NULL,
	"certificate_type" "certificate_type" DEFAULT 'letsencrypt' NOT NULL,
	"custom_cert_resolver" text,
	"provider_id" text,
	"server_id" text,
	"created_at" text NOT NULL,
	CONSTRAINT "forward_auth_settings_server_id_unique" UNIQUE("server_id")
);
--> statement-breakpoint
CREATE TABLE "sso_provider" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"oidc_config" text,
	"saml_config" text,
	"provider_id" text NOT NULL,
	"user_id" text,
	"organization_id" text,
	"domain" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sso_provider_provider_id_unique" UNIQUE("provider_id")
);
--> statement-breakpoint
ALTER TABLE "forward_auth_settings" ADD CONSTRAINT "forward_auth_settings_provider_id_sso_provider_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."sso_provider"("provider_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forward_auth_settings" ADD CONSTRAINT "forward_auth_settings_server_id_server_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("server_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_provider" ADD CONSTRAINT "sso_provider_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_provider" ADD CONSTRAINT "sso_provider_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "forward_auth_settings_local_unique" ON "forward_auth_settings" USING btree ("server_id") WHERE "forward_auth_settings"."server_id" is null;