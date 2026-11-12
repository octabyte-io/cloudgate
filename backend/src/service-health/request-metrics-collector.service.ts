import { isRetiredServer } from '../bought-servers/retired-servers';
import { FrozenOrganizations } from '../cloud/billing/frozen-organizations.service';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { asc, eq, isNotNull, lt, or } from 'drizzle-orm';
import { application } from '../applications/application.schema';
import { compose } from '../compose/compose.schema';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { domain, errorRateSample, server } from '../db/schema';
import { RemoteExecService } from '../remote/remote-exec.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { webServerSettings } from '../settings/settings.schema';
import { buildErrorRateIndex } from './error-rate-index';
import { ErrorRateThresholdsService } from './error-rate-thresholds.service';
import type {
  ErrorRateDomainRow,
  ErrorRateIndexEntry,
  ErrorRateOwner,
} from './error-rate-index';
import { REQUEST_METRICS_STATE } from './request-metrics-state.port';
import type { RequestMetricsState } from './request-metrics-state.port';
import { SERVICE_HEALTH_CLOCK } from './service-health.clock';
import type { ServiceHealthClock } from './service-health.clock';
import {
  counterDeltas,
  parseCounterRead,
  REQUEST_COUNTERS_COMMAND,
} from './traefik-counters';
import type { CounterRead } from './traefik-counters';

/** How often the tick looks for due Servers; a Server's own rate is ≥ its refreshRate. */
export const COLLECTION_TICK_MS = 5_000;
export const COLLECTION_TICK_JOB = 'service-health-error-rate-tick';

/** The collection interval of a Server whose monitoring was never set up. */
export const DEFAULT_COLLECTION_SECONDS = 60;

/** How long an Error-rate sample is kept; no rollups. */
export const ERROR_RATE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const ERROR_RATE_PRUNE_JOB = 'service-health-error-rate-prune';
export const ERROR_RATE_PRUNE_CRON = '37 * * * *';

/** The platform host's key in the per-machine maps (its Server id is null). */
const PLATFORM_HOST = '(platform host)';

/** What one collection wrote, and what the thresholds are judged on. */
export interface Collection {
  serverId: string | null;
  /** The clock's now the samples were stamped with. */
  collectedAt: string;
  /** Every Service with a Domain on the machine, sample rows or not. */
  owners: ErrorRateOwner[];
}

/**
 * Reads each machine's Traefik request counters into Error-rate samples
 * (ADR-0027, spec slice 3).
 *
 * **Per machine, at its refreshRate, not gated on monitoring setup.** One
 * instance-wide tick every {@link COLLECTION_TICK_MS} finds the machines — the
 * Servers and the platform host — that have a Domain on them, and collects each
 * one whose `metricsConfig.server.refreshRate` (60 s when monitoring was never
 * set up) has passed since its last attempt on {@link SERVICE_HEALTH_CLOCK}. A
 * machine is read only when `RequestMetricsService.isEnabled` says its Traefik
 * keeps the counters.
 *
 * **The read is one shell command** ({@link REQUEST_COUNTERS_COMMAND}), over
 * `RemoteExecService` for a Server and the local shell for the platform host,
 * as the monitoring collectors run theirs. A failed read — Traefik down, still
 * restarting after Enable request metrics, the Server unreachable — writes
 * nothing and keeps the last good read, so the next good one spans the gap.
 *
 * **Deltas need a previous read of the same Traefik**, held in memory per
 * machine ({@link lastRead}). The first read after the backend starts, and the
 * first after a machine lost its Domains or its metrics, only sets that
 * baseline: its counts cover an unknown stretch, and writing them would draw a
 * spike. `counterDeltas` owns the reset rules.
 *
 * **Samples are matched on the forward index, exactly**
 * (`buildErrorRateIndex`), and every indexed Domain gets a row each collection,
 * zeros included; a series no Domain names is dropped.
 *
 * **Each collection that wrote samples is judged at once**: the
 * Error-rate thresholds of the machine's Services, over their trailing
 * windows ending at this collection (`ErrorRateThresholdsService.judge`),
 * inside the same in-flight pass. A collection that wrote nothing — the first
 * read, a failed read — judges nothing, so a gap neither opens nor closes.
 *
 * The in-flight guard is per machine, and a second tick that meets a
 * collection in flight waits for it, so a direct {@link tick} returns with
 * every due machine's samples written and judged, and every resulting
 * Notification sent — the Uptime check tick's shape.
 */
