ALTER TABLE "cloud_account" ALTER COLUMN "access_key_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_account" ALTER COLUMN "secret_access_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_account" ALTER COLUMN "deploy_role_arn" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_account" ALTER COLUMN "task_execution_role_arn" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_account" ALTER COLUMN "external_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_account" ADD COLUMN "project_number" text;--> statement-breakpoint
ALTER TABLE "cloud_account" ADD COLUMN "workload_identity_provider" text;--> statement-breakpoint
ALTER TABLE "cloud_account" ADD COLUMN "deploy_service_account" text;--> statement-breakpoint
ALTER TABLE "cloud_account" ADD COLUMN "signing_key" text;--> statement-breakpoint
ALTER TABLE "cloud_account" ADD COLUMN "signing_key_id" text;--> statement-breakpoint
ALTER TABLE "cloud_account" ADD COLUMN "signing_public_key" text;--> statement-breakpoint
ALTER TABLE "cloud_account" ADD COLUMN "pending_signing_key" text;--> statement-breakpoint
ALTER TABLE "cloud_account" ADD CONSTRAINT "cloud_account_aws_whole" CHECK (CASE WHEN "cloud"::text = 'aws'
    THEN num_nulls("access_key_id", "secret_access_key", "deploy_role_arn", "task_execution_role_arn", "external_id") = 0
    ELSE num_nonnulls("access_key_id", "secret_access_key", "deploy_role_arn", "task_execution_role_arn", "external_id") = 0
  END);--> statement-breakpoint
ALTER TABLE "cloud_account" ADD CONSTRAINT "cloud_account_gcp_whole" CHECK (CASE WHEN "cloud"::text = 'gcp'
    THEN num_nulls("project_number", "workload_identity_provider", "deploy_service_account", "signing_key", "signing_key_id", "signing_public_key") = 0
    ELSE num_nonnulls("project_number", "workload_identity_provider", "deploy_service_account", "signing_key", "signing_key_id", "signing_public_key", "pending_signing_key") = 0
  END);