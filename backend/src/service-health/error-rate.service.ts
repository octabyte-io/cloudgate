import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, gte, lte, max, sql, sum } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { application } from '../applications/application.schema';
import type { ServiceType } from '../applications/application.schema';
import { compose } from '../compose/compose.schema';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { domain, errorRateSample } from '../db/schema';
import type { ErrorRateOwner } from './error-rate-index';
import { REQUEST_METRICS_STATE } from './request-metrics-state.port';
import type { RequestMetricsState } from './request-metrics-state.port';

/**
 * Why a Service has no Error rate — a closed set, and each sentence is what the
 * console and MCP show, verbatim (spec user story 51). There is no 0 %
 * among them: a Service that cannot have a rate says why instead.
 */
export const ERROR_RATE_UNAVAILABLE = {
  database: 'Databases have no Error rate',
  'no-domain': 'No Domain',
  'metrics-not-enabled': 'Request metrics not enabled on this Server',
  'no-samples': 'No samples yet',
} as const;

export type ErrorRateUnavailableReason = keyof typeof ERROR_RATE_UNAVAILABLE;

/** The summary's window: the last 24 hours, charted in 15-minute buckets. */
export const ERROR_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const ERROR_RATE_BUCKET_MS = 15 * 60 * 1000;
export const ERROR_RATE_BUCKETS = ERROR_RATE_WINDOW_MS / ERROR_RATE_BUCKET_MS;

/** Summed deltas and the two shares they give; a share is null with no requests. */
export interface ErrorRateTotals {
  requests: number;
  errors: number;
  slow: number;
  /** errors / requests; null when there were no requests — never 0 %. */
  errorRate: number | null;
  /** slow / requests; null when there were no requests. */
  slowShare: number | null;
}

/** {@link ErrorRateTotals} over a window, with how many samples it covered. */
export interface ErrorRateWindow extends ErrorRateTotals {
  /** Sample rows in the window, zero-request rows included. */
  samples: number;
}

/** One 15-minute bucket of the chart; all zero is "no requests". */
export interface ErrorRateBucket extends ErrorRateTotals {
  /** ISO-8601 start of the bucket. */
  start: string;
}

/** One of the Service's Domains over the window. */
export interface ErrorRateDomain extends ErrorRateTotals {
  domainId: string;
  host: string;
}

/** The summary's `errorRate`: the rate, or the reason there is none. */
export type ErrorRateView =
  | {
      available: false;
      reason: ErrorRateUnavailableReason;
      /** `ERROR_RATE_UNAVAILABLE[reason]`, to be shown as it is. */
      message: string;
    }
  | {
      available: true;
      /** ISO-8601 start of the window the figures cover. */
      since: string;
      /** When the Service's newest sample was collected. */
      lastCollectedAt: string;
      totals: ErrorRateTotals;
      /** {@link ERROR_RATE_BUCKETS} buckets, oldest first, the last ending now. */
      series: ErrorRateBucket[];
      /** Every Domain of the Service, host order. */
      domains: ErrorRateDomain[];
    };

/**
 * A Service's Error rate, read from its Domains' samples (ADR-0027): the
 * `errorRate` of `GET /service-health/...`, and the windowed read the
 * Error-rate threshold judges on. Authorization is the caller's.
 */
