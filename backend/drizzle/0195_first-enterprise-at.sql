ALTER TABLE "subscription" ADD COLUMN "first_enterprise_at" timestamp (3);--> statement-breakpoint
-- An Organization that is Enterprise now has been since at least its row's
-- last write; the moment it was first switched on is kept nowhere
-- the schema can read.
UPDATE "subscription" SET "first_enterprise_at" = coalesce("updated_at", "created_at") WHERE "enterprise" = true;
