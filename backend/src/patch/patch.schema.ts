import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  pgEnum,
  pgTable,
  text,
  unique,
} from 'drizzle-orm/pg-core';
import { application } from '../applications/application.schema';
import { compose } from '../compose/compose.schema';
import { encryptedText, isoTimestamp, nanoidPk } from '../db/columns';

// Per-file source patches applied on top of the cloned repository before a
// build. Exactly one of applicationId/composeId is set, and once nothing
// enforced that: a row with both set attached the patch to two services, only
// one of which had been access-checked, which made `POST /patches` a
// cross-tenant write.
//
// It is now enforced in three places, and none of the three replaces another:
//
//   - `createPatchSchema`'s `superRefine` refuses a body carrying both, at a
//     field path. **That is the half a caller needs** and the constraint below
//     cannot provide: a `CHECK` violation surfaces as a 500 naming a database
//     constraint, where the refinement is a 400 naming the field to fix. The
//     refinement is not redundant and must not be removed because the column
//     rule exists.
//   - `PatchService.create` and `PatchService.insertRow` write only the parent
//     they resolved, by name, so no caller-supplied key reaches the insert —
//     which also covers the service seam, where the global pipe never runs.
//   - {@link patchExactlyOneParent}, the constraint first named and declined to
//     build. It is the only one of the three a *fourth* write path cannot get
//     wrong.

/**
 * Exactly one owning service, as a database fact (named and declined by
 * the first fix, which is why it arrives on its own).
 *
 * `<>` on two `IS NULL` tests is XOR: it refuses a row with **both** parents,
 * which is what the cross-tenant write landed, and it refuses a row with
 * **neither**, which is an orphan no read path in this module can resolve —
 * `serviceIdOf` raises a 500 for it and `findByEntityId` never selects it.
 *
 * **Neither-parent rows were never producible, checked against history rather
 * than assumed.** Every version of `PatchService.create` in this repository has
 * opened with `data.applicationId ?? data.composeId` and thrown
 * `BadRequestException('Either applicationId or composeId must be provided')`
 * when neither was present, and the two upsert paths derive the column from a
 * `PatchEntityType` that has no third value. So the strict `<>` costs no
 * existing install a row, where the weaker `NOT (a IS NOT NULL AND b IS NOT
 * NULL)` would have admitted the orphan for nothing. Both-parent rows *were*
 * producible before, which is why the migration normalizes them before it
 * adds this — see `0063_exactly-one-parent-id.sql`.
 */
export const patchExactlyOneParent = check(
  'patch_exactly_one_parent',
  sql`("application_id" IS NULL) <> ("compose_id" IS NULL)`,
);

export const patchTypeEnum = pgEnum('patch_type', [
  'create',
  'update',
  'delete',
]);

export type PatchType = (typeof patchTypeEnum.enumValues)[number];

export const patch = pgTable(
  'patch',
  {
    patchId: nanoidPk('patch_id'),
    type: patchTypeEnum('type').notNull().default('update'),
    filePath: text('file_path').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    // Patch content is file content headed for the build tree (config files,
    // env-shaped secrets included), so it is encrypted at rest like mount
    // content.
    content: encryptedText('content').notNull(),
    createdAt: isoTimestamp('created_at'),
    updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString()),
    applicationId: text('application_id').references(
      () => application.applicationId,
      { onDelete: 'cascade' },
    ),
    composeId: text('compose_id').references(() => compose.composeId, {
      onDelete: 'cascade',
    }),
  },
  (table) => [
    // One patch per file per application/compose.
    unique('patch_filepath_application_unique').on(
      table.filePath,
      table.applicationId,
    ),
    unique('patch_filepath_compose_unique').on(table.filePath, table.composeId),
    patchExactlyOneParent,
  ],
);

export const patchRelations = relations(patch, ({ one }) => ({
  application: one(application, {
    fields: [patch.applicationId],
    references: [application.applicationId],
  }),
  compose: one(compose, {
    fields: [patch.composeId],
    references: [compose.composeId],
  }),
}));

export type Patch = typeof patch.$inferSelect;
