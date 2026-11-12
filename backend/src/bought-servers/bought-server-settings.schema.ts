import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { DEFAULT_SERVER_MARKUP_PERCENT } from './pricing';

/**
 * The key of the one row {@link boughtServerSettings} holds. Fixed, so two
 * writes at once cannot each insert a row: the second conflicts and updates
 * the first's.
 */
export const BOUGHT_SERVER_SETTINGS_ID = 'instance';

/** The margin floor until an Operator sets one (spec #1387). */
export const DEFAULT_MARGIN_FLOOR_PERCENT = 10;

/**
 * The Hosted instance's **Bought Server** pricing settings (ADR-0071, spec
 * #1387): the **Server markup** and the margin floor, which only an Operator
 * changes, on the Operator page. One row, made on the first change: until
 * then the defaults hold (`BoughtServerSettings`).
 *
 * The markup prices new purchases and new lines only: each line keeps the
 * price it was sold at (`bought_server_line.monthly_cents`), so nothing here
 * is read back for a line already sold.
 */
export const boughtServerSettings = pgTable(
  'bought_server_settings',
  {
    id: text('id').primaryKey().default(BOUGHT_SERVER_SETTINGS_ID),
    /** Whole percent added to the provider's list price. */
    markupPercent: integer('markup_percent')
      .notNull()
      .default(DEFAULT_SERVER_MARKUP_PERCENT),
    /** Whole percent of the price under which a Bought Server is flagged. */
    marginFloorPercent: integer('margin_floor_percent')
      .notNull()
      .default(DEFAULT_MARGIN_FLOOR_PERCENT),
    updatedAt: timestamp('updated_at', { precision: 3 }).notNull().defaultNow(),
  },
  (table) => [
    check('bought_server_settings_single_row', sql`${table.id} = 'instance'`),
    check('bought_server_settings_markup', sql`${table.markupPercent} >= 0`),
    check(
      'bought_server_settings_margin_floor',
      sql`${table.marginFloorPercent} between 0 and 100`,
    ),
  ],
);

export type BoughtServerSettingsRow = typeof boughtServerSettings.$inferSelect;
