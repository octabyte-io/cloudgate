import { isRetiredServer, notRetired } from '../bought-servers/retired-servers';
import { FrozenOrganizations } from '../cloud/billing/frozen-organizations.service';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  isNull,
  like,
  lt,
  lte,
  or,
} from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { checkServerAccess } from '../common/owned-server';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { PermissionService } from '../rbac/permission.service';
import type { PermissionCtx } from '../rbac/permission.service';
import { ContainerAccessService } from '../realtime/container-access.service';
import { RemoteExecService } from '../remote/remote-exec.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { nestedServer } from '../servers/nested-server';
import type { NestedServer } from '../servers/nested-server';
import { server } from '../servers/server.schema';
import type { MetricsConfig, Server } from '../servers/server.schema';
import { webServerSettings } from '../settings/settings.schema';
import {
  DOCKER_STATS_COMMAND,
  exclusionsForAppName,
  parseContainerStatsOutput,
  partialExclusionsForAppName,
} from './collectors/container-stats.collector';
import {
  isUnmeasuredSample,
  parseServerStats,
  SERVER_STATS_COMMAND,
} from './collectors/server-stats.collector';
import { parseMetricsRange } from './metrics-window';
import { containerMetric, serverMetric } from './monitoring.schema';
import type { ServerMetric } from './monitoring.schema';
import { ThresholdService } from './threshold.service';
import type { ThresholdMetric, ThresholdTarget } from './threshold.service';

/**
 * What a collection job runs against: a Server's id, or `null` for the web
 * server — the instance's own machine, which has no `server` row. Same
 * `serverId: null` convention the docker, traefik and forward-auth code
 * already reads as "this machine".
 */
export type MonitoringTargetId = string | null;

/** The web server's name in a threshold notification (docker-cleanup's wording). */
export const WEB_SERVER_NAME = 'Cloudgate';

/** The one breach column a Server threshold transition writes. */
const breachPatch = (
  metric: ThresholdMetric,
  since: string | null,
):
  | { cpuBreachedSince: string | null }
  | { memoryBreachedSince: string | null } =>
  metric === 'CPU'
    ? { cpuBreachedSince: since }
    : { memoryBreachedSince: since };

/** Job-name segment for a target: its serverId, or `local` for the web server. */
const targetKey = (serverId: MonitoringTargetId): string => serverId ?? 'local';

/**
 * How long one target waits before it says again that it is not measurable.
 *
 * A collection interval can be as short as 2 seconds, so a line per suppressed
 * sample is 30 lines a minute for as long as the instance runs — and on a
 * platform host with no `/proc` *every* sample is suppressed, for ever. The log
 * on such a host already carries a `Monitoring job … failed` line per container
 * tick; a second per-tick line would bury everything else in it. Five minutes
 * is often enough that a misconfiguration is discoverable and rare enough that
 * the log stays readable, and the repeat counts what it skipped in between so
 * nothing is silently dropped.
 */
const UNMEASURED_LOG_INTERVAL_MS = 5 * 60 * 1000;

/** `server_id = $1`, or `server_id IS NULL` for the web server. */
const scopedTo = (column: PgColumn, serverId: MonitoringTargetId): SQL =>
  serverId === null ? isNull(column) : eq(column, serverId);

/**
 * apiUpdateServerMonitoring's metricsConfig input (type is always forced to
 * Remote), with `token` optional for the three cases `dto/monitoring.dto.ts`
 * argues — the same shape `WebServerMetricsConfigInput` carries one host over.
 */
export interface SetupMetricsConfigInput {
  server: {
    refreshRate: number;
    port: number;
    token?: string;
    urlCallback: string;
    retentionDays: number;
    cronJob: string;
    thresholds: { cpu: number; memory: number };
  };
  containers: {
    refreshRate: number;
    services: { include?: string[]; exclude?: string[] };
  };
}

/** A server sample as the API answers it — "%.2f" strings over the floats. */
export interface SystemMetrics {
  cpu: string;
  cpuModel: string;
  cpuCores: number;
  cpuPhysicalCores: number;
  cpuSpeed: number;
  os: string;
  distro: string;
  kernel: string;
  arch: string;
  memUsed: string;
  memUsedGB: string;
  memTotal: string;
  uptime: number;
  diskUsed: string;
  totalDisk: string;
  networkIn: string;
  networkOut: string;
  timestamp: string;
}

/**
 * The service a stored container name belongs to: a swarm replica is named
 * "<service>.<slot>.<task-id>", so everything before the first dot is the
 * service and every replica/restart of it collapses onto one series.
 *
 * **Still not the collector's `getServiceName`, and a later fix changed the
 * reason rather than removing it.** That function now agrees with this one on
 * every dotted name — it used to drop the last dash segment and fold every
 * `app-xxxxxx` onto `app` — but the two dotless branches must stay different:
 * this is a *queryable* name, and `resolveServiceName` matches stored rows on `=
 * name OR LIKE 'name.%'`, so trimming a compose replica index off a stored
 * `cloudgate-traefik` here would match nothing. A dedup key and a series name
 * are two jobs.
 */
function serviceNameOf(containerName: string): string {
  const dot = containerName.indexOf('.');
  return dot === -1 ? containerName : containerName.slice(0, dot);
}

/**
 * How well a stored service name answers to the requested appName. Lower is
 * better: its own name, then the "<name>-<6 random chars>" a Cloudgate
 * service is deployed under, then any other prefix, then a substring
 * somewhere inside the name.
 */
