ALTER TYPE "public"."service_type" ADD VALUE 'bucket';--> statement-breakpoint
CREATE TABLE "bucket" (
	"bucket_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"config_name" text NOT NULL,
	"config_plan_id" text,
	"app_name" text NOT NULL,
	"description" text,
	"bucket_name" text NOT NULL,
	"access_key_id" text,
	"secret_access_key" text,
	"admin_credential" text NOT NULL,
	"volume_name" text NOT NULL,
	"application_status" "application_status" DEFAULT 'idle' NOT NULL,
	"created_at" text NOT NULL,
	"environment_id" text NOT NULL,
	"server_id" text,
	CONSTRAINT "bucket_app_name_unique" UNIQUE("app_name"),
	CONSTRAINT "bucket_config_name_format" CHECK ("bucket"."config_name" ~ '^[a-z][a-z0-9-]{0,62}$'),
	CONSTRAINT "bucket_key_whole" CHECK (("bucket"."access_key_id" IS NULL) = ("bucket"."secret_access_key" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "bucket" ADD CONSTRAINT "bucket_config_plan_id_plan_plan_id_fk" FOREIGN KEY ("config_plan_id") REFERENCES "public"."plan"("plan_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bucket" ADD CONSTRAINT "bucket_environment_id_environment_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("environment_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bucket" ADD CONSTRAINT "bucket_server_id_server_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("server_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bucket_environment_config_name_unique" ON "bucket" USING btree ("environment_id","config_name");