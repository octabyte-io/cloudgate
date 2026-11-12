import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  integer,
  pgTable,
  text,
} from 'drizzle-orm/pg-core';
import {
  application,
  serviceTypeEnum,
} from '../applications/application.schema';
import { compose } from '../compose/compose.schema';
import { isoTimestamp, nanoidPk } from '../db/columns';

/** The windows an Error-rate threshold may be judged over, in minutes. */
export const ERROR_RATE_THRESHOLD_WINDOWS = [1, 5, 15, 30] as const;
export type ErrorRateThresholdWindow =
  (typeof ERROR_RATE_THRESHOLD_WINDOWS)[number];

/**
 * The owning Service is the one `service_type` names — `uptime_check`'s shape
 * (`test/coding-standards/parent-id-writes.spec.ts` rule 3) with two owner
 * columns, because only an Application or a Compose can have an Error rate.
 * A Database `service_type` names no column here, so the `CASE` is null and
 * the row is refused by the database as well as by the service.
 */
export const errorRateThresholdParentMatchesServiceType = check(
  'error_rate_threshold_parent_matches_service_type',
  sql`num_nonnulls("application_id", "compose_id") = 1
    AND (CASE "service_type"
           WHEN 'application' THEN "application_id"
           WHEN 'compose'     THEN "compose_id"
         END) IS NOT NULL`,
);

/** The window is one of the four the operator is offered, and nothing else. */
export const errorRateThresholdWindowAllowed = check(
  'error_rate_threshold_window_allowed',
  sql`"window_minutes" IN (1, 5, 15, 30)`,
);

/**
 * An **Error-rate threshold**: a Service's standing condition on its Error
 * rate (`CONTEXT.md`) — a percentage over a trailing window, judged only
 * when the window holds at least `min_requests` requests.
 *
 * - **At most one per Service**, as a database fact: each owner column is
 *   `UNIQUE`, and only one of them is ever set.
 * - **It goes with its Service** through the owner column's cascade, and
 *   takes its Incidents with it (theirs cascade on it), so a Delete leaves
 *   nothing and announces nothing (ADR-0018).
 * - It can exist while the Service has no Error rate yet — it is then simply
 *   never judged — so an operator can set it up before Enable request metrics.
 *
 * `percentage` is a percent (5 = 5 %); the Error rate it is compared with is
 * a fraction, as `ErrorRateTotals.errorRate` is.
 */
export const errorRateThreshold = pgTable(
  'error_rate_threshold',
  {
    errorRateThresholdId: nanoidPk('error_rate_threshold_id'),
    serviceType: serviceTypeEnum('service_type').notNull(),
    applicationId: text('application_id')
      .unique('error_rate_threshold_application_id_unique')
      .references(() => application.applicationId, { onDelete: 'cascade' }),
    composeId: text('compose_id')
      .unique('error_rate_threshold_compose_id_unique')
      .references(() => compose.composeId, { onDelete: 'cascade' }),
    percentage: doublePrecision('percentage').notNull().default(5),
    windowMinutes: integer('window_minutes').notNull().default(5),
    minRequests: integer('min_requests').notNull().default(20),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: isoTimestamp('created_at'),
  },
  () => [
    errorRateThresholdParentMatchesServiceType,
    errorRateThresholdWindowAllowed,
  ],
);

export type ErrorRateThreshold = typeof errorRateThreshold.$inferSelect;

export const errorRateThresholdRelations = relations(
  errorRateThreshold,
  ({ one }) => ({
    application: one(application, {
      fields: [errorRateThreshold.applicationId],
      references: [application.applicationId],
    }),
    compose: one(compose, {
      fields: [errorRateThreshold.composeId],
      references: [compose.composeId],
    }),
  }),
);
