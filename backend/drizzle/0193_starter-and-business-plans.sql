ALTER TABLE "subscription" ALTER COLUMN "plan" SET DATA TYPE text;--> statement-breakpoint
-- The one Hosted plan is replaced by Starter and Business (ADR-0054).
-- There are no live customers; a row on the old plan holds no plan, as its
-- price is neither of the new ones.
UPDATE "subscription" SET "plan" = NULL WHERE "plan" IS NOT NULL;--> statement-breakpoint
DROP TYPE "public"."billing_plan";--> statement-breakpoint
CREATE TYPE "public"."billing_plan" AS ENUM('starter', 'business');--> statement-breakpoint
ALTER TABLE "subscription" ALTER COLUMN "plan" SET DATA TYPE "public"."billing_plan" USING "plan"::"public"."billing_plan";
