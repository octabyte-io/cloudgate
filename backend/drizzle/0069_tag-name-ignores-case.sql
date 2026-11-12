-- A Tag's name is unique within its organization regardless of letter
-- case, because the tag filter, the tick-box dialog and every Project row show
-- it as a plain word — `frontend` and `Frontend` are one name to anyone reading
-- them, and the `(organization_id, name)` unique this replaces compared bytes.
-- Surrounding whitespace is the DTO's to strip (`createTagSchema` trims now,
-- as the console always did); this file trims what is already stored.
--
-- The three statements before the two `ALTER`s are the reason this is not
-- drizzle-kit's output alone. `CREATE UNIQUE INDEX` validates every stored
-- row, and every install before this one could hold two case variants in one
-- organization — the U-run made exactly that pair through the console — so the
-- bare index would abort `db:migrate` on somebody's database rather than on
-- ours, and leave `install.sh` half way through an upgrade.
--
-- **The variants are merged, not refused.** Failing loudly was the other
-- option considered, and it hands an operator a stopped upgrade and a psql
-- session to decide something the product already decides for them: the two
-- rows are one label to every reader, so the only question is which row
-- survives, and it has an answer that loses nothing a person can see.
--
-- **The oldest row of each group is the one kept** — by `created_at`, then by
-- `tag_id` so a tie has one answer on every run. A group is every Tag in one
-- organization whose name folds to the same `lower(trim(name))`. The keeper
-- keeps its own id, spelling and colour; the others' Project assignments move
-- onto it, and then the others are deleted. The oldest rather than the most
-- used, because it is the one that was there when the variant was typed — the
-- variant is the duplicate the old constraint should have refused — and
-- because an id that has been in use longest is the likeliest to be held
-- somewhere outside this database. Chip colour is not painted from
-- `tag.color` (see `tag-chips.tsx`), so a dropped variant's colour is not
-- something anyone was looking at.
--
-- 1. Each variant's assignment moves to the keeper, unless the Project already
--    carries the keeper — and only one of a Project's variants moves, because
--    `unique_project_tag` is checked row by row and two moves onto the same
--    keeper would collide with each other. `DISTINCT ON` picks that one.
-- 2. The variants are deleted. The assignments step 1 did not move are exactly
--    the ones that would have duplicated the keeper's, and `project_tag`'s
--    `on delete cascade` takes them with their Tag.
-- 3. Stored names are trimmed. `\s` here is Postgres' `[[:space:]]` — space,
--    tab, newline, carriage return, vertical tab, form feed — which is what an
--    old console or API client could have sent. A name that is *only*
--    whitespace is left as it is rather than blanked: the DTO refuses one from
--    now on, and renaming it is the operator's call, not an empty chip. Step 2
--    already left one row per folded name, so the trim cannot collide.
--
-- Every statement is idempotent: a second run finds no group of two and no
-- untrimmed name, and reports `UPDATE 0` / `DELETE 0`.
--
-- The two `ALTER`s below are drizzle-kit's own output, unedited; the index is
-- `unique_org_tag_name` in `tag.schema.ts`, and keeps the old constraint's name
-- so `TagsService.mapUniqueNameViolation` goes on finding it. The drop comes
-- first because a unique constraint and an index share a namespace.
WITH folded AS (
  SELECT "tag_id",
         first_value("tag_id") OVER (
           PARTITION BY "organization_id",
                        lower(regexp_replace("name", '^\s+|\s+$', '', 'g'))
           ORDER BY "created_at", "tag_id"
         ) AS "keeper_id"
    FROM "tag"
),
moved AS (
  SELECT DISTINCT ON (pt."project_id", f."keeper_id") pt."id", f."keeper_id"
    FROM "project_tag" pt
    JOIN folded f ON f."tag_id" = pt."tag_id"
   WHERE f."tag_id" <> f."keeper_id"
     AND NOT EXISTS (
       SELECT 1
         FROM "project_tag" kept
        WHERE kept."project_id" = pt."project_id"
          AND kept."tag_id" = f."keeper_id"
     )
   ORDER BY pt."project_id", f."keeper_id", pt."id"
)
UPDATE "project_tag"
   SET "tag_id" = moved."keeper_id"
  FROM moved
 WHERE "project_tag"."id" = moved."id";
--> statement-breakpoint
WITH folded AS (
  SELECT "tag_id",
         first_value("tag_id") OVER (
           PARTITION BY "organization_id",
                        lower(regexp_replace("name", '^\s+|\s+$', '', 'g'))
           ORDER BY "created_at", "tag_id"
         ) AS "keeper_id"
    FROM "tag"
)
DELETE FROM "tag"
 USING folded
 WHERE "tag"."tag_id" = folded."tag_id"
   AND folded."tag_id" <> folded."keeper_id";
--> statement-breakpoint
UPDATE "tag"
   SET "name" = regexp_replace("name", '^\s+|\s+$', '', 'g')
 WHERE "name" ~ '^\s|\s$'
   AND "name" !~ '^\s*$';
--> statement-breakpoint
ALTER TABLE "tag" DROP CONSTRAINT "unique_org_tag_name";--> statement-breakpoint
CREATE UNIQUE INDEX "unique_org_tag_name" ON "tag" USING btree ("organization_id",lower("name"));
