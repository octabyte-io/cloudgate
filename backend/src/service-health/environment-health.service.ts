import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, inArray, isNull, min, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type {
  ApplicationStatus,
  ServiceType,
  WorkloadServiceType,
} from '../applications/application.schema';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { errorRateThreshold, incident, probe, uptimeCheck } from '../db/schema';
import { ErrorRateService } from './error-rate.service';
import type { ProbeVerdict } from './service-health.schema';
import { isStopped, UPTIME_CHECK_OWNER_FIELD } from './service-owner';
import { thresholdOwnerOf } from './threshold-owner';

/**
 * A Service's worst current health, best last. The Environment's
 * Services table, the Overview's fact line and the Health tab's summary all
 * read this one word, so it is decided here and nowhere else. (MCP's
 * `get_environment` carries each Service's open-Incident count, not this
 * word.)
 *
 * - `incident` — at least one Incident is open, whatever owns it.
 * - `down` — no Incident is open, but an enabled check's last Probe was down
 *   (fewer downs in a row than its down-after count, so far).
 * - `pending` — no down, but an enabled check has not been probed yet.
 * - `up` — something is watching and nothing is wrong: every enabled check's
 *   last Probe was up, and an enabled Error-rate threshold with an Error rate
 *   to judge counts as up too — so a Service watched only by such a threshold
 *   reads `up`.
 * - `unchecked` — nothing is watching it: no enabled check and no judged
 *   threshold, or the Service is Stopped (a Stopped Service is not probed, so
 *   a last verdict is history).
 */
export const SERVICE_HEALTH_STATES = [
  'incident',
  'down',
  'pending',
  'up',
  'unchecked',
] as const;
export type ServiceHealthState = (typeof SERVICE_HEALTH_STATES)[number];

/** What {@link worstState} decides from, per Service. */
export interface ServiceHealthFacts {
  status: ApplicationStatus;
  /** Open Incidents from every source (threshold ones included). */
  openIncidents: number;
  /** The last Probe verdict of each *enabled* check; `null` = not probed yet. */
  lastVerdicts: (ProbeVerdict | null)[];
  /** The Service's Error-rate threshold, or null when it has none. */
  threshold: { enabled: boolean; errorRateAvailable: boolean } | null;
}

/**
 * The rule, as a pure function: the Environment batch
 * ({@link EnvironmentHealthService.of}) and `ServiceHealthService`'s summary
 * both answer a Service's `state` by it, so they cannot disagree. An open
 * Incident beats a Stop: the Stop hook closes it, and until it has the
 * Incident is the truer thing to say.
 *
 * **An enabled threshold with an Error rate to judge is an `up`**: it is
 * watching, and a breach always opens an Incident, so it has no
 * `down` of its own. Off, or with no Error rate (request metrics not enabled,
 * no samples yet), it watches nothing and adds nothing.
 */
export function worstState(facts: ServiceHealthFacts): ServiceHealthState {
  if (facts.openIncidents > 0) return 'incident';
  const verdicts =
    facts.threshold?.enabled && facts.threshold.errorRateAvailable
      ? [...facts.lastVerdicts, 'up' as const]
      : facts.lastVerdicts;
  if (isStopped(facts.status) || verdicts.length === 0) return 'unchecked';
  if (verdicts.includes('down')) return 'down';
  if (verdicts.includes(null)) return 'pending';
  return 'up';
}

/** One Service's row in `GET /environments/:id/health`. */
export interface ServiceHealthRow {
  serviceType: ServiceType;
  serviceId: string;
  state: ServiceHealthState;
  /** `openIncidents > 0` — the flag the table and fact line lead with. */
  openIncident: boolean;
  openIncidents: number;
  /** The oldest open Incident's `openedAt`; null with none open. */
  openSince: string | null;
}

/** The Services {@link EnvironmentHealthService.of} is asked about. */
export interface HealthSubject {
  serviceType: ServiceType;
  serviceId: string;
  status: ApplicationStatus;
}

/**
 * The batched health read behind the Environment's Health column: the
 * worst current state and the open-Incident flag of many Services in a fixed
 * number of queries — plus, for each *enabled* Error-rate threshold, the few
 * that ask whether its Service has an Error rate to judge.
 *
 * It takes a list and authorizes nothing: the caller hands it only the
 * Services the session is entitled to (`EnvironmentsService.listHealth`,
 * through the same scope as `GET /environments/:id`'s `services`).
 *
 * **Error-rate thresholds** feed {@link worstState} as its
 * `threshold` fact, which it judges: a threshold's open Incident counts with
 * the checks' (it is reached through `error_rate_threshold_id`, not
 * `uptime_check`), and whether its Service has an Error rate is asked only
 * for an enabled one.
 */
