import { relations } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { nanoidPk } from '../../db/columns';
import { organization } from '../../organizations/organizations.schema';

// A named role with an arbitrary resource→actions grant map, scoped to one
// organization. The role name is the join key — `member.role` holds either a
// static role name (owner/admin/member) or the name of one of these rows.
//
// `permission` is jsonb rather than text holding a JSON string: the grant map is
// structured data and this service is its only reader, so nothing has to
// stringify it on write or parse it at every read.

export type RolePermissions = Record<string, string[]>;

export const organizationRole = pgTable(
  'organization_role',
  {
    id: nanoidPk('id'),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    permission: jsonb('permission').$type<RolePermissions>().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').$onUpdate(() => new Date()),
  },
  (table) => [
    index('organizationRole_organizationId_idx').on(table.organizationId),
    index('organizationRole_role_idx').on(table.role),
  ],
);

export const organizationRoleRelations = relations(
  organizationRole,
  ({ one }) => ({
    organization: one(organization, {
      fields: [organizationRole.organizationId],
      references: [organization.id],
    }),
  }),
);

export type OrganizationRole = typeof organizationRole.$inferSelect;
