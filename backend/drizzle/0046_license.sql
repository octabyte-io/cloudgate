CREATE TYPE "public"."license_status" AS ENUM('inactive', 'active', 'invalid');--> statement-breakpoint
CREATE TABLE "license_key" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"key" text,
	"status" "license_status" DEFAULT 'inactive' NOT NULL,
	"valid_until" timestamp (3),
	"features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enable_enterprise_features" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3),
	CONSTRAINT "licenseKey_organizationId_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
ALTER TABLE "license_key" ADD CONSTRAINT "license_key_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;