CREATE TABLE "pending_setup" (
	"pending_setup_id" text PRIMARY KEY NOT NULL,
	"environment_id" text NOT NULL,
	"setup_record_id" text,
	"template_id" text NOT NULL,
	"revision" text NOT NULL,
	"template_name" text NOT NULL,
	"setup_name" text NOT NULL,
	"parts" jsonb NOT NULL,
	"body" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "setup_record" (
	"setup_record_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"template_id" text NOT NULL,
	"revision" text NOT NULL,
	"setup_name" text NOT NULL,
	"config_names" jsonb NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pending_setup" ADD CONSTRAINT "pending_setup_environment_id_environment_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("environment_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_setup" ADD CONSTRAINT "pending_setup_setup_record_id_setup_record_setup_record_id_fk" FOREIGN KEY ("setup_record_id") REFERENCES "public"."setup_record"("setup_record_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_record" ADD CONSTRAINT "setup_record_project_id_project_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("project_id") ON DELETE cascade ON UPDATE no action;