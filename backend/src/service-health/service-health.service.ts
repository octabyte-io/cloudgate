import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { serviceTypeEnum } from '../applications/application.schema';
import type { ServiceType } from '../applications/application.schema';
import {
  buildPaginationMeta,
  toOffsetLimit,
} from '../common/pagination/pagination';
import type { PaginationMeta } from '../common/pagination/pagination';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { incident, probe } from '../db/schema';
import type { PermissionCtx } from '../rbac/permission.service';
import type { ServiceHealthQueryDto } from './dto/service-health.dto';
import { ErrorRateService } from './error-rate.service';
import type { ErrorRateView } from './error-rate.service';
import { ErrorRateThresholdsService } from './error-rate-thresholds.service';
import type { ErrorRateThresholdView } from './error-rate-thresholds.service';
import { SERVICE_HEALTH_CLOCK } from './service-health.clock';
import type { ServiceHealthClock } from './service-health.clock';
import type {
  Incident,
  IncidentCloseReason,
  ProbeVerdict,
} from './service-health.schema';
import { worstState } from './environment-health.service';
import type { ServiceHealthState } from './environment-health.service';
import { ownerStatus } from './service-owner';
import { UptimeChecksService } from './uptime-checks.service';
import type { UptimeCheckView } from './uptime-checks.service';

/** The 24-hour strip: 48 half-hour buckets, oldest first, ending now. */
export const STRIP_BUCKETS = 48;
export const STRIP_BUCKET_MS = 30 * 60 * 1000;

/** One Probe as the summary answers it. */
export interface ProbeView {
  probedAt: string;
  verdict: ProbeVerdict;
  latencyMs: number | null;
  errorClass: string | null;
}

/** One half-hour of the 24-hour strip; both zero is "not probed". */
export interface StripBucket {
  /** ISO-8601 start of the bucket. */
  start: string;
  up: number;
  down: number;
}

/** A check in the summary: its definition, last Probe and 24 hours. */
export interface UptimeCheckHealth extends UptimeCheckView {
  lastProbe: ProbeView | null;
  strip: StripBucket[];
  /** Up Probes over all Probes in the last 24 hours; null with none. */
  upShare24h: number | null;
}

/** An Incident as every read answers it. */
export interface IncidentView {
  incidentId: string;
  /** What owns it: an Uptime check or the Error-rate threshold. */
  source: 'uptime-check' | 'error-rate-threshold';
  uptimeCheckId: string | null;
  errorRateThresholdId: string | null;
  openedAt: string;
  closedAt: string | null;
  /** Closed ones only. */
  durationSeconds: number | null;
  /** A check's: the opening Probe's error class. */
  openingError: string | null;
  /** A threshold's: the opening window's Error rate, a fraction. */
  openingErrorRate: number | null;
  /** A threshold's: the opening window's request count. */
  openingRequests: number | null;
  /** A threshold's: the worst judged window's rate while open. */
  worstErrorRate: number | null;
  closeReason: IncidentCloseReason | null;
}

/** `GET /service-health/:serviceType/:serviceId`. */
export interface ServiceHealthSummary {
  serviceType: ServiceType;
  serviceId: string;
  /** The Overview's fact line: `worstState`, the Health column's rule. */
  state: ServiceHealthState;
  uptimeChecks: UptimeCheckHealth[];
  /** The Error rate over the last 24 hours, or why there is none. */
  errorRate: ErrorRateView;
  /** The Service's one Error-rate threshold, or null. */
  errorRateThreshold: ErrorRateThresholdView | null;
  /** At most one per check and one for the threshold, newest first. */
  openIncidents: IncidentView[];
  /** Every Incident, open ones included, newest first. */
  incidents: { items: IncidentView[]; meta: PaginationMeta };
}

/** How many closed Incidents `get_service_health` answers. */
export const RECENTLY_CLOSED_INCIDENTS = 10;

/**
 * `get_service_health`'s raw read: the summary with its page of history
 * replaced by the most recently closed Incidents. The tool's projection
 * decides what of it leaves.
 */
export type ServiceHealthRead = Omit<ServiceHealthSummary, 'incidents'> & {
  recentlyClosedIncidents: IncidentView[];
};

/** The Incidents a Service's checks and threshold own; null when it has neither. */
function ownedBy(
  uptimeCheckIds: string[],
  threshold: ErrorRateThresholdView | null,
): SQL | null {
  if (uptimeCheckIds.length === 0 && !threshold) return null;
  return (
    or(
      ...(uptimeCheckIds.length > 0
        ? [inArray(incident.uptimeCheckId, uptimeCheckIds)]
        : []),
      ...(threshold
        ? [eq(incident.errorRateThresholdId, threshold.errorRateThresholdId)]
        : []),
    ) ?? null
  );
}

