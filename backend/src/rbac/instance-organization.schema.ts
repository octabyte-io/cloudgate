import { relations, sql } from 'drizzle-orm';
import { check, pgTable, text } from 'drizzle-orm/pg-core';
import { isoTimestamp } from '../db/columns';
import { organization } from '../organizations/organizations.schema';

/**
 * The key of the one row {@link instanceOrganization} holds. A fixed primary
 * key, so two writers racing to pin cannot each insert a row: the second
 * insert conflicts and the first pin stands.
 */
export const INSTANCE_ORGANIZATION_ROW_ID = 'instance';

/**
 * **Which Organization is the Instance organization** (CONTEXT.md, ADR-0077):
 * recorded once, and never re-derived.
 *
 * Written by `create-instance-organization` and by a Self-hosted install's
 * first sign-up, in the same transaction as the Organization it names, and
 * back-filled once by the migration that made this table, from the definition
 * it replaced (the earliest owner `member` row). Nothing in the app moves it.
 * Read through `rbac/instance-organization-pin.ts`, never directly.
 *
 * Its own table rather than a column on `recorded_instance_mode` or
 * `web_server_settings`: the first holds a mode that is `not null` and is
 * written at boot, which the command and the migration do not know, and the
 * second is made lazily on first read with a generated id.
 *
 * `restrict`, so the database itself refuses to delete the Instance
 * organization — through any path, including the cascade from its owner's
 * `user` row. The app refuses first, in words (`refuseDeletingInstanceOrganization`).
 */
export const instanceOrganization = pgTable(
  'instance_organization',
  {
    id: text('id').primaryKey().default(INSTANCE_ORGANIZATION_ROW_ID),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    pinnedAt: isoTimestamp('pinned_at'),
  },
  (table) => [
    check('instance_organization_single_row', sql`${table.id} = 'instance'`),
  ],
);

export const instanceOrganizationRelations = relations(
  instanceOrganization,
  ({ one }) => ({
    organization: one(organization, {
      fields: [instanceOrganization.organizationId],
      references: [organization.id],
    }),
  }),
);

export type InstanceOrganizationPin = typeof instanceOrganization.$inferSelect;
