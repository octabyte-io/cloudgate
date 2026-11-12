import { relations, sql } from 'drizzle-orm';
import { pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { encryptedText, isoTimestamp, nanoidPk } from '../db/columns';
import { organization } from '../organizations/organizations.schema';

// Feature-module schema template: table + relations + inferred row type,
// colocated with the module and re-exported from db/schema.ts.
export const project = pgTable(
  'project',
  {
    projectId: nanoidPk('project_id'),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: isoTimestamp('created_at'),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    env: encryptedText('env').notNull().default(''),
  },
  // A Project's name is unique in its organization regardless of letter
  // case — the list, the rail, the scope switcher, ⌘K and the typed delete
  // confirm all show it as the only thing that tells two Projects apart.
  // `ProjectsService` turns a violation into a 409 (`mapUniqueViolation`).
  (table) => [
    uniqueIndex('unique_org_project_name').on(
      table.organizationId,
      sql`lower(${table.name})`,
    ),
  ],
);

export const projectRelations = relations(project, ({ one }) => ({
  organization: one(organization, {
    fields: [project.organizationId],
    references: [organization.id],
  }),
}));

export type Project = typeof project.$inferSelect;
