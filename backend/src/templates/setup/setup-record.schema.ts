import { relations } from 'drizzle-orm';
import { jsonb, pgTable, text } from 'drizzle-orm/pg-core';

import { isoTimestamp, nanoidPk } from '../../db/columns';
import { project } from '../../projects/project.schema';

/**
 * A **Setup record** (ADR-0065): which Config names a Project took from which
 * Template revision, under which setup name. One plain row per setup. It is a
 * fact, never a link: nothing reads it to update the copy, which gets no
 * updates. A later Plan may read it to hold a setup's parts back in an
 * Environment it was not set up in (#1377), and a later feature may read it
 * to say a newer revision exists; neither changes what it records.
 *
 * Nothing in it is a secret, so it is plain (ADR-0006 encrypts what is).
 */
export const setupRecord = pgTable('setup_record', {
  setupRecordId: nanoidPk('setup_record_id'),
  projectId: text('project_id')
    .notNull()
    .references(() => project.projectId, { onDelete: 'cascade' }),
  /** The Template's id: its folder name, which never changes. */
  templateId: text('template_id').notNull(),
  /** The last catalogue commit that changed the template's folder. */
  revision: text('revision').notNull(),
  setupName: text('setup_name').notNull(),
  /** The Config names it made, one per part. */
  configNames: jsonb('config_names').$type<string[]>().notNull(),
  createdAt: isoTimestamp('created_at'),
});

export const setupRecordRelations = relations(setupRecord, ({ one }) => ({
  project: one(project, {
    fields: [setupRecord.projectId],
    references: [project.projectId],
  }),
}));

export type SetupRecord = typeof setupRecord.$inferSelect;
