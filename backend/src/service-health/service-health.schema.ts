import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  application,
  serviceTypeEnum,
} from '../applications/application.schema';
import type { WorkloadServiceType } from '../applications/application.schema';
import { compose } from '../compose/compose.schema';
import { libsql } from '../databases/libsql/libsql.schema';
import { mariadb } from '../databases/mariadb/mariadb.schema';
import { mongo } from '../databases/mongo/mongo.schema';
import { mysql } from '../databases/mysql/mysql.schema';
import { postgres } from '../databases/postgres/postgres.schema';
import { redis } from '../databases/redis/redis.schema';
import { encryptedText, isoTimestamp, nanoidPk } from '../db/columns';
import { domain } from '../domains/domain.schema';
import { errorRateThreshold } from './error-rate-threshold.schema';

// Service health: an Uptime check, the Probes it records, and the
// Incidents a run of down Probes opens. The nouns are `CONTEXT.md`'s, and so is
// the vocabulary each rules out — no "monitor", no "health check" (that is the
// container's Swarm `HEALTHCHECK`), no "outage", no "alert".

/**
 * What an Uptime check makes its request with: an HTTP `GET` of one of
 * its Service's Domains, or a TCP connect to one of its published ports.
 */
export const uptimeCheckKindEnum = pgEnum('uptime_check_kind', ['http', 'tcp']);

export type UptimeCheckKind = (typeof uptimeCheckKindEnum.enumValues)[number];

/**
 * The owning Service is the one `service_type` names, as a database fact —
 * `mount_parent_matches_service_type`'s shape, for `mount`'s reason: the
 * discriminant, not whichever column happens to be set, is what the service
 * layer access-checks a check against (`test/coding-standards/parent-id-writes.spec.ts`
 * rule 3).
 */
export const uptimeCheckParentMatchesServiceType = check(
  'uptime_check_parent_matches_service_type',
  sql`num_nonnulls("application_id", "compose_id", "libsql_id", "mariadb_id", "mongo_id", "mysql_id", "postgres_id", "redis_id") = 1
    AND (CASE "service_type"
           WHEN 'application' THEN "application_id"
           WHEN 'compose'     THEN "compose_id"
           WHEN 'libsql'      THEN "libsql_id"
           WHEN 'mariadb'     THEN "mariadb_id"
           WHEN 'mongo'       THEN "mongo_id"
           WHEN 'mysql'       THEN "mysql_id"
           WHEN 'postgres'    THEN "postgres_id"
           WHEN 'redis'       THEN "redis_id"
         END) IS NOT NULL`,
);

/**
 * An HTTP check is aimed at one of its Service's own Domains and never at a
 * free URL (`CONTEXT.md`), so it cannot exist without one. The column is
 * nullable only because a TCP check aims at a published port instead.
 */
export const uptimeCheckHttpHasDomain = check(
  'uptime_check_http_has_domain',
  sql`"kind" <> 'http' OR "domain_id" IS NOT NULL`,
);

/**
 * A TCP check dials one published port, so it cannot exist without
 * one — and it has no Domain, keyword or header, which are an HTTP request's.
 */
export const uptimeCheckTcpHasPort = check(
  'uptime_check_tcp_has_port',
  sql`"kind" <> 'tcp' OR ("port" IS NOT NULL AND "domain_id" IS NULL AND "keyword" IS NULL AND "header_name" IS NULL AND "header_value" IS NULL)`,
);

/** Cloudgate's reason for turning a check off is only ever on an off check. */
export const uptimeCheckDisabledReasonOnlyWhenOff = check(
  'uptime_check_disabled_reason_only_when_off',
  sql`"disabled_reason" IS NULL OR "enabled" = false`,
);

/** A header value is only ever sent under a name. */
export const uptimeCheckHeaderValueHasName = check(
  'uptime_check_header_value_has_name',
  sql`"header_value" IS NULL OR "header_name" IS NOT NULL`,
);

