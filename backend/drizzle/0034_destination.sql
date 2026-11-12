CREATE TABLE "destination" (
	"destination_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"provider" text,
	"access_key" text NOT NULL,
	"secret_access_key" text NOT NULL,
	"bucket" text NOT NULL,
	"region" text NOT NULL,
	"endpoint" text NOT NULL,
	"created_at" text NOT NULL,
	"organization_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "destination" ADD CONSTRAINT "destination_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;