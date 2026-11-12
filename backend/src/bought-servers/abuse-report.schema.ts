import { relations } from 'drizzle-orm';
import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { customAlphabet } from 'nanoid';
import { organization } from '../organizations/organizations.schema';

/** A new abuse report's id: 16 lowercase letters and digits, as a Bought Server's. */
export const abuseReportId = customAlphabet(
  '0123456789abcdefghijklmnopqrstuvwxyz',
  16,
);

/** How long an Organization has to answer a forwarded abuse report. */
export const ABUSE_REPORT_DEADLINE_HOURS = 24;

/**
 * An abuse report an Operator forwarded to an Organization (ADR-0071, spec
 * #1387, #1401): the provider's report as the Operator pasted it, when it
 * was forwarded, the deadline the owners and admins were given, and who
 * forwarded it. It stays **open** until an Operator closes it, answered or
 * acted on: a deadline that passes closes nothing, and suspending stays the
 * Operator's own action.
 *
 * `forwardedBy` and `closedBy` are user ids, deliberately not foreign keys,
 * as `bought_server.terms_accepted_by`: the record outlives the account.
 */
export const abuseReport = pgTable(
  'abuse_report',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => abuseReportId()),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    /** The report as forwarded, word for word. */
    report: text('report').notNull(),
    forwardedAt: timestamp('forwarded_at', { precision: 3 }).notNull(),
    deadlineAt: timestamp('deadline_at', { precision: 3 }).notNull(),
    forwardedBy: text('forwarded_by').notNull(),
    closedAt: timestamp('closed_at', { precision: 3 }),
    closedBy: text('closed_by'),
  },
  (table) => [index('abuse_report_organization_idx').on(table.organizationId)],
);

export const abuseReportRelations = relations(abuseReport, ({ one }) => ({
  organization: one(organization, {
    fields: [abuseReport.organizationId],
    references: [organization.id],
  }),
}));

export type AbuseReport = typeof abuseReport.$inferSelect;