/**
 * An **Uptime check**: a Service's standing instruction to make one request on
 * an interval and record up or down.
 *
 * - **It follows its Domain** because it holds the Domain's id, never a copy of
 *   its host: every probe reads the Domain's scheme, host and path as they are
 *   now, so an edited Domain is probed where it points. `ON DELETE CASCADE` on
 *   the Domain is "a check is deleted when its Domain is".
 * - **It goes with its Service** through the owner column's cascade, and takes
 *   its Probes and Incidents with it (theirs cascade on it), which is ADR-0018's
 *   "a Delete leaves nothing behind" and "a Delete announces nothing":
 *   no row survives to be announced.
 * - A Stop or Remove containers leaves it in place; `enabled` is the operator's
 *   off switch, which keeps the history.
 *
 * `expected_statuses` holds `2xx`-style classes and exact codes (`301`), and
 * an empty set is refused by the DTO rather than meaning "anything".
 */
export const uptimeCheck = pgTable(
  'uptime_check',
  {
    uptimeCheckId: nanoidPk('uptime_check_id'),
    // No Bucket has an uptime check: it is reached with its key.
    serviceType: serviceTypeEnum('service_type')
      .$type<WorkloadServiceType>()
      .notNull(),
    applicationId: text('application_id').references(
      () => application.applicationId,
      { onDelete: 'cascade' },
    ),
    composeId: text('compose_id').references(() => compose.composeId, {
      onDelete: 'cascade',
    }),
    libsqlId: text('libsql_id').references(() => libsql.libsqlId, {
      onDelete: 'cascade',
    }),
    mariadbId: text('mariadb_id').references(() => mariadb.mariadbId, {
      onDelete: 'cascade',
    }),
    mongoId: text('mongo_id').references(() => mongo.mongoId, {
      onDelete: 'cascade',
    }),
    mysqlId: text('mysql_id').references(() => mysql.mysqlId, {
      onDelete: 'cascade',
    }),
    postgresId: text('postgres_id').references(() => postgres.postgresId, {
      onDelete: 'cascade',
    }),
    redisId: text('redis_id').references(() => redis.redisId, {
      onDelete: 'cascade',
    }),
    kind: uptimeCheckKindEnum('kind').notNull(),
    domainId: text('domain_id').references(() => domain.domainId, {
      onDelete: 'cascade',
    }),
    intervalSeconds: integer('interval_seconds').notNull().default(60),
    timeoutSeconds: integer('timeout_seconds').notNull().default(10),
    expectedStatuses: text('expected_statuses')
      .array()
      .notNull()
      .default(sql`ARRAY['2xx']::text[]`),
    /** How many consecutive down Probes open an Incident. */
    downAfter: integer('down_after').notNull().default(3),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: isoTimestamp('created_at'),
    /**
     * When the check's current run of Probes began (US26): the run of
     * downs that opens an Incident counts only Probes after it. Set by the
     * deliberate transitions — turning the check off or on, and its Service's
     * Stop — and null until the first. A stretch the platform itself did not
     * probe (the backend down) sets nothing, so a run carries across it.
     */
    runStartedAt: text('run_started_at'),
    /**
     * A TCP check's published port, dialled on the Service's Server
     * address. The number, not a reference: a Compose's published ports live
     * in its file and nowhere else, so every kind holds the number it was
     * created against. A port its Service stops publishing is never dialled
     * again: the probe tick turns the check off with {@link disabledReason}
     * instead, and never retargets it, because nothing says which port
     * replaced it.
     */
    port: integer('port'),
    /**
     * Why **Cloudgate** turned the check off, as a sentence the Health tab
     * shows beside it — that its port is no longer published, or that its
     * Service has no Server address to dial it on (`tcpPlaceOf`).
     * Null whenever the check is on or the operator turned it off, so
     * an operator's off switch never reads as Cloudgate's; written only with
     * `enabled = false` (`uptime_check_disabled_reason_only_when_off`), and
     * cleared by the operator's next write of `enabled` or `port`.
     */
    disabledReason: text('disabled_reason'),
    /**
     * An HTTP check's required keyword: a body without it is down with
     * `keyword missing`. Not a secret, and never in a Notification all the
     * same, which names only the target and the error class.
     */
    keyword: text('keyword'),
    /** The one header an HTTP check sends, by name. */
    headerName: text('header_name'),
    /**
     * That header's value — a bearer token, as often as not — encrypted at
     * rest and **write-only**: accepted on a create and an update, never
     * answered by any read, which says only `hasHeaderValue`. Registered
     * in `secret-bearing-columns.spec.ts`' `ENCRYPTED_BY_ARGUMENT`, because
     * neither word of its name is one the credential vocabulary can match.
     */
    headerValue: encryptedText('header_value'),
  },
  () => [
    uptimeCheckParentMatchesServiceType,
    uptimeCheckHttpHasDomain,
    uptimeCheckTcpHasPort,
    uptimeCheckHeaderValueHasName,
    uptimeCheckDisabledReasonOnlyWhenOff,
  ],
);

