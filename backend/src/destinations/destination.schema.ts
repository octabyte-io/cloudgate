import { relations } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { encryptedText, isoTimestamp, nanoidPk } from '../db/columns';
import { organization } from '../organizations/organizations.schema';

// Org-scoped S3-compatible backup destinations. The secret access key is
// encrypted at rest (the registry/env precedent).
export const destination = pgTable('destination', {
  destinationId: nanoidPk('destination_id'),
  name: text('name').notNull(),
  provider: text('provider'),
  accessKey: text('access_key').notNull(),
  secretAccessKey: encryptedText('secret_access_key').notNull(),
  bucket: text('bucket').notNull(),
  region: text('region').notNull(),
  endpoint: text('endpoint').notNull(),
  createdAt: isoTimestamp('created_at'),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
});

export const destinationRelations = relations(destination, ({ one }) => ({
  organization: one(organization, {
    fields: [destination.organizationId],
    references: [organization.id],
  }),
}));

export type Destination = typeof destination.$inferSelect;
