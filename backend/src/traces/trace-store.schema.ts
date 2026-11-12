import { relations, sql } from 'drizzle-orm';
import { boolean, check, integer, pgTable, text } from 'drizzle-orm/pg-core';
import {
  application,
  serviceTypeEnum,
} from '../applications/application.schema';
import { compose } from '../compose/compose.schema';
import { encryptedText, isoTimestamp, nanoidPk } from '../db/columns';

/** How long a Trace store keeps traces, in days: 1, 3 or 7. */
export const TRACE_RETENTION_DAYS = [1, 3, 7] as const;
export type TraceRetentionDays = (typeof TRACE_RETENTION_DAYS)[number];
export const DEFAULT_TRACE_RETENTION_DAYS: TraceRetentionDays = 3;

/**
 * The owning Service is the one `service_type` names, in the Error-rate
 * threshold's shape (`error_rate_threshold_parent_matches_service_type`): two
 * owner columns, because only an Application or a Compose can have a Trace
 * store (ADR-0028). A Database `service_type` names no column here, so the
 * `CASE` is null and the row is refused by the database as well as by the
 * service.
 */
export const traceStoreParentMatchesServiceType = check(
  'trace_store_parent_matches_service_type',
  sql`num_nonnulls("application_id", "compose_id") = 1
    AND (CASE "service_type"
           WHEN 'application' THEN "application_id"
           WHEN 'compose'     THEN "compose_id"
         END) IS NOT NULL`,
);

/** Retention is one of the three the operator is offered, and nothing else. */
export const traceStoreRetentionAllowed = check(
  'trace_store_retention_allowed',
  sql`"retention_days" IN (1, 3, 7)`,
);

/**
 * A Service's **traces** setting, and the two credentials of its Trace store
 * (ADR-0028, `CONTEXT.md`).
 *
 * - **At most one per Service**, as a database fact: each owner column is
 *   `UNIQUE` and only one of them is ever set. It goes with its Service by the
 *   owner column's cascade — but its store does not, which is why both
 *   Deletes read this row and reclaim the store before the row goes
 *   (`traces/trace-store.ts`' `reclaimTraceStores`).
 * - **Turning traces off keeps the row** with `enabled` false, so a later
 *   turn-on keeps the operator's retention and the Service's credential. The
 *   store itself is removed at turn-off.
 * - **`credential`** is the password half of the `basicauth` the store's OTLP
 *   receiver checks, handed to the Service at deploy in
 *   `OTEL_EXPORTER_OTLP_HEADERS` and never written as an env row.
 * - **`queryCredential`** is the password its UI and query API check, which
 *   only the backend holds. It exists because the store is on
 *   `cloudgate-network` so its Service can reach the receiver, and every other
 *   Service's container is on that network too: without it any container on
 *   the Server could read any store's traces by its container name, which is
 *   the entitlement boundary ADR-0028 draws around the store. The Service's
 *   own credential is not reused for it, so a traced app cannot read even its
 *   own store around the backend.
 *
 * Both are encrypted at rest (ADR-0006) and a response names only that the
 * first exists, `hasCredential` (ADR-0019).
 */
export const traceStore = pgTable(
  'trace_store',
  {
    traceStoreId: nanoidPk('trace_store_id'),
    serviceType: serviceTypeEnum('service_type').notNull(),
    applicationId: text('application_id')
      .unique('trace_store_application_id_unique')
      .references(() => application.applicationId, { onDelete: 'cascade' }),
    composeId: text('compose_id')
      .unique('trace_store_compose_id_unique')
      .references(() => compose.composeId, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(false),
    retentionDays: integer('retention_days')
      .notNull()
      .default(DEFAULT_TRACE_RETENTION_DAYS),
    credential: encryptedText('credential').notNull(),
    queryCredential: encryptedText('query_credential').notNull(),
    createdAt: isoTimestamp('created_at'),
  },
  () => [traceStoreParentMatchesServiceType, traceStoreRetentionAllowed],
);

export type TraceStore = typeof traceStore.$inferSelect;

export const traceStoreRelations = relations(traceStore, ({ one }) => ({
  application: one(application, {
    fields: [traceStore.applicationId],
    references: [application.applicationId],
  }),
  compose: one(compose, {
    fields: [traceStore.composeId],
    references: [compose.composeId],
  }),
}));
