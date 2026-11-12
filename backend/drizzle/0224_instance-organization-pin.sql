CREATE TABLE "instance_organization" (
	"id" text PRIMARY KEY DEFAULT 'instance' NOT NULL,
	"organization_id" text NOT NULL,
	"pinned_at" text NOT NULL,
	CONSTRAINT "instance_organization_single_row" CHECK ("instance_organization"."id" = 'instance')
);
--> statement-breakpoint
ALTER TABLE "instance_organization" ADD CONSTRAINT "instance_organization_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Back-fill, once (ADR-0077): an existing install's Instance organization is the one ADR-0013's
-- old definition names today, the Organization of the earliest owner `member` row. This runs only
-- in this migration and is never re-derived at runtime, so a later deletion cannot move it. An
-- install with no owner yet pins nothing here; its first sign-up (Self-hosted) or
-- `create-instance-organization` (Hosted) pins it.
INSERT INTO "instance_organization" ("id", "organization_id", "pinned_at")
SELECT 'instance', "member"."organization_id", to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM "member"
WHERE "member"."role" = 'owner'
ORDER BY "member"."created_at" ASC, "member"."id" ASC
LIMIT 1
ON CONFLICT ("id") DO NOTHING;
