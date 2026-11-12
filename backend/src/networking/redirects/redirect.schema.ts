import { relations } from 'drizzle-orm';
import { boolean, pgTable, serial, text } from 'drizzle-orm/pg-core';
import { application } from '../../applications/application.schema';
import { isoTimestamp, nanoidPk } from '../../db/columns';

// An application's regex redirects, rendered as Traefik middlewares.
export const redirect = pgTable('redirect', {
  redirectId: nanoidPk('redirect_id'),
  regex: text('regex').notNull(),
  replacement: text('replacement').notNull(),
  permanent: boolean('permanent').notNull().default(false),
  /** Per-app unique key suffixing the Traefik middleware name. */
  uniqueConfigKey: serial('unique_config_key'),
  createdAt: isoTimestamp('created_at'),
  applicationId: text('application_id')
    .notNull()
    .references(() => application.applicationId, { onDelete: 'cascade' }),
});

export const redirectRelations = relations(redirect, ({ one }) => ({
  application: one(application, {
    fields: [redirect.applicationId],
    references: [application.applicationId],
  }),
}));

export type Redirect = typeof redirect.$inferSelect;
