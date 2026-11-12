import { relations } from 'drizzle-orm';
import { jsonb, pgTable, text } from 'drizzle-orm/pg-core';

import { isoTimestamp, nanoidPk } from '../../db/columns';
import { environment } from '../../environments/environment.schema';

/**
 * The note a **Pending setup** leaves when the 30-day sweep drops it
 * (ADR-0065 "after 30 days, with a note"): which setup it was and when it
 * went, kept on its Environment and listed beside the Pending setups still
 * waiting there, so the operator who comes back to an unapplied setup reads
 * why it is gone instead of finding nothing.
 *
 * **Why a row of its own.** Nothing else could hold it. A plan note lives on
 * one plan, and a repository-kept config may have no plan until the push the
 * setup waited for; mutating a stored plan's notes would also rewrite what
 * that plan said when it was made. The audit trail is read only with
 * `auditLog: read`, which the base member, who can read the Environment and
 * set a template up, does not hold. A log line reaches nobody. So the note
 * sits where the Pending setups are listed, `environment: read`, and goes
 * with the Environment.
 *
 * It holds nothing secret (no values, hosts or files: those went with the
 * Pending setup's encrypted body), so it is plain. The sweep removes a note
 * once it is itself {@link EXPIRED_SETUP_NOTE_DAYS} days old.
 */
export const expiredSetup = pgTable('expired_setup', {
  expiredSetupId: nanoidPk('expired_setup_id'),
  environmentId: text('environment_id')
    .notNull()
    .references(() => environment.environmentId, { onDelete: 'cascade' }),
  templateId: text('template_id').notNull(),
  templateName: text('template_name').notNull(),
  setupName: text('setup_name').notNull(),
  /** The Config names it still held, which no plan will now fill. */
  configNames: jsonb('config_names').$type<string[]>().notNull(),
  /** When the setup was made: the dropped Pending setup's `created_at`. */
  setUpAt: text('set_up_at').notNull(),
  /** When the sweep dropped it. */
  createdAt: isoTimestamp('created_at'),
});

/** How long the sweep keeps an expired setup's note. */
export const EXPIRED_SETUP_NOTE_DAYS = 30;

export const expiredSetupRelations = relations(expiredSetup, ({ one }) => ({
  environment: one(environment, {
    fields: [expiredSetup.environmentId],
    references: [environment.environmentId],
  }),
}));

export type ExpiredSetup = typeof expiredSetup.$inferSelect;
