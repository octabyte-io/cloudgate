CREATE TABLE "environment" (
	"environment_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" text NOT NULL,
	"project_id" text NOT NULL,
	"env" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "environment" ADD CONSTRAINT "environment_project_id_project_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("project_id") ON DELETE cascade ON UPDATE no action;