export type UptimeCheck = typeof uptimeCheck.$inferSelect;

/** The uptime-check FK column each service type's checks hang off. */
export const uptimeCheckServiceFk = {
  application: uptimeCheck.applicationId,
  postgres: uptimeCheck.postgresId,
  mysql: uptimeCheck.mysqlId,
  mariadb: uptimeCheck.mariadbId,
  mongo: uptimeCheck.mongoId,
  redis: uptimeCheck.redisId,
  compose: uptimeCheck.composeId,
  libsql: uptimeCheck.libsqlId,
} as const;

export const probeVerdictEnum = pgEnum('probe_verdict', ['up', 'down']);

export type ProbeVerdict = (typeof probeVerdictEnum.enumValues)[number];

/**
 * A **Probe**: one execution of an Uptime check, and its verdict.
 *
 * Two verdicts and no third: a timeout, a DNS failure or a refused connection
 * is `down`. `error_class` is the short reason a down Probe carries
 * (`timeout`, `dns`, `refused`, `tls`, `connection`, `status 503`) and is null
 * on an up one. **A body is never stored**, and neither is anything a response
 * said about itself beyond its status code.
 *
 * Kept for seven days, pruned by `ServiceHealthScheduler`'s own job and never by
 * the monitoring `retentionDays`, which is a Server's metrics setting.
 */
export const probe = pgTable(
  'probe',
  {
    probeId: nanoidPk('probe_id'),
    uptimeCheckId: text('uptime_check_id')
      .notNull()
      .references(() => uptimeCheck.uptimeCheckId, { onDelete: 'cascade' }),
    probedAt: text('probed_at').notNull(),
    verdict: probeVerdictEnum('verdict').notNull(),
    /** Until the status line arrived; null when nothing did. */
    latencyMs: integer('latency_ms'),
    errorClass: text('error_class'),
  },
  (table) => [
    index('probe_uptime_check_probed_at_idx').on(
      table.uptimeCheckId,
      table.probedAt,
    ),
    index('probe_probed_at_idx').on(table.probedAt),
  ],
);

export type Probe = typeof probe.$inferSelect;

/**
 * Why an Incident closed. A Delete closes none: it removes it.
 * `port-unpublished` is a TCP check turned off by the probe tick because its
 * Service no longer publishes its port.
 */
export const incidentCloseReasonEnum = pgEnum('incident_close_reason', [
  'recovered',
  'service-stopped',
  'turned-off',
  'port-unpublished',
]);

export type IncidentCloseReason =
  (typeof incidentCloseReasonEnum.enumValues)[number];

/**
 * **An Incident belongs to exactly one owner**: an Uptime check or an
 * Error-rate threshold.
 */
export const incidentExactlyOneOwner = check(
  'incident_exactly_one_owner',
  sql`num_nonnulls("uptime_check_id", "error_rate_threshold_id") = 1`,
);

/**
 * A threshold's Incident carries the rate and request count that opened it
 * and the worst rate while open; a check's carries none of them.
 */
export const incidentThresholdHasRates = check(
  'incident_threshold_has_rates',
  sql`("error_rate_threshold_id" IS NULL) = ("opening_error_rate" IS NULL)
    AND ("error_rate_threshold_id" IS NULL) = ("opening_requests" IS NULL)
    AND ("error_rate_threshold_id" IS NULL) = ("worst_error_rate" IS NULL)`,
);

/** A close reason is written with the close and never without it. */
export const incidentClosedHasReason = check(
  'incident_closed_has_reason',
  sql`("closed_at" IS NULL) = ("close_reason" IS NULL)`,
);

