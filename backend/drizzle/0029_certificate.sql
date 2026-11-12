CREATE TABLE "certificate" (
	"certificate_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"certificate_data" text NOT NULL,
	"private_key" text NOT NULL,
	"certificate_path" text NOT NULL,
	"auto_renew" boolean DEFAULT false NOT NULL,
	"certificate_type" "certificate_type" DEFAULT 'custom' NOT NULL,
	"created_at" text NOT NULL,
	"organization_id" text NOT NULL,
	"server_id" text,
	CONSTRAINT "certificate_certificate_path_unique" UNIQUE("certificate_path")
);
--> statement-breakpoint
ALTER TABLE "certificate" ADD CONSTRAINT "certificate_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate" ADD CONSTRAINT "certificate_server_id_server_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("server_id") ON DELETE cascade ON UPDATE no action;