/**
 * A Service's health summary: its checks with their last Probe and
 * 24-hour strip, its open Incidents and a page of Incident history. Readable by
 * anyone who may read the Service — `service: ['read']` plus its entitlement —
 * and by nobody else, instance authority included: the Service is
 * looked up in the caller's Organization before any role is consulted.
 *
 * `errorRate` is the Error rate or its unavailable reason
 * (`ErrorRateService`), and `errorRateThreshold` the threshold beside it,
 * whose Incidents join the checks' in the open list and the history.
 */
@Injectable()
export class ServiceHealthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly checks: UptimeChecksService,
    private readonly errorRates: ErrorRateService,
    private readonly thresholds: ErrorRateThresholdsService,
    @Inject(SERVICE_HEALTH_CLOCK) private readonly clock: ServiceHealthClock,
  ) {}

  async summary(
    ctx: PermissionCtx,
    serviceType: string,
    serviceId: string,
    query: ServiceHealthQueryDto,
  ): Promise<ServiceHealthSummary> {
    return this.build(ctx, serviceType, serviceId, {
      page: query.page ?? 1,
      limit: query.limit ?? 20,
      closedOnly: false,
    });
  }

  /**
   * `get_service_health`'s read: the summary an Agent diagnoses from,
   * built by the same code as the Health tab's, with the history narrowed to
   * the {@link RECENTLY_CLOSED_INCIDENTS} most recently *closed* Incidents
   * (the open ones are `openIncidents`). The tool's projection drops the
   * strips, so no raw Probe leaves, and the keyword and header value never
   * do. Same gate as {@link summary}: `service: ['read']` plus the
   * entitlement.
   */
  async forAgent(
    ctx: PermissionCtx,
    serviceType: string,
    serviceId: string,
  ): Promise<ServiceHealthRead> {
    const { incidents, ...summary } = await this.build(
      ctx,
      serviceType,
      serviceId,
      { page: 1, limit: RECENTLY_CLOSED_INCIDENTS, closedOnly: true },
    );
    return { ...summary, recentlyClosedIncidents: incidents.items };
  }

  /**
   * The Service's open Incidents, its checks' and its threshold's alike —
   * `get_service`'s `openIncidents`. Same gate as {@link summary}.
   */
  async openIncidents(
    ctx: PermissionCtx,
    serviceType: string,
    serviceId: string,
  ): Promise<IncidentView[]> {
    const type = await this.authorizedType(ctx, serviceType, serviceId);
    const [views, threshold] = await Promise.all([
      this.checks.viewsOf(type, serviceId),
      this.thresholds.viewOf(type, serviceId),
    ]);
    const owned = ownedBy(
      views.map((view) => view.uptimeCheckId),
      threshold,
    );
    if (!owned) return [];
    const rows = await this.db
      .select()
      .from(incident)
      .where(and(owned, isNull(incident.closedAt)))
      .orderBy(desc(incident.openedAt));
    return rows.map(toIncidentView);
  }

  /** The kind, once the caller may read that Service; 404 for an unknown kind. */
  private async authorizedType(
    ctx: PermissionCtx,
    serviceType: string,
    serviceId: string,
  ): Promise<ServiceType> {
    if (
      !(serviceTypeEnum.enumValues as readonly string[]).includes(serviceType)
    ) {
      throw new NotFoundException('Service not found');
    }
    const type = serviceType as ServiceType;
    await this.checks.authorize(ctx, type, serviceId, 'read');
    return type;
  }

  private async build(
    ctx: PermissionCtx,
    serviceType: string,
    serviceId: string,
    history: { page: number; limit: number; closedOnly: boolean },
  ): Promise<ServiceHealthSummary> {
    const type = await this.authorizedType(ctx, serviceType, serviceId);

    const views = await this.checks.viewsOf(type, serviceId);
    const ids = views.map((view) => view.uptimeCheckId);
    const now = this.clock.now();
    const [lastProbes, strips, status, errorRate, errorRateThreshold] =
      await Promise.all([
        this.lastProbes(ids),
        this.strips(ids, now),
        ownerStatus(this.db, type, serviceId),
        this.errorRates.forService(type, serviceId, now),
        this.thresholds.viewOf(type, serviceId),
      ]);

    const uptimeChecks = views.map((view) => {
      const strip = strips.get(view.uptimeCheckId) ?? emptyStrip(now);
      const up = strip.reduce((sum, bucket) => sum + bucket.up, 0);
      const all = strip.reduce(
        (sum, bucket) => sum + bucket.up + bucket.down,
        0,
      );
      return {
        ...view,
        lastProbe: lastProbes.get(view.uptimeCheckId) ?? null,
        strip,
        upShare24h: all === 0 ? null : up / all,
      };
    });

    const stateWith = (openIncidents: number) =>
      worstState({
        status: status ?? 'idle',
        openIncidents,
        lastVerdicts: uptimeChecks
          .filter((check) => check.enabled)
          .map((check) => check.lastProbe?.verdict ?? null),
        threshold: errorRateThreshold && {
          enabled: errorRateThreshold.enabled,
          errorRateAvailable: errorRate.available,
        },
      });

    const { page, limit } = history;
    const owned = ownedBy(ids, errorRateThreshold);
    if (!owned) {
      return {
        serviceType: type,
        serviceId,
        state: stateWith(0),
        uptimeChecks,
        errorRate,
        errorRateThreshold,
        openIncidents: [],
        incidents: {
          items: [],
          meta: buildPaginationMeta({ page, limit, totalItems: 0 }),
        },
      };
    }
    const listed = history.closedOnly
      ? and(owned, isNotNull(incident.closedAt))
      : owned;
    const { offset } = toOffsetLimit({ page, limit });
    const [open, items, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(incident)
        .where(and(owned, isNull(incident.closedAt)))
        .orderBy(desc(incident.openedAt)),
      this.db
        .select()
        .from(incident)
        .where(listed)
        .orderBy(
          desc(history.closedOnly ? incident.closedAt : incident.openedAt),
          desc(incident.incidentId),
        )
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(incident).where(listed),
    ]);

    return {
      serviceType: type,
      serviceId,
      state: stateWith(open.length),
      uptimeChecks,
      errorRate,
      errorRateThreshold,
      openIncidents: open.map(toIncidentView),
      incidents: {
        items: items.map(toIncidentView),
        meta: buildPaginationMeta({ page, limit, totalItems: total }),
      },
    };
  }

  private async lastProbes(ids: string[]): Promise<Map<string, ProbeView>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .selectDistinctOn([probe.uptimeCheckId], {
        uptimeCheckId: probe.uptimeCheckId,
        probedAt: probe.probedAt,
        verdict: probe.verdict,
        latencyMs: probe.latencyMs,
        errorClass: probe.errorClass,
      })
      .from(probe)
      .where(inArray(probe.uptimeCheckId, ids))
      .orderBy(probe.uptimeCheckId, desc(probe.probedAt));
    return new Map(
      rows.map(({ uptimeCheckId, ...view }) => [uptimeCheckId, view]),
    );
  }

  /** Up and down counts per half hour over the last 24 hours, per check. */
  private async strips(
    ids: string[],
    now: number,
  ): Promise<Map<string, StripBucket[]>> {
    if (ids.length === 0) return new Map();
    const from = stripStart(now);
    const bucket = sql<number>`floor((extract(epoch from ${probe.probedAt}::timestamptz) * 1000 - ${from}) / ${STRIP_BUCKET_MS})::int`;
    const rows = await this.db
      .select({
        uptimeCheckId: probe.uptimeCheckId,
        bucket,
        verdict: probe.verdict,
        probes: count(),
      })
      .from(probe)
      .where(
        and(
          inArray(probe.uptimeCheckId, ids),
          gte(probe.probedAt, new Date(from).toISOString()),
        ),
      )
      // By position: the bucket expression carries bound parameters, and
      // Postgres will not match a GROUP BY expression to a select-list one
      // whose parameters are numbered differently.
      .groupBy(sql`1, 2, 3`);

    const strips = new Map<string, StripBucket[]>();
    for (const row of rows) {
      let strip = strips.get(row.uptimeCheckId);
      if (!strip) {
        strip = emptyStrip(now);
        strips.set(row.uptimeCheckId, strip);
      }
      const slot = strip[Number(row.bucket)];
      if (!slot) continue;
      slot[row.verdict] += Number(row.probes);
    }
    return strips;
  }
}

