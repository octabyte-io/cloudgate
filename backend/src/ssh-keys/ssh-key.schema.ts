import { relations } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { encryptedText, isoTimestamp, nanoidPk } from '../db/columns';
import { organization } from '../organizations/organizations.schema';

// Org-scoped keypairs; the private key is encrypted at rest via encryptedText.
export const sshKey = pgTable('ssh_key', {
  sshKeyId: nanoidPk('ssh_key_id'),
  name: text('name').notNull(),
  description: text('description'),
  publicKey: text('public_key').notNull(),
  privateKey: encryptedText('private_key').notNull().default(''),
  createdAt: isoTimestamp('created_at'),
  lastUsedAt: text('last_used_at'),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
});

export const sshKeyRelations = relations(sshKey, ({ one }) => ({
  organization: one(organization, {
    fields: [sshKey.organizationId],
    references: [organization.id],
  }),
}));

export type SshKey = typeof sshKey.$inferSelect;
