-- `dns_challenge_local_unique` was meant to hold the platform host to one
-- DNS-01 row, and held it to nothing: it is a unique index on `server_id`
-- restricted to rows where `server_id` is null, and Postgres treats NULLs as
-- distinct in a unique index, so every platform-host row was unlike every
-- other. Two concurrent first PUTs on the platform host both inserted, and
-- `dnsChallengeOn` then answered whichever it met first.
--
-- `NULLS NOT DISTINCT` (Postgres 15+) is what makes it a constraint, and it is
-- also what lets `DnsChallengeService.put`'s upsert name it as its arbiter:
-- `ON CONFLICT ("server_id") WHERE "server_id" IS NULL` infers this index.
-- drizzle-kit cannot express the clause on an index, which is why this file is
-- hand-written and the snapshot is unchanged from 0082's: the schema's
-- `uniqueIndex` still declares the same columns and predicate, so the next
-- generate sees no difference to undo.
--
-- The `DELETE` comes first because the index validates existing rows: a
-- duplicate the race already wrote would abort the migration. The newest row
-- is the one kept, since it is the last setup an operator saved; Traefik's
-- `traefik.yml` and env were written by that same save.
DELETE FROM "dns_challenge" AS "older"
USING "dns_challenge" AS "newer"
WHERE "older"."server_id" IS NULL
  AND "newer"."server_id" IS NULL
  AND ("older"."created_at", "older"."dns_challenge_id")
    < ("newer"."created_at", "newer"."dns_challenge_id");
--> statement-breakpoint
DROP INDEX "dns_challenge_local_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "dns_challenge_local_unique" ON "dns_challenge" USING btree ("server_id") NULLS NOT DISTINCT WHERE "dns_challenge"."server_id" is null;
