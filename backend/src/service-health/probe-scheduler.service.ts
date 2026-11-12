import { FrozenOrganizations } from '../cloud/billing/frozen-organizations.service';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { eq, lt, max } from 'drizzle-orm';
import { DRIZZLE } from '../db/drizzle.module';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import {
  isServerAddressRefusal,
  ServerAddressGuard,
} from '../servers/server-address-guard';
import type { DrizzleDB } from '../db/drizzle.module';
import { domain, probe, uptimeCheck } from '../db/schema';
import { SchedulingService } from '../scheduling/scheduling.service';
import { probeHttp } from './http-probe';
import type { ProbeOutcome } from './http-probe';
import { IncidentsService } from './incidents.service';
import { PROBE_TARGET } from './probe-target.port';
import type { ProbeTarget } from './probe-target.port';
import { SERVICE_HEALTH_CLOCK } from './service-health.clock';
import type { ServiceHealthClock } from './service-health.clock';
import type { UptimeCheck } from './service-health.schema';
import { publishedPortsOf } from './published-ports';
import { isStopped, ownerIdOf, ownerStatus } from './service-owner';
import { probeTcp } from './tcp-probe';
import {
  isOutboundAddressRefusal,
  OutboundAddressGuard,
} from '../outbound/outbound-address-guard';
import { httpTargetUrl } from './uptime-check-target';

/** How often the tick looks for due checks; a check's own interval is ≥ 30 s. */
export const PROBE_TICK_MS = 5_000;
export const PROBE_TICK_JOB = 'service-health-probe-tick';

/** How long a Probe is kept, independent of monitoring `retentionDays`. */
export const PROBE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const PROBE_PRUNE_JOB = 'service-health-probe-prune';
export const PROBE_PRUNE_CRON = '23 * * * *';

/**
 * The class a Probe is down with when its Domain's `host` is not a public
 * address the platform host may dial for this Service (`OutboundAddressGuard`),
 * or a TCP check's Server address is one the Hosted instance refuses
 * (`ServerAddressGuard`).
 */
export const DOMAIN_HOST_REFUSED = 'host is not a public address';

/**
 * Probes every due Uptime check from the platform host, in-process.
 *
 * **One instance-wide tick, not a timer per check.** Every
 * {@link PROBE_TICK_MS} the tick reads which enabled checks are due — never
 * probed, or last probed at least their own interval ago on
 * {@link SERVICE_HEALTH_CLOCK} — and probes them all at once. Due-ness is read
 * from the Probe rows, so a restart resumes where the rows say rather than
 * re-arming a timer per check, and a stretch in which the backend was down
 * simply has no Probes in it (neither up nor down).
 *
 * **The in-flight guard is per check** ({@link inFlight}), the metrics
 * collectors' guard one level finer: a check whose last Probe has not come
 * back — a hang is bounded by its timeout, which the DTO keeps under its
 * interval — is not probed again. A second tick that meets a check in flight
 * **waits for that Probe** instead of skipping it, so a direct call to
 * {@link tick} always returns with every due check's Probe recorded and
 * announced, whether or not the background tick got there first.
 * `IncidentsService.recordProbe` discards a Probe that lands within an interval
 * of the last, which is what stops two ticks racing one check from recording it
 * twice.
 *
 * **A TCP check whose port is no longer published is turned off, not
 * dialled**: before the dial, the tick reads the Service's published
 * ports as `publishedPortsOf` answers them — for every port source alike —
 * and hands a missing one to `IncidentsService.turnOffForUnpublishedPort`.
 * The Stopped skip below comes first, so a Stopped Service is never judged
 * for a lost port. **A TCP check with no Server address to dial is turned
 * off the same way** (`IncidentsService.turnOffForNoServer`), never dialled
 * on the platform host: a Service in a Cloud account in any mode, and one
 * with no Server on the Hosted instance (`tcpPlaceOf`).
 *
 * A Stopped Service's checks and a disabled check are not probed, and each
 * tick first closes any open Incident whose Service is now Stopped
 * (`IncidentsService.closeForStoppedServices`), the safety net under the Stop
 * hook — and starts a fresh run for a Stopped Service's check probed since its
 * last run began, so a Stop no hook reached still ends a run of downs.
 */