/** The start of the strip's oldest bucket: 48 half-hours back from the one now is in. */
function stripStart(now: number): number {
  const current = Math.floor(now / STRIP_BUCKET_MS) * STRIP_BUCKET_MS;
  return current - (STRIP_BUCKETS - 1) * STRIP_BUCKET_MS;
}

function emptyStrip(now: number): StripBucket[] {
  const from = stripStart(now);
  return Array.from({ length: STRIP_BUCKETS }, (_, index) => ({
    start: new Date(from + index * STRIP_BUCKET_MS).toISOString(),
    up: 0,
    down: 0,
  }));
}

export function toIncidentView(row: Incident): IncidentView {
  return {
    incidentId: row.incidentId,
    source: row.errorRateThresholdId ? 'error-rate-threshold' : 'uptime-check',
    uptimeCheckId: row.uptimeCheckId,
    errorRateThresholdId: row.errorRateThresholdId,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    durationSeconds: row.closedAt
      ? Math.round(
          (new Date(row.closedAt).getTime() -
            new Date(row.openedAt).getTime()) /
            1000,
        )
      : null,
    openingError: row.openingError,
    openingErrorRate: row.openingErrorRate,
    openingRequests: row.openingRequests,
    worstErrorRate: row.worstErrorRate,
    closeReason: row.closeReason,
  };
}
