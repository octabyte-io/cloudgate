CREATE TYPE "public"."preview_expiry_cause" AS ENUM('expiry', 'delete');--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "user_email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "preview_deployment" ADD COLUMN "expired_at" text;--> statement-breakpoint
ALTER TABLE "preview_deployment" ADD COLUMN "expiry_cause" "preview_expiry_cause";--> statement-breakpoint
-- Hand-written, ahead of the member check below: an install whose
-- Organization already has a custom role named `system` has Members on it,
-- and the check would refuse to apply to their rows. The role is renamed
-- `system-renamed` (or `system-renamed-<its id>` where that name is already
-- one of the Organization's roles) wherever it is named: its Members, its
-- pending invitations, then the role row itself, so every holder keeps its
-- grant under the new name. The first two run while the old name still
-- stands, so each reads the same choice of name the third writes.
UPDATE "member" SET "role" = array_to_string(ARRAY(
  SELECT CASE WHEN trim(part) = 'system' THEN (
    CASE WHEN EXISTS (
      SELECT 1 FROM "organization_role" taken
       WHERE taken."organization_id" = "member"."organization_id"
         AND taken."role" = 'system-renamed'
    ) THEN 'system-renamed-' || coalesce((
      SELECT own."id" FROM "organization_role" own
       WHERE own."organization_id" = "member"."organization_id"
         AND own."role" = 'system' LIMIT 1
    ), "member"."id") ELSE 'system-renamed' END
  ) ELSE part END
  FROM unnest(string_to_array("member"."role", ',')) WITH ORDINALITY AS roles(part, position)
  ORDER BY position
), ',')
WHERE 'system' = ANY (string_to_array(replace("member"."role", ' ', ''), ','));--> statement-breakpoint
UPDATE "invitation" SET "role" = array_to_string(ARRAY(
  SELECT CASE WHEN trim(part) = 'system' THEN (
    CASE WHEN EXISTS (
      SELECT 1 FROM "organization_role" taken
       WHERE taken."organization_id" = "invitation"."organization_id"
         AND taken."role" = 'system-renamed'
    ) THEN 'system-renamed-' || coalesce((
      SELECT own."id" FROM "organization_role" own
       WHERE own."organization_id" = "invitation"."organization_id"
         AND own."role" = 'system' LIMIT 1
    ), "invitation"."id") ELSE 'system-renamed' END
  ) ELSE part END
  FROM unnest(string_to_array("invitation"."role", ',')) WITH ORDINALITY AS roles(part, position)
  ORDER BY position
), ',')
WHERE 'system' = ANY (string_to_array(replace("invitation"."role", ' ', ''), ','));--> statement-breakpoint
UPDATE "organization_role" SET "role" = CASE WHEN EXISTS (
  SELECT 1 FROM "organization_role" taken
   WHERE taken."organization_id" = "organization_role"."organization_id"
     AND taken."role" = 'system-renamed'
) THEN 'system-renamed-' || "organization_role"."id" ELSE 'system-renamed' END
WHERE "role" = 'system';--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_role_is_not_the_platform" CHECK (NOT ('system' = ANY (string_to_array(replace("member"."role", ' ', ''), ','))));--> statement-breakpoint
ALTER TABLE "preview_deployment" ADD CONSTRAINT "preview_deployment_expired_is_requested" CHECK (("preview_deployment"."expired_at" IS NULL AND "preview_deployment"."expiry_cause" IS NULL) OR ("preview_deployment"."expired_at" IS NOT NULL AND "preview_deployment"."expiry_cause" IS NOT NULL AND "preview_deployment"."trigger" = 'requested'));