@Injectable()
export class RequestMetricsCollector implements OnApplicationBootstrap {
  private readonly logger = new Logger(RequestMetricsCollector.name);

  private readonly inFlight = new Map<string, Promise<Collection | null>>();
  /** When each machine was last attempted, on the clock. */
  private readonly lastAttempt = new Map<string, number>();
  /** Each machine's last good read: the baseline the next delta starts at. */
  private readonly lastRead = new Map<string, CounterRead>();

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly remoteExec: RemoteExecService,
    @Inject(REQUEST_METRICS_STATE)
    private readonly requestMetrics: RequestMetricsState,
    private readonly registry: SchedulerRegistry,
    private readonly scheduling: SchedulingService,
    @Inject(SERVICE_HEALTH_CLOCK) private readonly clock: ServiceHealthClock,
    private readonly thresholds: ErrorRateThresholdsService,
    private readonly frozen: FrozenOrganizations,
  ) {}

  onApplicationBootstrap(): void {
    try {
      const handle = setInterval(() => {
        this.tick().catch((error) =>
          this.logger.error('Error-rate collection tick failed', error),
        );
      }, COLLECTION_TICK_MS);
      this.registry.addInterval(COLLECTION_TICK_JOB, handle);
      this.scheduling.register(
        ERROR_RATE_PRUNE_JOB,
        ERROR_RATE_PRUNE_CRON,
        null,
        () => this.prune().then(() => undefined),
      );
    } catch (error) {
      this.logger.error('Error-rate collection could not be armed', error);
    }
  }

  /**
   * One tick at the clock's now: collect every machine with a Domain whose
   * interval has passed. Resolves with what each collection wrote.
   */
  async tick(): Promise<Collection[]> {
    const now = this.clock.now();
    const machines = await this.machines();
    for (const key of this.lastRead.keys()) {
      // A machine with no Domain left is not read; its baseline would be
      // stale by the time one is added.
      if (!machines.has(key)) this.lastRead.delete(key);
    }
    const due: Promise<Collection | null>[] = [];
    for (const [key, machine] of machines) {
      const running = this.inFlight.get(key);
      if (running) {
        due.push(running);
        continue;
      }
      // A Frozen Organization's Servers are not read (ADR-0052), nor a
      // Deleting or Deleted Bought Server (spec #1387).
      if (
        machine.serverId !== null &&
        ((await this.frozen.isFrozenAt({ serverId: machine.serverId })) ||
          (await isRetiredServer(this.db, machine.serverId)))
      ) {
        continue;
      }
      const last = this.lastAttempt.get(key);
      const intervalMs = (await this.intervalSeconds(machine.serverId)) * 1000;
      if (last !== undefined && last + intervalMs > now) continue;
      this.lastAttempt.set(key, now);
      const pass = this.collect(key, machine, now)
        .then(async (collection) => {
          if (collection) await this.thresholds.judge(collection);
          return collection;
        })
        .catch((error) => {
          this.logger.error(
            `Error-rate collection on ${describe(machine.serverId)} failed`,
            error,
          );
          return null;
        })
        .finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pass);
      due.push(pass);
    }
    const collections = await Promise.all(due);
    return collections.filter((c): c is Collection => c !== null);
  }

  /** Deletes samples older than seven days before the clock's now. */
  async prune(): Promise<number> {
    const before = new Date(this.clock.now() - ERROR_RATE_RETENTION_MS);
    const removed = await this.db
      .delete(errorRateSample)
      .where(lt(errorRateSample.collectedAt, before.toISOString()))
      .returning({ id: errorRateSample.errorRateSampleId });
    return removed.length;
  }

  private async collect(
    key: string,
    machine: Machine,
    now: number,
  ): Promise<Collection | null> {
    if (!(await this.requestMetrics.isEnabled(machine.serverId))) {
      this.lastRead.delete(key);
      return null;
    }
    const current = await this.read(machine.serverId);
    if (!current) return null;
    const previous = this.lastRead.get(key);
    this.lastRead.set(key, current);
    if (!previous) return null;

    const perDomain = new Map<
      string,
      { requests: number; errors: number; slow: number }
    >();
    for (const entry of machine.index.values()) {
      perDomain.set(entry.domainId, { requests: 0, errors: 0, slow: 0 });
    }
    for (const [service, delta] of counterDeltas(previous, current)) {
      const entry = machine.index.get(service);
      if (!entry) continue;
      const total = perDomain.get(entry.domainId);
      if (!total) continue;
      total.requests += delta.requests;
      total.errors += delta.errors;
      total.slow += delta.slow;
    }

    const collectedAt = new Date(now).toISOString();
    if (perDomain.size > 0) {
      await this.db.insert(errorRateSample).values(
        [...perDomain].map(([domainId, total]) => ({
          domainId,
          collectedAt,
          ...total,
        })),
      );
    }
    return {
      serverId: machine.serverId,
      collectedAt,
      owners: owners(machine.index.values()),
    };
  }

  /** One read of the counters, or null when the endpoint did not answer. */
  private async read(serverId: string | null): Promise<CounterRead | null> {
    try {
      const { stdout } =
        serverId === null
          ? await this.remoteExec.execAsync(REQUEST_COUNTERS_COMMAND)
          : await this.remoteExec.execAsyncRemote(
              serverId,
              REQUEST_COUNTERS_COMMAND,
            );
      const read = parseCounterRead(stdout);
      return read.startTime === null ? null : read;
    } catch (error) {
      this.logger.warn(
        `Could not read the request counters on ${describe(serverId)}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /** Every machine with a Domain on it, keyed, with its forward index. */
  private async machines(): Promise<Map<string, Machine>> {
    const rows = await this.db
      .select({
        domainId: domain.domainId,
        uniqueConfigKey: domain.uniqueConfigKey,
        https: domain.https,
        customEntrypoint: domain.customEntrypoint,
        applicationId: application.applicationId,
        applicationAppName: application.appName,
        applicationServerId: application.serverId,
        composeId: compose.composeId,
        composeAppName: compose.appName,
        composeType: compose.composeType,
        composeServerId: compose.serverId,
      })
      .from(domain)
      .leftJoin(
        application,
        eq(application.applicationId, domain.applicationId),
      )
      .leftJoin(compose, eq(compose.composeId, domain.composeId))
      .where(or(isNotNull(domain.applicationId), isNotNull(domain.composeId)));

    const byMachine = new Map<
      string,
      { serverId: string | null; rows: ErrorRateDomainRow[] }
    >();
    for (const row of rows) {
      const serverId = row.applicationId
        ? row.applicationServerId
        : row.composeServerId;
      const key = serverId ?? PLATFORM_HOST;
      const group = byMachine.get(key) ?? {
        serverId: serverId ?? null,
        rows: [],
      };
      group.rows.push({
        domainId: row.domainId,
        uniqueConfigKey: row.uniqueConfigKey,
        https: row.https,
        customEntrypoint: row.customEntrypoint,
        application:
          row.applicationId && row.applicationAppName
            ? {
                applicationId: row.applicationId,
                appName: row.applicationAppName,
              }
            : null,
        compose:
          row.composeId && row.composeAppName && row.composeType
            ? {
                composeId: row.composeId,
                appName: row.composeAppName,
                composeType: row.composeType,
              }
            : null,
      });
      byMachine.set(key, group);
    }

    const machines = new Map<string, Machine>();
    for (const [key, group] of byMachine) {
      const index = buildErrorRateIndex(group.rows);
      if (index.size > 0)
        machines.set(key, { serverId: group.serverId, index });
    }
    return machines;
  }

  /** The machine's `metricsConfig.server.refreshRate`, or 60 s. */
  private async intervalSeconds(serverId: string | null): Promise<number> {
    if (serverId === null) {
      const [row] = await this.db
        .select({ metricsConfig: webServerSettings.metricsConfig })
        .from(webServerSettings)
        .orderBy(asc(webServerSettings.createdAt))
        .limit(1);
      return (
        row?.metricsConfig?.server?.refreshRate || DEFAULT_COLLECTION_SECONDS
      );
    }
    const [row] = await this.db
      .select({ metricsConfig: server.metricsConfig })
      .from(server)
      .where(eq(server.serverId, serverId))
      .limit(1);
    return (
      row?.metricsConfig?.server?.refreshRate || DEFAULT_COLLECTION_SECONDS
    );
  }
}

interface Machine {
  serverId: string | null;
  index: Map<string, ErrorRateIndexEntry>;
}

function owners(entries: Iterable<ErrorRateIndexEntry>): ErrorRateOwner[] {
  const seen = new Map<string, ErrorRateOwner>();
  for (const { serviceType, serviceId } of entries) {
    seen.set(`${serviceType}:${serviceId}`, { serviceType, serviceId });
  }
  return [...seen.values()];
}

function describe(serverId: string | null): string {
  return serverId === null ? 'the platform host' : `Server ${serverId}`;
}