@Injectable()
export class EnvironmentHealthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly errorRates: ErrorRateService,
  ) {}

  async of(subjects: HealthSubject[]): Promise<ServiceHealthRow[]> {
    const [checks, thresholds] = await Promise.all([
      this.checksOf(subjects),
      this.thresholdsOf(subjects),
    ]);
    const ids = checks.map((check) => check.uptimeCheckId);
    const enabledIds = checks
      .filter((check) => check.enabled)
      .map((check) => check.uptimeCheckId);
    const thresholdIds = thresholds.map((t) => t.errorRateThresholdId);
    const [verdicts, open, thresholdOpen, available] = await Promise.all([
      this.lastVerdicts(enabledIds),
      this.openIncidents(ids),
      this.openThresholdIncidents(thresholdIds),
      Promise.all(
        thresholds.map((t) =>
          t.enabled
            ? this.errorRates.isAvailable(thresholdOwnerOf(t))
            : Promise.resolve(false),
        ),
      ),
    ]);

    const byService = new Map<
      string,
      {
        verdicts: (ProbeVerdict | null)[];
        threshold: ServiceHealthFacts['threshold'];
        open: number;
        since: string | null;
      }
    >();
    const entryOf = (key: string) => {
      const entry = byService.get(key) ?? {
        verdicts: [],
        threshold: null,
        open: 0,
        since: null,
      };
      byService.set(key, entry);
      return entry;
    };
    const addOpen = (
      entry: { open: number; since: string | null },
      incidents: { count: number; since: string } | undefined,
    ) => {
      if (!incidents) return;
      entry.open += incidents.count;
      if (!entry.since || incidents.since < entry.since) {
        entry.since = incidents.since;
      }
    };
    for (const check of checks) {
      const entry = entryOf(`${check.serviceType}:${check.serviceId}`);
      if (check.enabled) {
        entry.verdicts.push(verdicts.get(check.uptimeCheckId) ?? null);
      }
      addOpen(entry, open.get(check.uptimeCheckId));
    }
    thresholds.forEach((threshold, index) => {
      const owner = thresholdOwnerOf(threshold);
      const entry = entryOf(`${owner.serviceType}:${owner.serviceId}`);
      entry.threshold = {
        enabled: threshold.enabled,
        errorRateAvailable: available[index],
      };
      addOpen(entry, thresholdOpen.get(threshold.errorRateThresholdId));
    });

    return subjects.map(({ serviceType, serviceId, status }) => {
      const entry = byService.get(`${serviceType}:${serviceId}`);
      const openIncidents = entry?.open ?? 0;
      return {
        serviceType,
        serviceId,
        state: worstState({
          status,
          openIncidents,
          lastVerdicts: entry?.verdicts ?? [],
          threshold: entry?.threshold ?? null,
        }),
        openIncident: openIncidents > 0,
        openIncidents,
        openSince: entry?.since ?? null,
      };
    });
  }

  /** Every check of the subjects, in one query across the owner columns. */
  private async checksOf(subjects: HealthSubject[]) {
    const idsByType = new Map<WorkloadServiceType, string[]>();
    for (const { serviceType, serviceId } of subjects) {
      // A Bucket has no uptime check.
      if (serviceType === 'bucket') continue;
      idsByType.set(serviceType, [
        ...(idsByType.get(serviceType) ?? []),
        serviceId,
      ]);
    }
    if (idsByType.size === 0) return [];
    const rows = await this.db
      .select()
      .from(uptimeCheck)
      .where(
        or(
          ...[...idsByType].map(([type, ids]) =>
            inArray(uptimeCheck[UPTIME_CHECK_OWNER_FIELD[type]], ids),
          ),
        ),
      );
    return rows.map((row) => ({
      uptimeCheckId: row.uptimeCheckId,
      serviceType: row.serviceType,
      serviceId: row[UPTIME_CHECK_OWNER_FIELD[row.serviceType]] as string,
      enabled: row.enabled,
    }));
  }

  /** Every Error-rate threshold of the subjects, in one query. */
  private async thresholdsOf(subjects: HealthSubject[]) {
    const arms: SQL[] = [];
    const ofType = (type: ServiceType) =>
      subjects
        .filter((subject) => subject.serviceType === type)
        .map((subject) => subject.serviceId);
    const applications = ofType('application');
    const composes = ofType('compose');
    if (applications.length > 0) {
      arms.push(inArray(errorRateThreshold.applicationId, applications));
    }
    if (composes.length > 0) {
      arms.push(inArray(errorRateThreshold.composeId, composes));
    }
    if (arms.length === 0) return [];
    return this.db
      .select()
      .from(errorRateThreshold)
      .where(or(...arms));
  }

  private async openThresholdIncidents(
    ids: string[],
  ): Promise<Map<string, { count: number; since: string }>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({
        errorRateThresholdId: incident.errorRateThresholdId,
        count: count(),
        since: min(incident.openedAt),
      })
      .from(incident)
      .where(
        and(
          inArray(incident.errorRateThresholdId, ids),
          isNull(incident.closedAt),
        ),
      )
      .groupBy(incident.errorRateThresholdId);
    const open = new Map<string, { count: number; since: string }>();
    for (const row of rows) {
      if (row.errorRateThresholdId && row.since) {
        open.set(row.errorRateThresholdId, {
          count: Number(row.count),
          since: row.since,
        });
      }
    }
    return open;
  }

  private async lastVerdicts(
    ids: string[],
  ): Promise<Map<string, ProbeVerdict>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .selectDistinctOn([probe.uptimeCheckId], {
        uptimeCheckId: probe.uptimeCheckId,
        verdict: probe.verdict,
      })
      .from(probe)
      .where(inArray(probe.uptimeCheckId, ids))
      .orderBy(probe.uptimeCheckId, desc(probe.probedAt));
    return new Map(rows.map((row) => [row.uptimeCheckId, row.verdict]));
  }

  private async openIncidents(
    ids: string[],
  ): Promise<Map<string, { count: number; since: string }>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({
        uptimeCheckId: incident.uptimeCheckId,
        count: count(),
        since: min(incident.openedAt),
      })
      .from(incident)
      .where(
        and(inArray(incident.uptimeCheckId, ids), isNull(incident.closedAt)),
      )
      .groupBy(incident.uptimeCheckId);
    const open = new Map<string, { count: number; since: string }>();
    for (const row of rows) {
      if (row.uptimeCheckId && row.since) {
        open.set(row.uptimeCheckId, {
          count: Number(row.count),
          since: row.since,
        });
      }
    }
    return open;
  }
}
