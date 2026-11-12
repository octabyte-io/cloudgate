import { relations } from 'drizzle-orm';
import { pgEnum, pgTable, text } from 'drizzle-orm/pg-core';
import { encryptedText, isoTimestamp, nanoidPk } from '../db/columns';
import { organization } from '../organizations/organizations.schema';

// Org-scoped docker registries. Docker Hub is a "cloud" registry with an empty
// url; the password is encrypted at rest.
export const registryTypeEnum = pgEnum('registry_type', [
  'selfHosted',
  'cloud',
]);

export type RegistryType = (typeof registryTypeEnum.enumValues)[number];

export const registry = pgTable('registry', {
  registryId: nanoidPk('registry_id'),
  name: text('name').notNull(),
  imagePrefix: text('image_prefix'),
  username: text('username').notNull(),
  password: encryptedText('password').notNull(),
  url: text('url').notNull().default(''),
  // Nothing reads this column, which is why the console stopped asking
  // for it: no reader anywhere — not the deployment engine, not
  // registry.utils.ts — ever told "cloud" from "selfHosted". What decides how
  // Cloudgate reaches a registry is `url`. Kept, defaulted and still accepted by
  // the route, so existing rows and clients are untouched; a reader that needs
  // the distinction should bring the field back with the behaviour wanting it.
  registryType: registryTypeEnum('registry_type').notNull().default('cloud'),
  createdAt: isoTimestamp('created_at'),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
});

export const registryRelations = relations(registry, ({ one }) => ({
  organization: one(organization, {
    fields: [registry.organizationId],
    references: [organization.id],
  }),
}));

export type Registry = typeof registry.$inferSelect;