@Injectable()
export class ErrorRateService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(REQUEST_METRICS_STATE)
    private readonly requestMetrics: RequestMetricsState,
  ) {}

  /**
   * Why the Service cannot have an Error rate at all, or null when it can.
   * `no-samples` is not answered here: it depends on the samples, which
   * {@link forService} and {@link windowTotals} read anyway.
   */
  async unavailableReason(
    serviceType: ServiceType,
    serviceId: string,
  ): Promise<Exclude<ErrorRateUnavailableReason, 'no-samples'> | null> {
    if (serviceType !== 'application' && serviceType !== 'compose') {
      return 'database';
    }
    let serverId: string | null;
    if (serviceType === 'compose') {
      const [row] = await this.db
        .select({ serverId: compose.serverId })
        .from(compose)
        .where(eq(compose.composeId, serviceId))
        .limit(1);
      serverId = row?.serverId ?? null;
    } else {
      const [row] = await this.db
        .select({ serverId: application.serverId })
        .from(application)
        .where(eq(application.applicationId, serviceId))
        .limit(1);
      serverId = row?.serverId ?? null;
    }
    const [{ domains }] = await this.db
      .select({ domains: sql<number>`count(*)::int` })
      .from(domain)
      .where(ownedBy({ serviceType, serviceId }));
    if (domains === 0) return 'no-domain';
    if (!(await this.requestMetrics.isEnabled(serverId))) {
      return 'metrics-not-enabled';
    }
    return null;
  }

  /**
   * The Service's summed deltas over the trailing window `(now - windowMs,
   * now]`. What an Error-rate threshold is judged on each collection tick:
   * `requests` against the minimum request count, `errorRate` against the
   * percentage, and `samples === 0` for "nothing collected in the window".
   * One query; it does not ask {@link unavailableReason}.
   */
  async windowTotals(
    owner: ErrorRateOwner,
    windowMs: number,
    now: number,
  ): Promise<ErrorRateWindow> {
    const [row] = await this.db
      .select({
        requests: sum(errorRateSample.requests),
        errors: sum(errorRateSample.errors),
        slow: sum(errorRateSample.slow),
        samples: sql<number>`count(*)::int`,
      })
      .from(errorRateSample)
      .innerJoin(domain, eq(domain.domainId, errorRateSample.domainId))
      .where(
        and(
          ownedBy(owner),
          gt(
            errorRateSample.collectedAt,
            new Date(now - windowMs).toISOString(),
          ),
          lte(errorRateSample.collectedAt, new Date(now).toISOString()),
        ),
      );
    return {
      ...totals(
        Number(row?.requests ?? 0),
        Number(row?.errors ?? 0),
        Number(row?.slow ?? 0),
      ),
      samples: Number(row?.samples ?? 0),
    };
  }

  /**
   * Whether {@link forService} would answer `available: true`: no
   * unavailable reason and at least one sample kept. The Environment's Health
   * column asks it of each enabled Error-rate threshold, which counts
   * as watching the Service only when there is a rate to judge.
   */
  async isAvailable(owner: ErrorRateOwner): Promise<boolean> {
    if (await this.unavailableReason(owner.serviceType, owner.serviceId)) {
      return false;
    }
    const [sample] = await this.db
      .select({ id: errorRateSample.errorRateSampleId })
      .from(errorRateSample)
      .innerJoin(domain, eq(domain.domainId, errorRateSample.domainId))
      .where(ownedBy(owner))
      .limit(1);
    return sample !== undefined;
  }

  /** The summary's `errorRate` at the clock's `now`. */
  async forService(
    serviceType: ServiceType,
    serviceId: string,
    now: number,
  ): Promise<ErrorRateView> {
    const reason = await this.unavailableReason(serviceType, serviceId);
    if (reason) return unavailable(reason);
    const owner: ErrorRateOwner = {
      serviceType: serviceType as ErrorRateOwner['serviceType'],
      serviceId,
    };

    const [[latest], domains] = await Promise.all([
      this.db
        .select({ at: max(errorRateSample.collectedAt) })
        .from(errorRateSample)
        .innerJoin(domain, eq(domain.domainId, errorRateSample.domainId))
        .where(ownedBy(owner)),
      this.db
        .select({ domainId: domain.domainId, host: domain.host })
        .from(domain)
        .where(ownedBy(owner))
        .orderBy(asc(domain.host), asc(domain.domainId)),
    ]);
    if (!latest?.at) return unavailable('no-samples');

    const from = seriesStart(now);
    const bucket = sql<number>`floor((extract(epoch from ${errorRateSample.collectedAt}::timestamptz) * 1000 - ${from}) / ${ERROR_RATE_BUCKET_MS})::int`;
    const rows = await this.db
      .select({
        domainId: errorRateSample.domainId,
        bucket,
        requests: sum(errorRateSample.requests),
        errors: sum(errorRateSample.errors),
        slow: sum(errorRateSample.slow),
      })
      .from(errorRateSample)
      .innerJoin(domain, eq(domain.domainId, errorRateSample.domainId))
      .where(
        and(
          ownedBy(owner),
          gte(errorRateSample.collectedAt, new Date(from).toISOString()),
          lte(errorRateSample.collectedAt, new Date(now).toISOString()),
        ),
      )
      // By position, for the strip's reason (service-health.service.ts).
      .groupBy(sql`1, 2`);

    const buckets = Array.from({ length: ERROR_RATE_BUCKETS }, () => ({
      requests: 0,
      errors: 0,
      slow: 0,
    }));
    const perDomain = new Map(
      domains.map((d) => [d.domainId, { requests: 0, errors: 0, slow: 0 }]),
    );
    const all = { requests: 0, errors: 0, slow: 0 };
    for (const row of rows) {
      const counts = {
        requests: Number(row.requests ?? 0),
        errors: Number(row.errors ?? 0),
        slow: Number(row.slow ?? 0),
      };
      for (const target of [
        buckets[Number(row.bucket)],
        perDomain.get(row.domainId),
        all,
      ]) {
        if (!target) continue;
        target.requests += counts.requests;
        target.errors += counts.errors;
        target.slow += counts.slow;
      }
    }

    return {
      available: true,
      since: new Date(from).toISOString(),
      lastCollectedAt: latest.at,
      totals: totals(all.requests, all.errors, all.slow),
      series: buckets.map((b, index) => ({
        start: new Date(from + index * ERROR_RATE_BUCKET_MS).toISOString(),
        ...totals(b.requests, b.errors, b.slow),
      })),
      domains: domains.map((d) => {
        const counts = perDomain.get(d.domainId) ?? all;
        return {
          domainId: d.domainId,
          host: d.host,
          ...totals(counts.requests, counts.errors, counts.slow),
        };
      }),
    };
  }
}

/** A Service's Domains, by the column its kind hangs them off. */
function ownedBy(owner: ErrorRateOwner): SQL {
  return owner.serviceType === 'application'
    ? eq(domain.applicationId, owner.serviceId)
    : eq(domain.composeId, owner.serviceId);
}

function unavailable(reason: ErrorRateUnavailableReason): ErrorRateView {
  return { available: false, reason, message: ERROR_RATE_UNAVAILABLE[reason] };
}

function totals(
  requests: number,
  errors: number,
  slow: number,
): ErrorRateTotals {
  return {
    requests,
    errors,
    slow,
    errorRate: requests === 0 ? null : errors / requests,
    slowShare: requests === 0 ? null : slow / requests,
  };
}

/**
 * The start of the chart's oldest bucket: 96 quarter-hours back from the one
 * `now` is in. Buckets are half-open, `[start, start + 15 min)`, and the
 * summary reads samples in `[from, now]`.
 */
function seriesStart(now: number): number {
  const current = Math.floor(now / ERROR_RATE_BUCKET_MS) * ERROR_RATE_BUCKET_MS;
  return current - (ERROR_RATE_BUCKETS - 1) * ERROR_RATE_BUCKET_MS;
}
