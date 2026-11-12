import { relations } from 'drizzle-orm';
import { index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { nanoidPk } from '../db/columns';
import { domain } from '../domains/domain.schema';

/**
 * One Domain's share of one request-metrics collection (ADR-0027):
 * how many requests its Server's Traefik answered for it since the previous
 * collection, how many of those were 5xx, and how many took longer than the
 * `le="1.2"` duration bucket. One row per Domain per collection tick, zeros
 * included, so "no requests" and "never collected" stay two different answers.
 *
 * **Kept 7 days with no rollups**, pruned by its own job. A Service's
 * Error rate is these rows summed over its Domains at read time
 * (`ErrorRateService`). The row cascades on its Domain, and a Domain on its
 * Service, so a Service Delete — or removing the Domain — leaves none behind
 * (ADR-0018).
 *
 * Its own file rather than `service-health.schema.ts` so the Uptime check
 * tables and this one change independently.
 */
export const errorRateSample = pgTable(
  'error_rate_sample',
  {
    errorRateSampleId: nanoidPk('error_rate_sample_id'),
    domainId: text('domain_id')
      .notNull()
      .references(() => domain.domainId, { onDelete: 'cascade' }),
    /** ISO-8601; when the counters this delta ends at were read. */
    collectedAt: text('collected_at').notNull(),
    /** Requests since the previous collection. */
    requests: integer('requests').notNull(),
    /** Of those, answered 5xx — by the app or by Traefik itself. */
    errors: integer('errors').notNull(),
    /** Of those, slower than 1.2 s. */
    slow: integer('slow').notNull(),
  },
  (table) => [
    index('error_rate_sample_domain_collected_at_idx').on(
      table.domainId,
      table.collectedAt,
    ),
    index('error_rate_sample_collected_at_idx').on(table.collectedAt),
  ],
);

export type ErrorRateSample = typeof errorRateSample.$inferSelect;

export const errorRateSampleRelations = relations(
  errorRateSample,
  ({ one }) => ({
    domain: one(domain, {
      fields: [errorRateSample.domainId],
      references: [domain.domainId],
    }),
  }),
);
