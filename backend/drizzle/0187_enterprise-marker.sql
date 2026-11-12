-- The Enterprise marker (ADR-0048): `is_enterprise_cloud` becomes
-- `enterprise`, and an Enterprise Organization's allowance is two hand-set
-- counts rather than the Hosted plan's.
ALTER TABLE "subscription" RENAME COLUMN "is_enterprise_cloud" TO "enterprise";--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "enterprise_servers" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "enterprise_cloud_environments" integer DEFAULT 0 NOT NULL;
