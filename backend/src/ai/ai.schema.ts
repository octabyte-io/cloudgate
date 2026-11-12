import { relations } from 'drizzle-orm';
import { boolean, pgTable, text } from 'drizzle-orm/pg-core';
import { encryptedText, isoTimestamp, nanoidPk } from '../db/columns';
import { organization } from '../organizations/organizations.schema';

// Org-scoped AI provider configs for AI-assisted compose generation. The
// apiKey is encrypted at rest and never leaves the server.
export const ai = pgTable('ai', {
  aiId: nanoidPk('ai_id'),
  name: text('name').notNull(),
  apiUrl: text('api_url').notNull(),
  apiKey: encryptedText('api_key').notNull(),
  model: text('model').notNull(),
  isEnabled: boolean('is_enabled').notNull().default(true),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  createdAt: isoTimestamp('created_at'),
});

export const aiRelations = relations(ai, ({ one }) => ({
  organization: one(organization, {
    fields: [ai.organizationId],
    references: [organization.id],
  }),
}));

export type Ai = typeof ai.$inferSelect;
