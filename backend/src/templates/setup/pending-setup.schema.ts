import { relations } from 'drizzle-orm';
import { jsonb, pgEnum, pgTable, text } from 'drizzle-orm/pg-core';

import { user } from '../../auth/auth.schema';
import { encryptedJson, isoTimestamp, nanoidPk } from '../../db/columns';
import { environment } from '../../environments/environment.schema';
import type { PendingSetupPart } from '../../project-config';
import { setupRecord } from './setup-record.schema';

/**
 * What a Pending setup holds that is, or may be, a secret: every value it
 * made, the Domain hosts it picked, and the files it fills in. One opaque
 * encrypted blob (ADR-0006 "converted whole"), since nothing looks any of it
 * up by value.
 */
export interface PendingSetupBody {
  /** Each part's values, by Config name and then variable name. */
  readonly values: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** The Domain hosts the setup picked, by `{{domains.<name>}}` name. */
  readonly hosts: Readonly<Record<string, string>>;
  /**
   * The compose part's compose file, as written in the template: the stack
   * reads its values from its own `.env` (ADR-0064). Null with no compose
   * part. Made into a stack by a later Plan (#1373).
   */
  readonly composeFile: string | null;
  /** The config files, their `{{…}}` filled in, by the part they belong to. */
  readonly files: readonly {
    readonly configName: string;
    readonly path: string;
    readonly mount: string | null;
    readonly content: string;
  }[];
}

/**
 * Where a get-started wizard's setup stands on its way to the Apply
 * Cloudgate makes for it (ADR-0073):
 *
 * - `waiting`: for its Server to be Ready and set up;
 * - `applying`: the Apply is running now;
 * - `applied`: the Apply ran, and its plan's results say how each part
 *   went. A setup whose every part was created is gone, row and all, so this
 *   is only ever seen on one an Apply left parts of;
 * - `refused`: Cloudgate gave up, and `autoApplyMessage` says why. The plan,
 *   if one is open, waits for an Apply pressed by hand like any other.
 */
export const pendingSetupAutoApplyEnum = pgEnum('pending_setup_auto_apply', [
  'waiting',
  'applying',
  'applied',
  'refused',
]);

export type AutoApplyState =
  (typeof pendingSetupAutoApplyEnum.enumValues)[number];

/**
 * A **Pending setup** (ADR-0064, ADR-0065): one Template setup waiting on its
 * Environment for the Plan that creates its parts. Each Apply takes out the
 * parts it creates, values and all, and the row goes once it is empty.
 *
 * Kept by Environment, not by plan: a plan superseded by a newer one does not
 * drop it, and on a repository-kept config the plan that uses it is a push's,
 * days later. Dismissing the plan of a Cloudgate-kept config drops it, since
 * nothing else was written.
 *
 * `parts` is plain on purpose: a plan reads which Config names and kinds it
 * covers and how each value is made, and that is all a plan may show. The
 * values themselves are in `body`, encrypted (ADR-0006, ADR-0015).
 */
export const pendingSetup = pgTable('pending_setup', {
  pendingSetupId: nanoidPk('pending_setup_id'),
  environmentId: text('environment_id')
    .notNull()
    .references(() => environment.environmentId, { onDelete: 'cascade' }),
  /** The Setup record the setup left; kept if the record is dropped first. */
  setupRecordId: text('setup_record_id').references(
    () => setupRecord.setupRecordId,
    { onDelete: 'set null' },
  ),
  templateId: text('template_id').notNull(),
  revision: text('revision').notNull(),
  /** The Template's display name, for the plan's "from the Ghost template". */
  templateName: text('template_name').notNull(),
  setupName: text('setup_name').notNull(),
  /** The parts still to create: names, kinds and how each value is made. */
  parts: jsonb('parts').$type<PendingSetupPart[]>().notNull(),
  body: encryptedJson<PendingSetupBody>('body').notNull(),
  /**
   * The get-started wizard's setup (ADR-0073): the person who set it up,
   * as whom Cloudgate applies its plan once its Server is ready. Null for
   * every other setup, whose plan waits for Apply; and set null if the
   * person is deleted, so nobody's Apply is made in their name.
   */
  autoApplyBy: text('auto_apply_by').references(() => user.id, {
    onDelete: 'set null',
  }),
  /** Where that Apply stands; null when the setup asked for none. */
  autoApplyState: pendingSetupAutoApplyEnum('auto_apply_state'),
  /** Why Cloudgate gave the Apply up (`refused`); null otherwise. */
  autoApplyMessage: text('auto_apply_message'),
  createdAt: isoTimestamp('created_at'),
});

export const pendingSetupRelations = relations(pendingSetup, ({ one }) => ({
  environment: one(environment, {
    fields: [pendingSetup.environmentId],
    references: [environment.environmentId],
  }),
  setupRecord: one(setupRecord, {
    fields: [pendingSetup.setupRecordId],
    references: [setupRecord.setupRecordId],
  }),
}));

export type PendingSetup = typeof pendingSetup.$inferSelect;
