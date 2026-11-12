-- Follows 91ee164. `toRollbackContext` now runs on the way out
-- of `rollback.full_context` as well as on the way in, which closed both paths
-- a legacy snapshot could be *read* through — it can neither win
-- `RollbacksService.rollback`'s merge nor be served by `findAllByApplicationId`
-- — and touched none of the bytes. A row captured before that commit still
-- holds, in a plain `json` column beside the encrypted columns they were
-- decrypted out of (ADR 0006), `previewEnv`, `previewBuildArgs`, every file
-- mount's `content`, and the seven credential ids — one of which, before an earlier fix,
-- an Application row could legitimately hold for another organization. A
-- `pg_dump` or a physical backup carries all of it. This is the one-time
-- scrub; nothing in the product reads those bytes any more.
--
-- Hand-written, because `drizzle-kit generate` writes nothing for a data-only
-- migration: there is no schema change here (CODING_STANDARDS §2.6).
--
-- The key list is `RollbacksService.EXCLUDED_FROM_CONTEXT` in full rather than
-- only the nine names 91ee164 added to it, so a scrubbed row holds exactly what
-- `findAllByApplicationId` already serves — a snapshot older than any given
-- version of that list is precisely the row this file exists for, and there is
-- no per-row way to know which version wrote it. A frozen artefact cannot
-- import the list, so `test/rollbacks/legacy-context-scrub.spec.ts` holds this
-- copy to `APPLICATION_CREDENTIAL_REFS` and to the `PgCustomColumn` sets on
-- `application` and `mount`, and goes red when a name joins any of them — at
-- which point the answer is a new scrub beside this one, not an edit here.
--
-- Both statements are guarded on `jsonb_typeof(…) = 'object'` and not on
-- `full_context IS NOT NULL` alone. Malformed JSON cannot be in the column —
-- `json` validates on input — but `null`, a number and a string are all valid
-- `json`, and `jsonb - text[]` answers every one of them with `cannot delete
-- from scalar`, which inside a migration is the whole run aborting; on an
-- array it silently deletes matching *elements* instead. A legacy
-- `full_context` is whatever some past version of `capture` wrote, so the
-- shape is not assumed. The `?|` and `?` tests are what make the file
-- idempotent: a second run matches no row and reports `UPDATE 0`.
WITH scrub(keys) AS (
  VALUES (ARRAY[
    'env','buildArgs','buildSecrets','password','previewEnv','previewBuildArgs',
    'refreshToken','environment','github','gitlab','gitea','bitbucket',
    'customGitSSHKey','registry','buildRegistry','githubId','gitlabId','giteaId',
    'bitbucketId','customGitSSHKeyId','registryId','buildRegistryId'
  ])
)
UPDATE "rollback"
   SET "full_context" = ("full_context"::jsonb - scrub.keys)::json
  FROM scrub
 WHERE "full_context" IS NOT NULL
   AND jsonb_typeof("full_context"::jsonb) = 'object'
   AND "full_context"::jsonb ?| scrub.keys;
--> statement-breakpoint
-- `mounts[].content` needs its own statement: it is an element rewrite, not a
-- key deletion. It reached the snapshot because
-- `ApplicationsService.findDeployable` fills `mounts` from `select().from(mount)`
-- — whole rows — against a field typed `ServiceMount[]` that declares five
-- fields and no `content`, so structural typing accepted the wider row and the
-- decrypted body of a file mount landed here.
--
-- Only `content` is deleted, rather than projecting each element down to
-- `ServiceMount`'s five fields the way `toSnapshotMount` does on the write
-- path: what is being scrubbed is the secret, and `mountId` and its siblings
-- are not one. Every reader gets the five-field projection anyway.
--
-- The `CASE` is what makes this safe for a `mounts` that is `null`, absent, a
-- scalar or an object — `jsonb_array_elements` answers a non-array with
-- `cannot extract elements from a scalar`, and the `CASE` guarantees it never
-- sees one, where an `AND` conjunct would leave the order to the planner.
-- `WITH ORDINALITY` keeps the mounts in the order the snapshot recorded them,
-- and the `EXISTS` test keeps an `[]` out of the statement entirely, since
-- `jsonb_agg` over no rows is SQL NULL and would write `"mounts": null` in
-- place of the empty array.
UPDATE "rollback"
   SET "full_context" = (
         "full_context"::jsonb
         || jsonb_build_object('mounts', (
              SELECT jsonb_agg(
                       CASE WHEN jsonb_typeof(m.value) = 'object'
                            THEN m.value - 'content'
                            ELSE m.value
                       END
                       ORDER BY m.ordinality
                     )
                FROM jsonb_array_elements("full_context"::jsonb -> 'mounts')
                     WITH ORDINALITY AS m(value, ordinality)
            ))
       )::json
 WHERE "full_context" IS NOT NULL
   AND jsonb_typeof("full_context"::jsonb) = 'object'
   AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(
                  CASE WHEN jsonb_typeof("full_context"::jsonb -> 'mounts') = 'array'
                       THEN "full_context"::jsonb -> 'mounts'
                       ELSE '[]'::jsonb
                  END
                ) AS m(value)
          WHERE jsonb_typeof(m.value) = 'object' AND m.value ? 'content'
       );
