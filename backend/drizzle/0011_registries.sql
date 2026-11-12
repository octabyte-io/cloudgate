CREATE TYPE "public"."registry_type" AS ENUM('selfHosted', 'cloud');--> statement-breakpoint
CREATE TABLE "registry" (
	"registry_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"image_prefix" text,
	"username" text NOT NULL,
	"password" text NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"registry_type" "registry_type" DEFAULT 'cloud' NOT NULL,
	"created_at" text NOT NULL,
	"organization_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "registry" ADD CONSTRAINT "registry_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;