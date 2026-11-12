import { relations } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import {
  encryptedText,
  generateAppName,
  isoTimestamp,
  nanoidPk,
} from '../db/columns';
import { certificateTypeEnum } from '../domains/domain.schema';
import { organization } from '../organizations/organizations.schema';
import { server } from '../servers/server.schema';

// Stored certificates, with a certificateType discriminator (reusing the
// domain table's enum): stored custom certs are 'custom'; 'letsencrypt' is reserved for resolver-managed material.
export const certificate = pgTable('certificate', {
  certificateId: nanoidPk('certificate_id'),
  name: text('name').notNull(),
  certificateData: text('certificate_data').notNull(),
  privateKey: encryptedText('private_key').notNull(),
  /** Directory name under the Traefik certs dir the files are written to. */
  certificatePath: text('certificate_path')
    .notNull()
    .unique()
    .$defaultFn(() => generateAppName('certificate')),
  certificateType: certificateTypeEnum('certificate_type')
    .notNull()
    .default('custom'),
  createdAt: isoTimestamp('created_at'),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  serverId: text('server_id').references(() => server.serverId, {
    onDelete: 'cascade',
  }),
});

export const certificateRelations = relations(certificate, ({ one }) => ({
  organization: one(organization, {
    fields: [certificate.organizationId],
    references: [organization.id],
  }),
  server: one(server, {
    fields: [certificate.serverId],
    references: [server.serverId],
  }),
}));

export type Certificate = typeof certificate.$inferSelect;
