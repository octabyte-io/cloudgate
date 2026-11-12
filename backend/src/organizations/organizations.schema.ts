import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { user } from '../auth/auth.schema';

// better-auth organization-plugin tables (teams enabled). `ownerId` and
// `member.isDefault` are Cloudgate's own columns on top of the plugin's models.
export const organization = pgTable(
  'organization',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => nanoid()),
    name: text('name').notNull(),
    slug: text('slug').unique(),
    logo: text('logo'),
    createdAt: timestamp('created_at').notNull(),
    metadata: text('metadata'),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /**
     * The **Paying Organization** of an **Attached Organization** (CONTEXT.md,
     * ADR-0059); null for one that pays for itself. One level only: the
     * Organization it names is never attached itself. Read through
     * `cloud/billing/paying-organization.ts`, never directly, so the counts,
     * the paid features, the Billing views and the Operator's counts all find
     * the same payer.
     *
     * `restrict` rather than the usual `cascade` or `set null`: deleting a
     * Paying Organization must never take its customers' Organizations with
     * it, nor quietly leave them paying for themselves, so the database itself
     * refuses while any is attached.
     */
    paidByOrganizationId: text('paid_by_organization_id').references(
      (): AnyPgColumn => organization.id,
      { onDelete: 'restrict' },
    ),
  },
  (table) => [
    // For "owns an Organization that pays for itself", which counts by owner.
    index('organization_owner_id_idx').on(table.ownerId),
  ],
);

export const member = pgTable(
  'member',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => nanoid()),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    createdAt: timestamp('created_at').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    // Row-level access grants for non-privileged roles
    accessedProjects: text('accessed_projects')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    accessedServices: text('accessed_services')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    accessedEnvironments: text('accessed_environments')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
  },
  (table) => [
    // One membership per user per Organization. An Agent has exactly
    // one for life, and that is what makes `AuthService.validateApiKey`'s
    // default-membership resolution correct for it with no organization
    // argument: with a second row it would act in whichever sorted first
    // (ADR-0023). Nothing wrote a duplicate for a person either — better-auth
    // refuses to invite an existing member — so this states a rule rather than
    // introducing one; `0073_agents.sql` says what it does to a stray pair.
    uniqueIndex('member_user_organization_unique').on(
      table.userId,
      table.organizationId,
    ),
    /**
     * `system` is the platform's role on an audit row with no caller
     * (ADR-0026's platform-actor pin, `PLATFORM_ACTOR_ROLE` in
     * `enterprise/audit-logs/platform-actor.ts`), so no Member may hold it —
     * alone or inside the comma list better-auth reads a role string as.
     * In the database rather than only in `member-role.ts`, because rows
     * better-auth creates itself (an accepted invitation, an SSO or SCIM join)
     * never pass through that writer.
     */
    check(
      'member_role_is_not_the_platform',
      sql`NOT ('system' = ANY (string_to_array(replace(${table.role}, ' ', ''), ',')))`,
    ),
  ],
);

export const invitation = pgTable('invitation', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => nanoid()),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role'),
  status: text('status').notNull(),
  teamId: text('team_id'),
  expiresAt: timestamp('expires_at').notNull(),
  inviterId: text('inviter_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const team = pgTable('team', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => nanoid()),
  name: text('name').notNull(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at'),
});

export const teamMember = pgTable('team_member', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => nanoid()),
  teamId: text('team_id')
    .notNull()
    .references(() => team.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export type Organization = typeof organization.$inferSelect;
export type Member = typeof member.$inferSelect;
export type Invitation = typeof invitation.$inferSelect;
export type Team = typeof team.$inferSelect;
export type TeamMember = typeof teamMember.$inferSelect;
