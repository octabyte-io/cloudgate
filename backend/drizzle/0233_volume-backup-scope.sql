CREATE TYPE "public"."volume_backup_scope" AS ENUM('volume', 'stack');--> statement-breakpoint
ALTER TABLE "volume_backup" ALTER COLUMN "volume_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "volume_backup" ADD COLUMN "scope" "volume_backup_scope" DEFAULT 'volume' NOT NULL;--> statement-breakpoint
ALTER TABLE "volume_backup" ADD CONSTRAINT "volume_backup_scope_matches_service" CHECK (("scope"::text = 'volume' AND "volume_name" IS NOT NULL)
    OR ("scope"::text = 'stack' AND "service_type"::text = 'compose' AND "volume_name" IS NULL AND "service_name" IS NULL));