-- `patch` and `domain` each carry two nullable foreign keys to an owning
-- service, exactly one of which may be set. Two earlier fixes each fixed the
-- application layer for one of them — a `superRefine` refusing a body that
-- names both, plus an insert that names its columns from the parent it
-- resolved — and each named this constraint as the stronger home and declined
-- to build it, because it needs a migration and migrations serialize. It is the
-- only one of the three statements of the rule that a *fourth* write path
-- cannot get wrong; the two application-level halves stay, because a `CHECK`
-- answers a 500 naming a constraint where a caller needs a 400 naming the
-- field.
--
-- The two `UPDATE`s come first, and they are the reason this file is not the
-- two `ALTER`s drizzle-kit generated on their own. **A row carrying both keys
-- was producible on every install running a build older than those two fixes**, and
-- `ADD CONSTRAINT` validates existing rows, so the migration would abort on
-- somebody's database rather than on ours. What it would abort on is precisely
-- the cross-tenant row those two fixes were about: an owned
-- `applicationId` beside another organization's `composeId`, which landed a
-- patch inside the victim's build tree (`generateApplyPatchesCommand` renders
-- it as `base64 -d >` under their code directory) or a Traefik router on the
-- victim's Compose stack.
--
-- **`compose_id` is the key that is cleared, not `application_id`, and not the
-- row.** Every reader in both modules already resolves such a row as its
-- *Application* parent and always has — `PatchService`' `serviceIdOf` is
-- `row.applicationId ?? row.composeId` and `DomainsService.findParentService`
-- tests `applicationId` first and returns — so clearing `compose_id` makes the
-- stored row agree with what the whole application already believes it is,
-- changes no behaviour for the Application it is read as, and takes the patch
-- or the router off the Compose stack that never authorized it. The second fix's docblock
-- records deleting the row as the remedy for this state; deleting is the wrong
-- default *here* because a both-keys row is not necessarily a hijack — the same
-- bug could stamp a second key onto an entirely legitimate Application domain —
-- and a migration that silently drops a customer's routing is worse than one
-- that narrows it to the parent every read already used. An operator who wants
-- the row gone can still delete it; nobody can undo a delete this file did for
-- them.
--
-- **Rows with *neither* key are not normalized, because they cannot exist.**
-- Checked against history rather than assumed: every version of
-- `PatchService.create` in this repository opens with
-- `data.applicationId ?? data.composeId` and throws
-- `BadRequestException('Either applicationId or composeId must be provided')`
-- when neither is present, and `DomainsService.findParentService`'s final
-- statement has always been `BadRequestException('applicationId or composeId is
-- required')` — both before the insert. The two upsert paths on `patch` derive
-- the column from a `PatchEntityType` with no third value, and `domain` has no
-- third parent column at all (`domainType`'s `'preview'` is wire-parity for the
-- Traefik generators; Phase 25 stores preview hosts on the `preview_deployment`
-- row). So the strict `<>` — XOR, which refuses neither as well as both — costs
-- no install a row, where the weaker `NOT (a IS NOT NULL AND b IS NOT NULL)`
-- would admit an orphan that no read path in either module can resolve for
-- nothing.
--
-- Both `UPDATE`s are idempotent: a second run matches no row and reports
-- `UPDATE 0`.
--
-- The two `ALTER`s below are drizzle-kit's own output, unedited —
-- `drizzle-kit generate` does emit a `CHECK` from a `check()` in the table
-- definition on 0.31.10, verified rather than assumed, and `--name` wrote both
-- the §2.6 filename and the matching `_journal.json` tag so no rename was
-- needed. The constraints are `patchExactlyOneParent` and
-- `domainExactlyOneParent` in `patch.schema.ts` and `domain.schema.ts`.
UPDATE "patch"
   SET "compose_id" = NULL
 WHERE "application_id" IS NOT NULL
   AND "compose_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "domain"
   SET "compose_id" = NULL
 WHERE "application_id" IS NOT NULL
   AND "compose_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "domain" ADD CONSTRAINT "domain_exactly_one_parent" CHECK (("application_id" IS NULL) <> ("compose_id" IS NULL));--> statement-breakpoint
ALTER TABLE "patch" ADD CONSTRAINT "patch_exactly_one_parent" CHECK (("application_id" IS NULL) <> ("compose_id" IS NULL));
