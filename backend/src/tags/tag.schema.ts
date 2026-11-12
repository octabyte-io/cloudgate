import { relations, sql } from 'drizzle-orm';
import { pgTable, text, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { isoTimestamp, nanoidPk } from '../db/columns';
import { organization } from '../organizations/organizations.schema';
import { project } from '../projects/project.schema';

// Org-scoped labels plus the project↔tag join.
export const tag = pgTable(
  'tag',
  {
    tagId: nanoidPk('tag_id'),
    name: text('name').notNull(),
    color: text('color'),
    createdAt: isoTimestamp('created_at'),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
  },
  (table) => [
    uniqueIndex('unique_org_tag_name').on(
      table.organizationId,
      sql`lower(${table.name})`,
    ),
  ],
);

export const projectTag = pgTable(
  'project_tag',
  {
    id: nanoidPk('id'),
    projectId: text('project_id')
      .notNull()
      .references(() => project.projectId, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tag.tagId, { onDelete: 'cascade' }),
  },
  (table) => [unique('unique_project_tag').on(table.projectId, table.tagId)],
);

export const tagRelations = relations(tag, ({ one, many }) => ({
  organization: one(organization, {
    fields: [tag.organizationId],
    references: [organization.id],
  }),
  projectTags: many(projectTag),
}));

export const projectTagRelations = relations(projectTag, ({ one }) => ({
  project: one(project, {
    fields: [projectTag.projectId],
    references: [project.projectId],
  }),
  tag: one(tag, {
    fields: [projectTag.tagId],
    references: [tag.tagId],
  }),
}));

export type Tag = typeof tag.$inferSelect;
