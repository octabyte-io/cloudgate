CREATE TABLE "database_switch" (
	"database_switch_id" text PRIMARY KEY NOT NULL,
	"environment_id" text NOT NULL,
	"config_name" text NOT NULL,
	"to" text NOT NULL,
	"identifier" text,
	"made_reachable" boolean DEFAULT false NOT NULL,
	"database_user" text,
	"database_name" text,
	"database_password" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "existing_database" ADD COLUMN "not_found_at" text;--> statement-breakpoint
ALTER TABLE "database_switch" ADD CONSTRAINT "database_switch_environment_id_environment_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("environment_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "database_switch_environment_config_name_unique" ON "database_switch" USING btree ("environment_id","config_name");