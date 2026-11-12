-- `forward_auth_settings_local_unique` was meant to hold the platform
-- host to one forward-auth row, and held it to nothing — the same defect
-- `0083_dns-challenge-local-unique.sql` fixed on `dns_challenge`: a unique
-- index on `server_id` restricted to rows where `server_id` is null, with
-- Postgres counting every NULL distinct in a unique index. Two concurrent first
-- auth-domain saves on the platform host both inserted, and `findSettings` then
-- answered whichever it met first.
--
-- `NULLS NOT DISTINCT` (Postgres 15+) is what makes it a constraint, and it is
-- also what lets `ForwardAuthService.setAuthDomain`'s upsert name it as its
-- arbiter: `ON CONFLICT ("server_id") WHERE "server_id" IS NULL` infers this
-- index. drizzle-kit cannot express the clause on an index, which is why this
-- file is hand-written and the snapshot is unchanged from 0083's: the schema's
-- `uniqueIndex` still declares the same columns and predicate, so the next
-- generate sees no difference to undo.
--
-- The `DELETE` comes first because the index validates existing rows: a
-- duplicate the race already wrote would abort the migration. The newest row
-- is the one kept, since it is the last auth domain an operator saved and the
-- one its `forward-auth-domain.yml` router was written from.
DELETE FROM "forward_auth_settings" AS "older"
USING "forward_auth_settings" AS "newer"
WHERE "older"."server_id" IS NULL
  AND "newer"."server_id" IS NULL
  AND ("older"."created_at", "older"."forward_auth_settings_id")
    < ("newer"."created_at", "newer"."forward_auth_settings_id");
--> statement-breakpoint
DROP INDEX "forward_auth_settings_local_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "forward_auth_settings_local_unique" ON "forward_auth_settings" USING btree ("server_id") NULLS NOT DISTINCT WHERE "forward_auth_settings"."server_id" is null;
