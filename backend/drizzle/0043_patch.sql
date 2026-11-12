CREATE TYPE "public"."patch_type" AS ENUM('create', 'update', 'delete');--> statement-breakpoint
CREATE TABLE "patch" (
	"patch_id" text PRIMARY KEY NOT NULL,
	"type" "patch_type" DEFAULT 'update' NOT NULL,
	"file_path" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"content" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text,
	"application_id" text,
	"compose_id" text,
	CONSTRAINT "patch_filepath_application_unique" UNIQUE("file_path","application_id"),
	CONSTRAINT "patch_filepath_compose_unique" UNIQUE("file_path","compose_id")
);
--> statement-breakpoint
ALTER TABLE "patch" ADD CONSTRAINT "patch_application_id_application_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("application_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch" ADD CONSTRAINT "patch_compose_id_compose_compose_id_fk" FOREIGN KEY ("compose_id") REFERENCES "public"."compose"("compose_id") ON DELETE cascade ON UPDATE no action;