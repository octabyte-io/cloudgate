CREATE TABLE "ssh_key" (
	"ssh_key_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"public_key" text NOT NULL,
	"private_key" text DEFAULT '' NOT NULL,
	"created_at" text NOT NULL,
	"last_used_at" text,
	"organization_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ssh_key" ADD CONSTRAINT "ssh_key_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;