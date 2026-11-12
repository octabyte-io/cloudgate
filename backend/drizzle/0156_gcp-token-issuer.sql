ALTER TABLE "cloud_account" DROP CONSTRAINT "cloud_account_gcp_whole";--> statement-breakpoint
ALTER TABLE "cloud_account" ADD COLUMN "token_issuer" text;--> statement-breakpoint
ALTER TABLE "cloud_account" ADD CONSTRAINT "cloud_account_gcp_whole" CHECK (CASE WHEN "cloud"::text = 'gcp'
    THEN num_nulls("project_number", "workload_identity_provider", "deploy_service_account", "signing_key", "signing_key_id", "signing_public_key", "token_issuer") = 0
    ELSE num_nonnulls("project_number", "workload_identity_provider", "deploy_service_account", "signing_key", "signing_key_id", "signing_public_key", "pending_signing_key", "token_issuer") = 0
  END);