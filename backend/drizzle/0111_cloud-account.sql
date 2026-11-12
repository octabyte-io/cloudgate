CREATE TYPE "public"."cloud_account_check_result" AS ENUM('passed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."cloud_kind" AS ENUM('aws');--> statement-breakpoint
CREATE TABLE "cloud_account" (
	"cloud_account_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"cloud" "cloud_kind" NOT NULL,
	"cloud_id" text NOT NULL,
	"access_key_id" text NOT NULL,
	"secret_access_key" text NOT NULL,
	"deploy_role_arn" text NOT NULL,
	"task_execution_role_arn" text NOT NULL,
	"external_id" text NOT NULL,
	"policy_version" integer NOT NULL,
	"last_checked_at" text NOT NULL,
	"last_check_result" "cloud_account_check_result" NOT NULL,
	"last_check_reason" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloud_account" ADD CONSTRAINT "cloud_account_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_account_organization_cloud_id_unique" ON "cloud_account" USING btree ("organization_id","cloud","cloud_id");