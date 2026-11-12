import { relations } from 'drizzle-orm';
import { pgTable, text, unique } from 'drizzle-orm/pg-core';
import { application } from '../../applications/application.schema';
import { encryptedText, isoTimestamp, nanoidPk } from '../../db/columns';

// An application's basic-auth users, with the password encrypted at rest.
export const security = pgTable(
  'security',
  {
    securityId: nanoidPk('security_id'),
    username: text('username').notNull(),
    password: encryptedText('password').notNull(),
    createdAt: isoTimestamp('created_at'),
    applicationId: text('application_id')
      .notNull()
      .references(() => application.applicationId, { onDelete: 'cascade' }),
  },
  (t) => [unique().on(t.username, t.applicationId)],
);

export const securityRelations = relations(security, ({ one }) => ({
  application: one(application, {
    fields: [security.applicationId],
    references: [application.applicationId],
  }),
}));

export type Security = typeof security.$inferSelect;