function matchRank(serviceName: string, appName: string): number {
  if (serviceName === appName) return 0;
  if (serviceName.startsWith(`${appName}-`)) return 1;
  if (serviceName.startsWith(appName)) return 2;
  return 3;
}

/**
 * Every distinct service, best-ranked first, then the shortest, then
 * alphabetical — a total order. The whole order rather than its head:
 * the read answers from the first one the caller may read, so a better
 * match belonging to somebody else is skipped rather than chosen.
 */
function rankedMatches(serviceNames: string[], appName: string): string[] {
  return [...new Set(serviceNames)].sort((a, b) => {
    const rank = matchRank(a, appName) - matchRank(b, appName);
    if (rank !== 0) return rank;
    if (a.length !== b.length) return a.length - b.length;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * The names a stored series could have been deployed under: the series name
 * itself plus every prefix of it that ends right before a `-` or `_`.
 *
 * A series name is a container's name less its task suffix, and a container
 * is named *after* its Service rather than *as* it: `app-x1y2z3` is the
 * Service itself, a compose replica `proj-x1y2z3-web-1` and a stack's
 * `proj-x1y2z3_web` both belong to `proj-x1y2z3`. So the candidates go to
 * `ContainerAccessService.firstReadable`, which resolves them against the Service
 * relation exactly, dedupes by Service and fails closed when two answer.
 */
export function ownerCandidates(series: string): string[] {
  const candidates = [series];
  for (let i = 1; i < series.length; i += 1) {
    if (series[i] === '-' || series[i] === '_') {
      candidates.push(series.slice(0, i));
    }
  }
  return candidates;
}

/**
 * Server metrics, collected in-process: periodic server/container sample
 * collection over the remote-execution layer, threshold evaluation against the
 * server row's metricsConfig, the GET /metrics query, and retention cleanup. No
 * agent binary is deployed onto a server: setup stores the config and registers
 * the collection jobs here. A config whose token is empty collects nothing —
 * either it was never set up (`cronJob` is empty too, and it gets no jobs) or
 * collection was stopped, and then only its retention cleanup stays registered.
 * The stored urlCallback/port only matter to external agents
 * posting through the token-authenticated receive endpoint (phase 39).
 *
 * A target is a Server, or the web server — the instance's own machine, whose
 * config lives on the `webServerSettings` singleton that
 * `POST /admin/setup-monitoring` writes and whose id is `null`.
 * The web server's samples are collected through the local shell rather than
 * SSH, and its threshold breaches notify instance-wide, the way the local
 * docker-cleanup run does: it belongs to the instance, not to one
 * organization.
 */
@Injectable()
export class MonitoringService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MonitoringService.name);
  /** Collections in flight — an overlapping collection is skipped. */
  private readonly inFlight = new Set<string>();
  /** Per target: when its unmeasurability was last logged, and how many
   * samples have been suppressed since. See UNMEASURED_LOG_INTERVAL_MS. */
  private readonly unmeasured = new Map<
    string,
    { at: number; since: number }
  >();

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly remoteExec: RemoteExecService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly scheduling: SchedulingService,
    private readonly thresholds: ThresholdService,
    private readonly permissions: PermissionService,
    private readonly containerAccess: ContainerAccessService,
    private readonly frozen: FrozenOrganizations,
  ) {}

  /** Register jobs for every set-up target — the Servers and the web server.
   * Failure-tolerant: boot must survive an un-migrated database
   * (backups/schedules precedent). */
  async onApplicationBootstrap(): Promise<void> {
    try {
      // A Deleting or Deleted Bought Server is never sampled again.
      const rows = await this.db
        .select()
        .from(server)
        .where(notRetired(this.db, server.serverId));
      for (const row of rows) this.registerServer(row);
      await this.registerWebServer();
    } catch (error) {
      this.logger.warn(
        `Skipping monitoring job initialization: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Sync the web server's jobs with the metricsConfig
   * `POST /admin/setup-monitoring` stored on the settings singleton — the call
   * that makes that write mean something.
   *
   * Reads the column rather than going through SettingsService: this runs at
   * boot, and `getWebServerSettings` *creates* the singleton on a miss. An
   * instance that has never been set up should be read, not written.
   */
  async registerWebServer(): Promise<void> {
    this.registerTarget(null, await this.findWebServerMetricsConfig());
  }

  /**
   * Set up a Server's monitoring: persist the config, refresh the jobs.
   *
   * **Answers the sanitized row, like its twin**.
   * `AdminService.setupMonitoring` is this method one host over and has
   * withheld the token it just wrote for a while — *"there is no caller it is
   * safe to echo it to"* — and this one echoed `metricsConfig.server.token`
   * back raw, which made {@link nestedServer}'s *"`GET /servers` is the one
   * asymmetry left"* false. Two things decided it rather than symmetry alone.
   *
   * First, **the echo stopped being a mirror the moment `token` became
   * optional** (below). While the field was required the response only ever
   * repeated a value the caller had put in the request body a line earlier, so
   * the disclosure was nil whatever the gate. An omitted token now means *keep
   * the stored one*, so an unsanitized row would hand back a credential the
   * caller never supplied — and `CustomRolesService.validatePermissions`
   * accepts `server: ['create']` with no `read`, so that caller can be one who
   * is refused `GET /servers/:id`, the only route entitled to answer with the
   * value. A same-role echo and a disclosure across the gate next door are not
   * the same thing, and this route was one optional field away from the second.
   *
   * Second, **nothing reads it.** `useSetupMonitoring` re-reads the row on
   * `onSettled` and believes that rather than the response, and `isCollecting`
   * has been flag-first for a while — so `hasToken` is every fact the console
   * ever took off this body. `registerServer` is handed the **raw** row above
   * the projection, because the collection switch is the value and not the
   * flag.
   *
   * The alternative — recording this as a second argued exception in
   * `nested-server.ts` — was rejected on the cost of the argument rather than
   * on the size of the leak: an exception has to be re-argued at every future
   * reading of that file, and pinned, to buy an echo no screen wanted.
   */
  async setupMonitoring(
    ctx: PermissionCtx,
    serverId: string,
    input: SetupMetricsConfigInput,
  ): Promise<NestedServer> {
    const current = await checkServerAccess(this.db, ctx, serverId);
    // `checkServerAccess` answers `undefined` only for an absent id — its
    // "this machine" arm — and throws for a row that is not the caller's.
    // `serverId` is required here and `.min(1)` on the route, so this is
    // unreachable; narrowed rather than asserted because the token now falls
    // back to the stored value, and a future optional `serverId` would have to
    // decide what "keep what is stored" means with no row to keep it from.
    if (!current) throw new NotFoundException('Server not found');

    const metricsConfig: MetricsConfig = {
      server: {
        type: 'Remote',
        refreshRate: input.server.refreshRate,
        port: input.server.port,
        // `??`, not `||`: an explicit `''` is "stop collecting" and must not
        // fall through to the stored value. The same three cases
        // `AdminService.setupMonitoring` carries, and the reason they are
        // needed here too is that a *read* of this row that projects the
        // token out now exists, so the console can hold a config it cannot
        // resubmit the credential from, and `toMetricsConfig` already omits
        // the field for exactly that shape.
        token: input.server.token ?? current.metricsConfig.server.token,
        urlCallback: input.server.urlCallback,
        cronJob: input.server.cronJob,
        retentionDays: input.server.retentionDays,
        thresholds: {
          cpu: input.server.thresholds.cpu,
          memory: input.server.thresholds.memory,
        },
      },
      containers: {
        refreshRate: input.containers.refreshRate,
        services: {
          include: input.containers.services.include || [],
          exclude: input.containers.services.exclude || [],
        },
      },
    };

    const [updated] = await this.db
      .update(server)
      .set({ metricsConfig })
      .where(eq(server.serverId, serverId))
      .returning();
    // The raw row, deliberately: the switch `registerTarget` reads is the
    // token's *value*, and `hasToken` would register every host that ever had
    // one.
    this.registerServer(updated);
    await this.closeTurnedOffBreaches(serverId);
    return nestedServer(updated);
  }

  /**
   * The save hook for a target's thresholds: a metric breached when
   * its threshold was saved as 0 closes now, as turned off, with the latest
   * stored sample as its value — see `ThresholdService.thresholdsSaved`.
   * Both save paths call it, this class's `setupMonitoring` and
   * `AdminService.setupMonitoring` for the platform host.
   */
  async closeTurnedOffBreaches(serverId: MonitoringTargetId): Promise<void> {
    const target = await this.findTarget(serverId);
    if (!target) return;
    if (target.cpuBreachedSince === null && target.memoryBreachedSince === null)
      return;
    const [lastSample] = await this.db
      .select({ cpu: serverMetric.cpu, memUsed: serverMetric.memUsed })
      .from(serverMetric)
      .where(scopedTo(serverMetric.serverId, serverId))
      .orderBy(desc(serverMetric.timestamp))
      .limit(1);
    await this.thresholds.thresholdsSaved(
      target,
      lastSample ?? null,
      new Date().toISOString(),
    );
  }

  /** {@link registerTarget} for a Server row. */
  registerServer(row: Server): void {
    this.registerTarget(row.serverId, row.metricsConfig);
  }

  /**
   * Keeps a target's collection jobs in sync with its metricsConfig: a
   * stats interval, a container-stats interval only when the include list
   * is non-empty, and the retention-cleanup cron.
   *
   * Unregisters first, so re-posting a config replaces the jobs rather than
   * duplicating them (`addInterval` throws on a name it already holds).
   *
   * **The cleanup is keyed on `cronJob`, not on the token**. The token
   * is the collection switch, and "Stop collecting" is a re-post with it
   * emptied — which used to return before this cron was registered, so the
   * samples a stopped target had stored were never pruned again and outlived
   * their retention with nothing left to delete them. Stopping ends the
   * collecting, not the keeping: what was stored still expires on the
   * schedule the operator chose. `cronJob` is `''` in both declared defaults
   * and `min(1)` on both setup routes, so it is non-empty exactly when a setup
   * has been saved — a target that was never set up still gets no job at all.
   */
  registerTarget(
    serverId: MonitoringTargetId,
    config: MetricsConfig | null | undefined,
  ): void {
    this.unregisterServer(serverId);
    if (!config?.server) return;

    const key = targetKey(serverId);
    if (config.server.cronJob) {
      this.scheduling.register(
        `monitoring:cleanup:${key}`,
        config.server.cronJob,
        null,
        () => this.cleanupMetrics(serverId, config.server.retentionDays),
      );
    }

    if (!config.server.token) return;
    this.addInterval(
      `monitoring:server:${key}`,
      (config.server.refreshRate || 60) * 1000,
      () => this.collectServerMetrics(serverId),
    );

    if ((config.containers.services.include ?? []).length > 0) {
      this.addInterval(
        `monitoring:containers:${key}`,
        (config.containers.refreshRate || 60) * 1000,
        () => this.collectContainerMetrics(serverId),
      );
    }
  }

  unregisterServer(serverId: MonitoringTargetId): void {
    const key = targetKey(serverId);
    // A target's suppressed-sample counter belongs to the episode of collection
    // that is ending here, so it goes with the jobs. Re-posting a config
    // unregisters first, which means an operator who has just changed the setup
    // gets told again straight away that the host cannot be measured rather
    // than waiting out a window they know nothing about.
    this.unmeasured.delete(key);
    for (const name of [
      `monitoring:server:${key}`,
      `monitoring:containers:${key}`,
    ]) {
      if (this.schedulerRegistry.doesExist('interval', name)) {
        this.schedulerRegistry.deleteInterval(name);
      }
    }
    this.scheduling.unregister(`monitoring:cleanup:${key}`);
  }

  /**
   * The server-metrics tick: sample, store, evaluate thresholds.
   *
   * **A sample with nothing measured in it is not stored**.
   * `SERVER_STATS_COMMAND` is a `;`-joined list whose last member ends in
   * `|| true`, so a host with no `/proc` answers empty sections with exit 0 and
   * `parseServerStats` returns zeros rather than failing. Storing that writes a
   * row saying the machine has 0% CPU, no memory fitted and no disk — which
   * reads back as a perfectly idle host and is the one thing the console refuses
   * to draw (`isUnmeasured`, in `live-card.tsx`, over the same parser on the
   * socket side). The tick returns before the insert *and* before the threshold
   * check: a sample that is not a reading is not a reading for the alerting
   * either.
   */
  async collectServerMetrics(serverId: MonitoringTargetId): Promise<void> {
    const key = `server:${targetKey(serverId)}`;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    try {
      const row = await this.findTarget(serverId);
      if (!row || (await this.isRetiredTarget(serverId))) {
        this.unregisterServer(serverId);
        return;
      }
      if (await this.isFrozenTarget(serverId)) return;
      const { stdout } = await this.exec(serverId, SERVER_STATS_COMMAND);
      const sample = parseServerStats(stdout);
      if (isUnmeasuredSample(sample)) {
        this.noteUnmeasured(serverId, row.name);
        return;
      }
      const timestamp = new Date().toISOString();
      await this.db
        .insert(serverMetric)
        .values({ ...sample, timestamp, serverId });
      await this.thresholds.check(row, sample, timestamp);
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * Say that a target answered a sample with nothing in it — at most once per
   * UNMEASURED_LOG_INTERVAL_MS per target, carrying the count of the ones that
   * went by in between. Suppressing a sample silently would leave an operator
   * with an empty chart, no error and nothing to search the log for; saying it
   * every tick would flood the log of the very host that cannot be measured.
   */
  private noteUnmeasured(serverId: MonitoringTargetId, name: string): void {
    const key = targetKey(serverId);
    const now = Date.now();
    const seen = this.unmeasured.get(key);
    if (seen && now - seen.at < UNMEASURED_LOG_INTERVAL_MS) {
      seen.since += 1;
      return;
    }
    const also =
      seen && seen.since > 0
        ? ` ${seen.since} more went the same way since the last of these lines.`
        : '';
    this.unmeasured.set(key, { at: now, since: 0 });
    const target =
      serverId === null ? `the web server (${name})` : `server "${name}"`;
    this.logger.warn(
      `Stored no sample for ${target}: every total came back zero — no memory ` +
        `fitted and no disk — so this is an unmeasured host rather than an idle ` +
        `one. The stats command reads /proc, which a host that is not Linux does ` +
        `not have.${also}`,
    );
  }

  /** The container-metrics tick over docker stats. */
  async collectContainerMetrics(serverId: MonitoringTargetId): Promise<void> {
    const key = `containers:${targetKey(serverId)}`;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    try {
      const row = await this.findTarget(serverId);
      if (!row || (await this.isRetiredTarget(serverId))) {
        this.unregisterServer(serverId);
        return;
      }
      if (await this.isFrozenTarget(serverId)) return;
      const services = {
        include: row.metricsConfig.containers.services.include ?? [],
        exclude: row.metricsConfig.containers.services.exclude ?? [],
      };
      // Collection stops when nothing is included any more.
      if (services.include.length === 0) return;

      const { stdout } = await this.exec(serverId, DOCKER_STATS_COMMAND);
      const records = parseContainerStatsOutput(stdout, services);
      if (records.length === 0) return;

      const timestamp = new Date().toISOString();
      await this.db.insert(containerMetric).values(
        records.map((record) => ({
          timestamp,
          containerId: record.ID,
          containerName: record.Name,
          metrics: { ...record, timestamp },
          serverId,
        })),
      );
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Drop this target's samples past retention. */
  async cleanupMetrics(
    serverId: MonitoringTargetId,
    retentionDays: number,
  ): Promise<void> {
    const cutoff = new Date(
      Date.now() - retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    await this.db
      .delete(containerMetric)
      .where(
        and(
          scopedTo(containerMetric.serverId, serverId),
          lt(containerMetric.timestamp, cutoff),
        ),
      );
    await this.db
      .delete(serverMetric)
      .where(
        and(
          scopedTo(serverMetric.serverId, serverId),
          lt(serverMetric.timestamp, cutoff),
        ),
      );
  }

  /**
   * `GET /monitoring/metrics`: last N (or all) samples, oldest first —
   * optionally narrowed to a `start`/`end` time window.
   *
   * The window is an inclusive comparison against the RFC3339 text column,
   * which is the same string comparison `cleanupMetrics` prunes with and is
   * served by the `(serverId, timestamp)` index; `parseMetricsRange` owns how
   * the bounds and `limit` compose and refuses a window it cannot answer.
   *
   * An absent `serverId` asks for the web server — there is no id
   * to invent for the instance's own machine, and demanding one is what made
   * its samples unreadable.
   */
  async getServerMetrics(
    ctx: PermissionCtx,
    query: { serverId?: string; limit?: string; start?: string; end?: string },
  ): Promise<SystemMetrics[]> {
    const serverId = await this.findReadableTarget(ctx, query.serverId, 'host');
    const { window, limit } = parseMetricsRange(query);
    const scoped = and(
      scopedTo(serverMetric.serverId, serverId),
      window.start === undefined
        ? undefined
        : gte(serverMetric.timestamp, window.start),
      window.end === undefined
        ? undefined
        : lte(serverMetric.timestamp, window.end),
    );

    const rows =
      limit === 'all'
        ? await this.db
            .select()
            .from(serverMetric)
            .where(scoped)
            .orderBy(asc(serverMetric.timestamp))
        : (
            await this.db
              .select()
              .from(serverMetric)
              .where(scoped)
              .orderBy(desc(serverMetric.timestamp))
              .limit(limit)
          ).reverse();

    return rows.map(convertToSystemMetrics);
  }

  /**
   * `GET /monitoring/metrics/containers`: samples for one service, oldest
   * first.
   *
   * **Two things this route used to say with the same answer, and now does
   * not**. It began `if (!query.appName) return [];`, so a caller who
   * had not said *which* service got `[]` and a 200 — the same reply as a
   * service with nothing stored — and `resolveServiceName` returned `[]` the
   * same silent way for a name this host has never collected anything under,
   * so a typo read as an empty store too. Both are now refusals that name what
   * is wrong: the missing parameter from the DTO's own validation, the
   * unresolvable name from here.
   *
   * **And "unresolvable" was two cases, one of which the refusal was wrong
   * about**. A name the operator put in *both* boxes is never collected — the
   * exclusion is checked first and beats the inclusion — and
   * `resolveServiceName` cannot see that, because it resolves against stored
   * rows and an excluded name has none of those either. So the refusal told an
   * operator whose container was `Up 3 days`, and offered in the console's own
   * picker, that nothing running matched the name or that the first sample had
   * not landed yet. `unresolvedAppNameRefusal` is the sentence split in two; the
   * config it reads comes from `findTarget`, which is where collection reads it
   * too.
   *
   * What is left answering `[]` is the one thing `[]` honestly means: this
   * service's samples, none of which fall in the window asked for.
   *
   * Collection includes a container when an include entry is a *substring*
   * of its name (shouldMonitorContainer), so the entry people actually write
   * is the service's human name — "redis" — while the stored container_name
   * is the swarm task "redis-12sp3x.1.<task-id>". Matching only the exact
   * name or its "name.%" task suffix here made those samples unreadable.
   * The read now matches the write: resolve appName through the same
   * substring rule to the one service it names, then return that service's
   * samples — never a merge of every container the substring happens to
   * touch, which would draw an unrelated container onto the chart.
   *
   * **The service is the best match the caller may read**. The
   * substring lookup ranges over every series sampled on the host, so the best
   * match could belong to a Service the caller is not entitled to, or to
   * another organization's on the platform host. A series the caller may not
   * read is treated as absent — the same 400 as a name nothing matched — so
   * the refusal cannot be used to probe names one substring at a time.
   *
   * **On the platform host that is the whole gate (ADR-0067)**. The host's
   * branch used to take instance authority before any series was resolved,
   * which refused a non-instance Organization's owner its own Service's
   * samples, and then refused the instance owner the same Service by
   * entitlement while the sentence said it had "never been sampled" (#1336).
   * Now a managed series is read by entitlement to its Service, an unmanaged or
   * `cloudgate-*` one by machine access plus instance authority, and a caller
   * who can read none of the matches gets the one neutral 400, never a 403 —
   * a 403 for some names and a 400 for others would be the oracle.
   *
   * A `start`/`end` window narrows the samples returned but never the
   * name resolution above: which service an appName means is a property of the
   * host, not of the range being plotted, so a window with no samples in it
   * answers empty rather than sliding the chart onto a different container.
   */
  async getContainerMetrics(
    ctx: PermissionCtx,
    query: {
      serverId?: string;
      appName?: string;
      limit?: string;
      start?: string;
      end?: string;
    },
  ): Promise<Record<string, unknown>[]> {
    const serverId = await this.findReadableTarget(
      ctx,
      query.serverId,
      'series',
    );
    const { window, limit } = parseMetricsRange(query);

    // The DTO already refuses a missing appName over HTTP; this is the same
    // refusal for a caller reaching the service directly, and it is also what
    // catches the one value the DTO's `.min(1)` cannot — "/", which the strip
    // below turns back into an empty name.
    const appName = (query.appName ?? '').replace(/^\//, '');
    if (!appName) {
      throw new BadRequestException(
        'appName is required: container samples are read one service at a time',
      );
    }

    const serviceName = await this.resolveServiceName(ctx, serverId, appName);
    if (!serviceName) {
      // The config is read on the refusal path only, so the answer costs a
      // second query exactly when there is no answer to give. The platform
      // host's is the operator's (ADR-0013, ADR-0067): a caller without
      // instance authority is answered without it, so the sentence names no
      // exclude list of a machine they do not administer. A named Server's is
      // its own Organization's, which `findReadableTarget` already checked.
      const readsConfig = await this.containerAccess.hasMachineAuthority(
        ctx,
        serverId,
      );
      const target = readsConfig ? await this.findTarget(serverId) : undefined;
      throw new BadRequestException(
        unresolvedAppNameRefusal(appName, target?.metricsConfig),
      );
    }

    const scoped = and(
      scopedTo(containerMetric.serverId, serverId),
      or(
        eq(containerMetric.containerName, serviceName),
        like(containerMetric.containerName, `${serviceName}.%`),
      ),
      window.start === undefined
        ? undefined
        : gte(containerMetric.timestamp, window.start),
      window.end === undefined
        ? undefined
        : lte(containerMetric.timestamp, window.end),
    );

    const rows =
      limit === 'all'
        ? await this.db
            .select()
            .from(containerMetric)
            .where(scoped)
            .orderBy(asc(containerMetric.timestamp))
        : (
            await this.db
              .select()
              .from(containerMetric)
              .where(scoped)
              .orderBy(desc(containerMetric.timestamp))
              .limit(limit)
          ).reverse();

    return rows.map((row) => row.metrics);
  }

  /**
   * appName → the service it names, over the names this server has actually
   * stored, using collection's substring rule. Undefined when nothing was
   * ever collected under that name **that this caller may read**.
   *
   * Readability is the container gate's: a series whose name resolves to a
   * Service takes entitlement to it (and a foreign one is refused), one that
   * resolves to none is unmanaged and takes machine-level Docker access
   * (ADR-0008). Asked of every ranked series in one batched
   * `ContainerAccessService.firstReadable`, which resolves all their candidate
   * names in one read and answers the best one the caller may read — so a
   * short substring matching every series on the host no longer costs one
   * resolution per series. The platform's own series are not refused here:
   * instance authority governs them.
   */
  private async resolveServiceName(
    ctx: PermissionCtx,
    serverId: MonitoringTargetId,
    appName: string,
  ): Promise<string | undefined> {
    const rows = await this.db
      .selectDistinct({ containerName: containerMetric.containerName })
      .from(containerMetric)
      .where(
        and(
          scopedTo(containerMetric.serverId, serverId),
          like(containerMetric.containerName, `%${appName}%`),
        ),
      );
    const ranked = rankedMatches(
      rows.map((row) => serviceNameOf(row.containerName)),
      appName,
    );
    const readable = await this.containerAccess.firstReadable(
      ctx,
      ranked.map(ownerCandidates),
      serverId,
    );
    return readable === -1 ? undefined : ranked[readable];
  }

  /**
   * The collection target a tick runs against: the Server row, or the web
   * server's slice of the settings singleton. Undefined means the target is
   * gone and its jobs should stop — which the web server never is, though its
   * config can lose its token.
   *
   * Each carries its stored Server threshold breaches and writes them back to
   * its own row: a Server's by id, the platform host's by the
   * singleton's id. A Server deleted meanwhile takes the write with it.
   */
  private async findTarget(
    serverId: MonitoringTargetId,
  ): Promise<ThresholdTarget | undefined> {
    if (serverId !== null) {
      const row = await this.findServer(serverId);
      if (!row) return undefined;
      return {
        ...row,
        saveBreach: (metric, since) =>
          this.db
            .update(server)
            .set(breachPatch(metric, since))
            .where(eq(server.serverId, serverId))
            .then(() => undefined),
      };
    }
    const [row] = await this.db
      .select({
        id: webServerSettings.id,
        metricsConfig: webServerSettings.metricsConfig,
        cpuBreachedSince: webServerSettings.cpuBreachedSince,
        memoryBreachedSince: webServerSettings.memoryBreachedSince,
      })
      .from(webServerSettings)
      .orderBy(asc(webServerSettings.createdAt))
      .limit(1);
    if (!row) return undefined;
    // organizationId null: instance-wide dispatch, the way the local
    // docker-cleanup run notifies. The web server is the instance's machine,
    // not any one organization's.
    return {
      name: WEB_SERVER_NAME,
      organizationId: null,
      metricsConfig: row.metricsConfig,
      cpuBreachedSince: row.cpuBreachedSince,
      memoryBreachedSince: row.memoryBreachedSince,
      saveBreach: (metric, since) =>
        this.db
          .update(webServerSettings)
          .set(breachPatch(metric, since))
          .where(eq(webServerSettings.id, row.id))
          .then(() => undefined),
    };
  }

  /** The settings singleton's metricsConfig; undefined before it exists. */
  private async findWebServerMetricsConfig(): Promise<
    MetricsConfig | undefined
  > {
    const [row] = await this.db
      .select({ metricsConfig: webServerSettings.metricsConfig })
      .from(webServerSettings)
      .orderBy(asc(webServerSettings.createdAt))
      .limit(1);
    return row?.metricsConfig;
  }

  private async findServer(serverId: string): Promise<Server | undefined> {
    const [row] = await this.db
      .select()
      .from(server)
      .where(eq(server.serverId, serverId));
    return row;
  }

  /**
   * The target a read may see. A Server is org-scoped — cross-org rows read as
   * absent. The web server (no serverId) is not: it is one machine shared by
   * every organization on the instance, the way the local forward-auth row is —
   * and that is the reason it takes instance authority, not the reason it took
   * none (H-64).
   *
   * This branch used to `return null` outright, and the sentence above stopped
   * at *"the route's `monitoring:read` permission in the caller's own
   * organization is the whole gate"*. That gate is no gate on this branch:
   * `monitoring` is an entry in `memberRole`, so the **base member role holds
   * `monitoring: ['read']`**, and a plain member of any organization was
   * answered with the platform host's CPU, memory, disk and uptime through
   * `getServerMetrics` and — through `getContainerMetrics`, whose `appName`
   * resolves by substring against every row sampled on the host — the container
   * names of every organization deployed on it. The comparison to the
   * forward-auth row is exactly right and points the other way: that row is
   * what ADR-0013 moved to instance authority for being one thing the whole
   * instance shares.
   *
   * The Server branch is untouched and keeps `monitoring:read` as its only role
   * check: a Server belongs to an organization, and a member reading their own
   * fleet's metrics is what the statement is for.
   *
   * **Narrowed by ADR-0067: `reads` says which of the two reads is asking.**
   * The host's own metrics (`'host'`) keep instance authority here. Container
   * series (`'series'`) do not take it on the target, because the check placed
   * here caught a managed container too: a non-instance Organization's owner
   * was refused its own platform-host Service's stored metrics with
   * `INSTANCE_AUTHORITY_REQUIRED` (#1336). They are decided per series in
   * `resolveServiceName` instead, by `ContainerAccessService.firstReadable`: a
   * managed container by entitlement to its Service in the caller's own
   * Organization, an unmanaged or `cloudgate-*` one by machine access plus
   * instance authority — the substring lookup over every Organization's
   * names that H-64 closed stays closed, since a series the caller may not
   * read is answered as absent.
   */
  private async findReadableTarget(
    ctx: PermissionCtx,
    serverId: string | undefined,
    reads: 'host' | 'series',
  ): Promise<MonitoringTargetId> {
    if (serverId === undefined) {
      if (reads === 'host') await this.permissions.checkInstanceAuthority(ctx);
      return null;
    }
    // The shared lookup's absent-id branch belongs to the platform host
    // (ADR-0008), and this call site has already spent its host branch on the
    // line above: past it an id is required, so the empty string a bare
    // `?serverId=` produces is not a target this read may name. An earlier fix
    // put the enforcement here rather than into the shared lookup, where it
    // would break every genuinely optional caller.
    const found = await checkServerAccess(this.db, ctx, serverId);
    if (!found) throw new NotFoundException('Server not found');
    return serverId;
  }

  /**
   * A Frozen Organization's Server is not sampled (ADR-0052), so its
   * thresholds are not checked either: the tick is skipped, sending nothing
   * to the Server, and the next one asks again. The platform host is never
   * frozen.
   */
  private isFrozenTarget(serverId: MonitoringTargetId): Promise<boolean> {
    if (serverId === null) return Promise.resolve(false);
    return this.frozen.isFrozenAt({ serverId });
  }

  /**
   * A Server whose Bought Server is Deleting or Deleted is never sampled
   * again, so neither are its thresholds: its jobs are dropped at the next
   * tick, as a deleted Server's are (spec #1387, story 76).
   */
  private isRetiredTarget(serverId: MonitoringTargetId): Promise<boolean> {
    if (serverId === null) return Promise.resolve(false);
    return isRetiredServer(this.db, serverId);
  }

  /** The stats shell for a target: SSH for a Server, local for the web server. */
  private exec(serverId: MonitoringTargetId, command: string) {
    return serverId === null
      ? this.remoteExec.execAsync(command)
      : this.remoteExec.execAsyncRemote(serverId, command);
  }

  private addInterval(
    name: string,
    milliseconds: number,
    task: () => Promise<void>,
  ): void {
    const handle = setInterval(() => {
      task().catch((error) =>
        this.logger.error(`Monitoring job ${name} failed`, error),
      );
    }, milliseconds);
    this.schedulerRegistry.addInterval(name, handle);
  }
}

/**
 * Why `GET /monitoring/metrics/containers` cannot answer for this `appName` —
 * the operator's own exclusion when that is the reason, and the two-cause
 * sentence when it genuinely is not.
 *
 * Pure, and exported, for the reason `parseMetricsRange` next door is: the thing
 * worth pinning is the sentence, and reaching it through the service would mean
 * doubling a database rather than a boundary. `test/monitoring/container-metrics-refusal.spec.ts`
 * is that pin; `monitoring.e2e-spec.ts` pins that the route really reaches here.
 *
 * ## Two packages ask "is this name excluded", and this one is authoritative
 *
 * The console asks it too — `exclusionsFor` in
 * `frontend/src/features/monitoring/setup/metrics-config-spec.ts` — and that is
 * not drift to be collapsed later. **This copy is the authority**: it is the
 * answer on the wire, it serves every caller including the ones that are not the
 * console, and it sits next to `shouldMonitorContainer`, the rule collection
 * itself applies. The console keeps its own because of what it is doing with the
 * answer: it explains the row *instead of* this refusal, and it does
 * not even issue the request for an excluded name — so the one thing it cannot
 * do is ask the backend a question whose answer is the refusal it is trying to
 * explain. Both apply the identical conservative rule, and each package holds it
 * once, beside its own matcher: `exclusionsForAppName` here, `exclusionsFor`
 * there. Change one and read the other
 * (the standing rule for a deliberate pair).
 *
 * **The pair is deliberately asymmetric in one place**: the *partial* arm below
 * exists only here, because only this side ever has to answer for a name it
 * could not resolve. The console's two callers both have something narrower in
 * hand — `ContainerHistory` holds a whole container name, where the same test is
 * exact and there is no partial case to have, and the Containers card reaches
 * the partial case only by rendering this refusal, which now says it. Adding a
 * second, unreachable arm to the console would be a copy nothing could ever
 * exercise.
 *
 * The excluded sentence deliberately does **not** claim the container is
 * running: nothing on this path knows that, and inventing a second confident
 * claim to replace the first one is how the sentence got here.
 *
 * ## Three answers, because an exclusion is not always the whole story
 *
 * How much an exclusion explains depends on how it matches, and the sentence
 * says only as much as the match licenses (`partialExclusionsForAppName` carries
 * the rule and the case that produced it):
 *
 * 1. An entry inside the name — `"app-nk3zbo"`, or `"nk3zbo"` — catches every
 *    container the name can reach. "Nothing will be sampled until that entry is
 *    removed" is then true, and it is the whole answer.
 * 2. An entry the name is inside — `"app-nk3zbo.1"`, the shape the console's own
 *    picker displays — catches some of them. It is named as *a* cause and not
 *    the only one, because replica 2 would still be sampled, and the two
 *    original causes stay on the sentence as the alternatives they still are.
 * 3. Neither: the two-cause sentence, which is honest for a name that is simply
 *    not running or not sampled yet.
 *
 * ## The sentence is also the refusal, so it says "you can read"
 *
 * A name whose every match the caller may not read is answered exactly as a
 * name nothing matches (ADR-0067, ADR-0008), so arms 2 and 3 are said to both.
 * They used to open "No container has ever been sampled", which an instance
 * owner asking for another Organization's Service on the platform host was told
 * while the journal held the real cause (#1336): the container had 24 samples.
 * So they claim only what holds for both — nothing *this caller can read* was
 * sampled — and the cause of a refusal stays in the journal. Arm 1 keeps its
 * own claim, which is true by construction: every name containing `appName`
 * contains the entry, so nothing under it was ever stored, readable or not.
 *
 * `metricsConfig` is `undefined` both when there is none and when the caller
 * may not read it: on the platform host the config is the operator's
 * (ADR-0013), so `getContainerMetrics` hands it in only to instance authority,
 * and every other caller gets arm 3 with the first-sample cause.
 */
export function unresolvedAppNameRefusal(
  appName: string,
  metricsConfig: MetricsConfig | undefined,
): string {
  const exclude = metricsConfig?.containers.services.exclude;
  const quoted = (entries: string[]) =>
    entries.map((entry) => `"${entry}"`).join(', ');

  const excludedBy = exclusionsForAppName(appName, exclude);
  if (excludedBy.length > 0) {
    return (
      `Container metrics are never collected for "${appName}": it matches ` +
      `${quoted(excludedBy)} in this target's exclude list ` +
      '(containers.services.exclude, "Never collect for" in the console), which ' +
      'collection checks before the include list — an exclusion beats an ' +
      'inclusion. Nothing has been sampled under this name, and nothing will be ' +
      'until that entry is removed.'
    );
  }

  // A stopped target (token cleared, the setup's `cronJob` kept) is
  // not going to store a first sample, so that cause gives way to the stop.
  const notYet =
    !metricsConfig?.server.token && metricsConfig?.server.cronJob
      ? 'it was not sampled before collection on this target was stopped — ' +
        'nothing new is stored until it is started again.'
      : 'collection has not stored its first sample yet.';

  const unreadable = `No container you can read has been sampled under "${appName}" on this server.`;
  const narrowedBy = partialExclusionsForAppName(appName, exclude);
  if (narrowedBy.length > 0) {
    return (
      `${unreadable} This target's exclude list holds ${quoted(narrowedBy)} ` +
      '(containers.services.exclude, "Never collect for" in the console), which ' +
      'collection checks before the include list and which suppresses some — ' +
      'not necessarily all — of the containers this name matches, so it may be ' +
      'the reason. Otherwise nothing running here that you can read matches ' +
      `that name, or ${notYet}`
    );
  }

  return (
    `${unreadable} Either nothing running here that you can read matches ` +
    `that name, or ${notYet}`
  );
}

/** A stored sample as SystemMetrics — fmt "%.2f" over the float columns. */
export function convertToSystemMetrics(metric: ServerMetric): SystemMetrics {
  return {
    cpu: metric.cpu.toFixed(2),
    cpuModel: metric.cpuModel,
    cpuCores: metric.cpuCores,
    cpuPhysicalCores: metric.cpuPhysicalCores,
    cpuSpeed: metric.cpuSpeed,
    os: metric.os,
    distro: metric.distro,
    kernel: metric.kernel,
    arch: metric.arch,
    memUsed: metric.memUsed.toFixed(2),
    memUsedGB: metric.memUsedGB.toFixed(2),
    memTotal: metric.memTotal.toFixed(2),
    uptime: metric.uptime,
    diskUsed: metric.diskUsed.toFixed(2),
    totalDisk: metric.totalDisk.toFixed(2),
    networkIn: metric.networkIn.toFixed(2),
    networkOut: metric.networkOut.toFixed(2),
    timestamp: metric.timestamp,
  };
}
