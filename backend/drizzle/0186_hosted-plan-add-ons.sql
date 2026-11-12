ALTER TABLE "subscription" ALTER COLUMN "plan" SET DATA TYPE text;--> statement-breakpoint
-- The legacy, hobby and startup tiers are retired (ADR-0048): their
-- prices are not the Hosted plan's, so a row on one of them holds no plan.
UPDATE "subscription" SET "plan" = NULL WHERE "plan" IS NOT NULL;--> statement-breakpoint
DROP TYPE "public"."billing_plan";--> statement-breakpoint
CREATE TYPE "public"."billing_plan" AS ENUM('hosted');--> statement-breakpoint
ALTER TABLE "subscription" ALTER COLUMN "plan" SET DATA TYPE "public"."billing_plan" USING "plan"::"public"."billing_plan";--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "add_ons" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription" DROP COLUMN "servers_quantity";
