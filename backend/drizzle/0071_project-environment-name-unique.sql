-- A Project's name is unique in its organization, and an Environment's
-- name is unique in its Project, regardless of letter case — the list, the
-- rail, the scope switcher, ⌘K and the typed delete confirm show the name as
-- the only thing that tells two of them apart, so `staging` beside `Staging`
-- is two rows nobody can pick between. Surrounding whitespace is the DTO's to
-- strip from now on (`createProjectSchema` / `createEnvironmentSchema` trim
-- now); step 1 trims what is already stored.
--
-- The statements before the two `CREATE UNIQUE INDEX`es are the reason this is
-- not drizzle-kit's output alone. The index validates every stored row, and
-- every install before this one could hold two same-named Projects or
-- Environments — the U-run made both through the console — so the bare index
-- would abort `db:migrate` on somebody's database and leave `install.sh` half
-- way through an upgrade.
--
-- **Duplicates are renamed, not merged or refused.** Unlike two Tags, two
-- Projects or two Environments are not one thing under two spellings: each
-- carries its own Services, variables and members' grants, so neither can be
-- folded into the other or deleted. Refusing the upgrade hands an operator a
-- psql session for a choice the rename makes without losing anything. The
-- operator can rename either row afterwards from the console.
--
-- 1. Stored names are trimmed. `\s` is Postgres' `[[:space:]]`. A name that is
--    *only* whitespace is left as it is rather than blanked. Trimming can make
--    new duplicates (`staging ` beside `staging`); step 2 renames those too.
-- 2. In each group — one organization's Projects, or one Project's
--    Environments, whose names match by `lower(name)` — **the oldest row keeps
--    its name**, by `created_at` then by id so a tie has one answer on every
--    run. Every later row, taken oldest first, becomes `<name> (n)` for the
--    smallest n ≥ 2 that is free in its group *at that moment* by
--    `lower(name)`, so an already-stored `staging (2)` is stepped over rather
--    than collided with, and the second and third copies come out `(2)` and
--    `(3)`. The oldest row keeps the name because it is the one that was there
--    when the copy was typed — the copy is what a constraint would have
--    refused. The keeper is never renamed, so which rows are copies does not
--    change while the loop runs.
--
-- Every statement is idempotent: a second run finds no untrimmed name and no
-- group of two.
--
-- The two `CREATE UNIQUE INDEX`es are drizzle-kit's own output, unedited;
-- `ProjectsService` and `EnvironmentsService` find them by name to answer 409.
UPDATE "project"
   SET "name" = regexp_replace("name", '^\s+|\s+$', '', 'g')
 WHERE "name" ~ '^\s|\s$'
   AND "name" !~ '^\s*$';
--> statement-breakpoint
UPDATE "environment"
   SET "name" = regexp_replace("name", '^\s+|\s+$', '', 'g')
 WHERE "name" ~ '^\s|\s$'
   AND "name" !~ '^\s*$';
--> statement-breakpoint
DO $$
DECLARE
  copy record;
  n integer;
BEGIN
  FOR copy IN
    SELECT p."project_id", p."organization_id", p."name"
      FROM "project" p
     WHERE EXISTS (
       SELECT 1
         FROM "project" older
        WHERE older."organization_id" = p."organization_id"
          AND lower(older."name") = lower(p."name")
          AND (older."created_at", older."project_id")
              < (p."created_at", p."project_id")
     )
     ORDER BY p."organization_id", p."created_at", p."project_id"
  LOOP
    n := 2;
    WHILE EXISTS (
      SELECT 1
        FROM "project" taken
       WHERE taken."organization_id" = copy."organization_id"
         AND lower(taken."name") = lower(copy."name" || ' (' || n || ')')
    ) LOOP
      n := n + 1;
    END LOOP;
    UPDATE "project"
       SET "name" = copy."name" || ' (' || n || ')'
     WHERE "project_id" = copy."project_id";
  END LOOP;
END
$$;
--> statement-breakpoint
DO $$
DECLARE
  copy record;
  n integer;
BEGIN
  FOR copy IN
    SELECT e."environment_id", e."project_id", e."name"
      FROM "environment" e
     WHERE EXISTS (
       SELECT 1
         FROM "environment" older
        WHERE older."project_id" = e."project_id"
          AND lower(older."name") = lower(e."name")
          AND (older."created_at", older."environment_id")
              < (e."created_at", e."environment_id")
     )
     ORDER BY e."project_id", e."created_at", e."environment_id"
  LOOP
    n := 2;
    WHILE EXISTS (
      SELECT 1
        FROM "environment" taken
       WHERE taken."project_id" = copy."project_id"
         AND lower(taken."name") = lower(copy."name" || ' (' || n || ')')
    ) LOOP
      n := n + 1;
    END LOOP;
    UPDATE "environment"
       SET "name" = copy."name" || ' (' || n || ')'
     WHERE "environment_id" = copy."environment_id";
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE UNIQUE INDEX "unique_project_environment_name" ON "environment" USING btree ("project_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "unique_org_project_name" ON "project" USING btree ("organization_id",lower("name"));
