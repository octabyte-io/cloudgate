CREATE TABLE "environment_network" (
	"environment_network_id" text PRIMARY KEY NOT NULL,
	"environment_id" text NOT NULL,
	"cloud_account_id" text NOT NULL,
	"region" text NOT NULL,
	"vpc_id" text,
	"public_subnet_ids" jsonb,
	"cluster_arn" text,
	"https_listener_arn" text,
	"alb_security_group_id" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "cloud_account_id" text;--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "environment_network" ADD CONSTRAINT "environment_network_environment_id_environment_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("environment_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_network" ADD CONSTRAINT "environment_network_cloud_account_id_cloud_account_cloud_account_id_fk" FOREIGN KEY ("cloud_account_id") REFERENCES "public"."cloud_account"("cloud_account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "environment_network_place_unique" ON "environment_network" USING btree ("environment_id","cloud_account_id","region");--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_cloud_account_id_cloud_account_cloud_account_id_fk" FOREIGN KEY ("cloud_account_id") REFERENCES "public"."cloud_account"("cloud_account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_place" CHECK (("application"."cloud_account_id" IS NULL) = ("application"."region" IS NULL) AND ("application"."cloud_account_id" IS NULL OR "application"."server_id" IS NULL));