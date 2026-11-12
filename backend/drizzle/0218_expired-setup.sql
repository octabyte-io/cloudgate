CREATE TABLE "expired_setup" (
	"expired_setup_id" text PRIMARY KEY NOT NULL,
	"environment_id" text NOT NULL,
	"template_id" text NOT NULL,
	"template_name" text NOT NULL,
	"setup_name" text NOT NULL,
	"config_names" jsonb NOT NULL,
	"set_up_at" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "expired_setup" ADD CONSTRAINT "expired_setup_environment_id_environment_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("environment_id") ON DELETE cascade ON UPDATE no action;