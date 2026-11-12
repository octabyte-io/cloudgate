-- An Agent is a `user` row declared `kind = 'agent'` plus exactly one
-- `member` row (ADR-0023), and an Agent key keeps its expiry in a column the
-- api-key plugin never reads, so the plugin's delete-on-expiry cannot reach it
-- (`apikey.agent_expires_at`, see `auth.schema.ts`).
--
-- The `DELETE` before the unique index is the one statement that is not
-- drizzle-kit's output. The index validates every stored row, and a bare index
-- over a stray duplicate would abort `db:migrate` half way through an upgrade.
-- Nothing is known to write one — better-auth refuses to invite somebody who
-- is already a member — so on every install this is expected to delete
-- nothing. If a pair does exist, the row kept is the one
-- `AuthService.resolveMember` already answers for that user (the default
-- membership, then the newest, then the id so a tie has one answer), so the
-- role and grant the person is acting under today are the ones that survive.
-- Idempotent: a second run finds no pair.
DELETE FROM "member" m
 USING "member" keeper
 WHERE keeper."user_id" = m."user_id"
   AND keeper."organization_id" = m."organization_id"
   AND keeper."id" <> m."id"
   AND (keeper."is_default", keeper."created_at", keeper."id")
       > (m."is_default", m."created_at", m."id");--> statement-breakpoint
CREATE TYPE "public"."user_kind" AS ENUM('human', 'agent');--> statement-breakpoint
ALTER TABLE "apikey" ADD COLUMN "agent_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "kind" "user_kind" DEFAULT 'human' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "member_user_organization_unique" ON "member" USING btree ("user_id","organization_id");--> statement-breakpoint
ALTER TABLE "apikey" ADD CONSTRAINT "apikey_one_expiry" CHECK ("apikey"."agent_expires_at" IS NULL OR "apikey"."expires_at" IS NULL);