@Injectable()
export class ProbeScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(ProbeScheduler.name);

  /** The Probe of each check that has not come back yet. */
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly incidents: IncidentsService,
    private readonly registry: SchedulerRegistry,
    private readonly scheduling: SchedulingService,
    @Inject(PROBE_TARGET) private readonly target: ProbeTarget,
    @Inject(SERVICE_HEALTH_CLOCK) private readonly clock: ServiceHealthClock,
    private readonly frozen: FrozenOrganizations,
    private readonly guard: OutboundAddressGuard,
    private readonly instanceMode: InstanceMode,
    private readonly serverAddresses: ServerAddressGuard,
  ) {}

  /**
   * Arms the tick and the prune, tolerant of a registry that refuses: a boot
   * that cannot arm housekeeping must still be a boot that starts.
   */
  onApplicationBootstrap(): void {
    try {
      const handle = setInterval(() => {
        this.tick().catch((error) =>
          this.logger.error('Uptime check tick failed', error),
        );
      }, PROBE_TICK_MS);
      this.registry.addInterval(PROBE_TICK_JOB, handle);
      this.scheduling.register(PROBE_PRUNE_JOB, PROBE_PRUNE_CRON, null, () =>
        this.prune().then(() => undefined),
      );
    } catch (error) {
      this.logger.error('Uptime check probing could not be armed', error);
    }
  }

  /**
   * One tick at the clock's now: close the open Incidents of Stopped Services,
   * then probe every due check and record each verdict. Resolves once every
   * Probe it started or met in flight is recorded and announced.
   */
  async tick(): Promise<void> {
    const now = this.clock.now();
    await this.incidents.closeForStoppedServices();
    const due = await this.dueChecks(now);
    await Promise.all(due.map((check) => this.probeOnce(check, now)));
  }

  /**
   * Deletes Probes older than seven days before the clock's now, and answers
   * how many. Incidents are kept for the life of their check.
   */
  async prune(): Promise<number> {
    const before = new Date(this.clock.now() - PROBE_RETENTION_MS);
    const removed = await this.db
      .delete(probe)
      .where(lt(probe.probedAt, before.toISOString()))
      .returning({ probeId: probe.probeId });
    return removed.length;
  }

  private probeOnce(check: DueCheck, now: number): Promise<void> {
    const running = this.inFlight.get(check.check.uptimeCheckId);
    if (running) return running;
    const pass = this.probe(check, now)
      .catch((error) =>
        this.logger.error(
          `Uptime check ${check.check.uptimeCheckId} could not be probed`,
          error,
        ),
      )
      .finally(() => this.inFlight.delete(check.check.uptimeCheckId));
    this.inFlight.set(check.check.uptimeCheckId, pass);
    return pass;
  }

  private async probe(due: DueCheck, now: number): Promise<void> {
    const { check } = due;
    const timeoutMs = check.timeoutSeconds * 1000;
    let outcome: ProbeOutcome;
    if (due.kind === 'tcp') {
      // The same answer the picker and `ownPort` give, read every tick: a
      // port the Service stopped publishing is never dialled. The
      // check is turned off with the reason and nothing is recorded — a
      // down Probe would open an Incident about a port nobody serves.
      const published = await publishedPortsOf(
        this.db,
        check.serviceType,
        ownerIdOf(check),
        this.instanceMode,
      );
      // No Server address to dial — a Service in a Cloud account, or one with
      // no Server on the Hosted instance — is never answered with the
      // platform host's: the check is turned off with the reason instead.
      if (published.host === null) {
        await this.incidents.turnOffForNoServer(
          check.uptimeCheckId,
          due.port,
          published.unavailableReason ?? '',
        );
        return;
      }
      if (!published.ports.some((entry) => entry.port === due.port)) {
        await this.incidents.turnOffForUnpublishedPort(
          check.uptimeCheckId,
          due.port,
        );
        return;
      }
      // The host is read every tick too, so a check follows its Server's
      // address.
      outcome = await this.probeServerPort(published.host, due.port, timeoutMs);
    } else {
      outcome = await this.probeDomain(due);
    }
    await this.incidents.recordProbe(
      check.uptimeCheckId,
      outcome,
      new Date(now),
    );
  }

  /**
   * A TCP Probe of a published port on its Service's Server address. On the
   * Hosted instance that address is checked as an SSH connect checks it
   * (`ServerAddressGuard`, ADR-0053) and the address checked is the one
   * dialled, so a Server name whose records now lead back onto the box or its
   * network is down with {@link DOMAIN_HOST_REFUSED}'s sentence rather than
   * dialled. Self-hosted, the address is dialled as it is stored.
   */
  private async probeServerPort(
    host: string,
    port: number,
    timeoutMs: number,
  ): Promise<ProbeOutcome> {
    let address: string;
    try {
      address = await this.serverAddresses.addressToDial(host);
    } catch (error) {
      if (!isServerAddressRefusal(error)) throw error;
      return {
        verdict: 'down',
        latencyMs: null,
        errorClass: DOMAIN_HOST_REFUSED,
      };
    }
    const dial = this.target.tcp(address, port);
    return probeTcp(dial.host, dial.port, { timeoutMs });
  }

  /**
   * An HTTP Probe of the check's Domain, from the platform host — so guarded
   * here, at the dial, since nothing asks on a timer. A Domain's host
   * that is, or resolves to, loopback, a private or link-local range or the
   * metadata address is not dialled for a Service outside the instance
   * organization: the Probe is down with {@link DOMAIN_HOST_REFUSED}, which
   * names the field to correct, and nothing is sent — no custom header, no
   * keyword read whose verdict would tell the customer what an internal page
   * says. Otherwise the Probe connects to the address that was checked.
   */
  private async probeDomain(due: DueHttpCheck): Promise<ProbeOutcome> {
    const { check } = due;
    let address: string;
    try {
      address = await this.guard.addressToDial(due.url.hostname, {
        place: { serviceId: ownerIdOf(check) },
        field: 'host',
      });
    } catch (error) {
      if (!isOutboundAddressRefusal(error)) throw error;
      return {
        verdict: 'down',
        latencyMs: null,
        errorClass: DOMAIN_HOST_REFUSED,
      };
    }
    return probeHttp(this.target.http(due.url), {
      timeoutMs: check.timeoutSeconds * 1000,
      expectedStatuses: check.expectedStatuses,
      keyword: check.keyword,
      // The header goes only with a value: a name alone is a header the
      // operator is part-way through rotating, and an empty one is noise.
      header:
        check.headerName && check.headerValue
          ? { name: check.headerName, value: check.headerValue }
          : null,
      // An exempt dial is handed the host back unchanged and resolves it as
      // it always did; a checked one is pinned to the address checked.
      ...(address !== due.url.hostname && { address }),
    });
  }

  /**
   * Enabled checks of running Services whose interval has elapsed, of
   * Organizations that are not frozen.
   */
  private async dueChecks(now: number): Promise<DueCheck[]> {
    const lastProbe = this.db
      .select({
        uptimeCheckId: probe.uptimeCheckId,
        lastProbedAt: max(probe.probedAt).as('last_probed_at'),
      })
      .from(probe)
      .groupBy(probe.uptimeCheckId)
      .as('last_probe');
    const rows = await this.db
      .select({
        check: uptimeCheck,
        target: { host: domain.host, https: domain.https, path: domain.path },
        lastProbedAt: lastProbe.lastProbedAt,
      })
      .from(uptimeCheck)
      .leftJoin(domain, eq(domain.domainId, uptimeCheck.domainId))
      .leftJoin(
        lastProbe,
        eq(lastProbe.uptimeCheckId, uptimeCheck.uptimeCheckId),
      )
      .where(eq(uptimeCheck.enabled, true));

    const due: DueCheck[] = [];
    const stoppedMidRun: string[] = [];
    for (const row of rows) {
      if (
        row.lastProbedAt &&
        new Date(row.lastProbedAt).getTime() +
          row.check.intervalSeconds * 1000 >
          now
      ) {
        continue;
      }
      const serviceId = ownerIdOf(row.check);
      // A Frozen Organization's checks are not probed (ADR-0052).
      if (await this.frozen.isFrozenAt({ serviceId })) continue;
      const status = await ownerStatus(
        this.db,
        row.check.serviceType,
        serviceId,
      );
      if (status === null) continue;
      if (isStopped(status)) {
        // A Stop no Stop hook reached still ends the run (US26), once.
        const { runStartedAt } = row.check;
        if (
          row.lastProbedAt &&
          (!runStartedAt || runStartedAt < row.lastProbedAt)
        ) {
          stoppedMidRun.push(row.check.uptimeCheckId);
        }
        continue;
      }
      if (row.check.kind === 'tcp') {
        if (row.check.port === null) continue;
        due.push({ kind: 'tcp', check: row.check, port: row.check.port });
      } else if (row.target) {
        due.push({
          kind: 'http',
          check: row.check,
          url: httpTargetUrl(row.target),
        });
      }
    }
    await this.incidents.startRuns(this.db, stoppedMidRun);
    return due;
  }
}

type DueHttpCheck = { kind: 'http'; check: UptimeCheck; url: URL };
type DueCheck =
  DueHttpCheck | { kind: 'tcp'; check: UptimeCheck; port: number };