/**
 * An **Incident**: the stretch during which one Uptime check is held to be
 * down, kept so that it is announced once when it opens and once when
 * it closes, and kept for the life of its owner.
 *
 * `opening_error` is the error class of the Probe that opened a check's
 * Incident. A threshold's carries instead the Error rate (a fraction) and the
 * request count of the window that opened it, and the worst rate of any
 * judged window while it was open.
 *
 * **At most one open Incident per Uptime check, as a database fact**
 * (`incident_one_open_per_uptime_check`). The judgement that opens one
 * is a read-then-write, and the partial unique index is what makes two racing
 * judgements of one check insert one row between them: the second insert
 * conflicts, and `ON CONFLICT DO NOTHING` returns nothing to announce. It is
 * keyed on the owner column rather than on a generic owner id so that each
 * owner kind gets its own index of this shape —
 * `incident_one_open_per_error_rate_threshold` is the threshold's.
 */
export const incident = pgTable(
  'incident',
  {
    incidentId: nanoidPk('incident_id'),
    uptimeCheckId: text('uptime_check_id').references(
      () => uptimeCheck.uptimeCheckId,
      { onDelete: 'cascade' },
    ),
    errorRateThresholdId: text('error_rate_threshold_id').references(
      () => errorRateThreshold.errorRateThresholdId,
      { onDelete: 'cascade' },
    ),
    openedAt: text('opened_at').notNull(),
    closedAt: text('closed_at'),
    openingError: text('opening_error'),
    /** Threshold only: the opening window's Error rate, a fraction. */
    openingErrorRate: doublePrecision('opening_error_rate'),
    /** Threshold only: the opening window's request count. */
    openingRequests: integer('opening_requests'),
    /** Threshold only: the worst judged window's rate while open. */
    worstErrorRate: doublePrecision('worst_error_rate'),
    closeReason: incidentCloseReasonEnum('close_reason'),
  },
  (table) => [
    incidentExactlyOneOwner,
    incidentClosedHasReason,
    incidentThresholdHasRates,
    uniqueIndex('incident_one_open_per_uptime_check')
      .on(table.uptimeCheckId)
      .where(sql`${table.closedAt} IS NULL`),
    uniqueIndex('incident_one_open_per_error_rate_threshold')
      .on(table.errorRateThresholdId)
      .where(sql`${table.closedAt} IS NULL`),
    index('incident_uptime_check_opened_at_idx').on(
      table.uptimeCheckId,
      table.openedAt,
    ),
    index('incident_error_rate_threshold_opened_at_idx').on(
      table.errorRateThresholdId,
      table.openedAt,
    ),
  ],
);

export type Incident = typeof incident.$inferSelect;

export const uptimeCheckRelations = relations(uptimeCheck, ({ one, many }) => ({
  application: one(application, {
    fields: [uptimeCheck.applicationId],
    references: [application.applicationId],
  }),
  compose: one(compose, {
    fields: [uptimeCheck.composeId],
    references: [compose.composeId],
  }),
  libsql: one(libsql, {
    fields: [uptimeCheck.libsqlId],
    references: [libsql.libsqlId],
  }),
  mariadb: one(mariadb, {
    fields: [uptimeCheck.mariadbId],
    references: [mariadb.mariadbId],
  }),
  mongo: one(mongo, {
    fields: [uptimeCheck.mongoId],
    references: [mongo.mongoId],
  }),
  mysql: one(mysql, {
    fields: [uptimeCheck.mysqlId],
    references: [mysql.mysqlId],
  }),
  postgres: one(postgres, {
    fields: [uptimeCheck.postgresId],
    references: [postgres.postgresId],
  }),
  redis: one(redis, {
    fields: [uptimeCheck.redisId],
    references: [redis.redisId],
  }),
  domain: one(domain, {
    fields: [uptimeCheck.domainId],
    references: [domain.domainId],
  }),
  probes: many(probe),
  incidents: many(incident),
}));

export const probeRelations = relations(probe, ({ one }) => ({
  uptimeCheck: one(uptimeCheck, {
    fields: [probe.uptimeCheckId],
    references: [uptimeCheck.uptimeCheckId],
  }),
}));

export const incidentRelations = relations(incident, ({ one }) => ({
  uptimeCheck: one(uptimeCheck, {
    fields: [incident.uptimeCheckId],
    references: [uptimeCheck.uptimeCheckId],
  }),
  errorRateThreshold: one(errorRateThreshold, {
    fields: [incident.errorRateThresholdId],
    references: [errorRateThreshold.errorRateThresholdId],
  }),
}));
