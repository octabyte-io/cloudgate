import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { ServiceType } from '../applications/application.schema';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import {
  domain,
  errorRateThreshold,
  incident,
  probe,
  uptimeCheck,
} from '../db/schema';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import { NotificationDispatcherService } from '../notifications/dispatcher.service';
import { InstanceUrlService } from '../settings/instance-url.service';
import type { ErrorRateWindow } from './error-rate.service';
import type { ErrorRateThreshold } from './error-rate-threshold.schema';
import {
  openingRateWords,
  rateWords,
  thresholdWords,
} from './error-rate-threshold-words';
import type { ProbeOutcome } from './http-probe';
import { SERVICE_HEALTH_CLOCK } from './service-health.clock';
import type { ServiceHealthClock } from './service-health.clock';
import type {
  Incident,
  IncidentCloseReason,
  UptimeCheck,
} from './service-health.schema';
import {
  isStopped,
  ownerFacts,
  ownerIdOf,
  ownerStatus,
  UPTIME_CHECK_OWNER_FIELD,
} from './service-owner';
import { tcpHostOf } from './published-ports';
import {
  isThresholdServiceType,
  THRESHOLD_OWNER_COLUMN,
  thresholdOwnerOf,
} from './threshold-owner';
import {
  healthTabPath,
  httpTargetUrl,
  tcpAddress,
} from './uptime-check-target';

/** A transaction, or the database itself, for the writes that take either. */
type Tx = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];

/**
 * What a TCP check turned off for a lost port says about itself: the
 * port, and that it is its Service that stopped publishing it — never which
 * port replaced it, which nothing records.
 */
export function unpublishedPortReason(port: number): string {
  return `Port ${port} is no longer published by this Service, so Cloudgate turned the check off. Aim it at a published port and turn it back on.`;
}

/** An Incident that just changed state, with what announcing it needs. */
export interface Transition {
  state: 'opened' | 'closed';
  incident: Incident;
}

/**
 * The Incident rules — a check's and an Error-rate threshold's
 * — and the only writer of `incident` rows, and the only place a
 * `service-incident` Notification is sent from.
 *
 * **One judgement per Probe, under the check's row lock.** {@link recordProbe}
 * takes `SELECT … FOR UPDATE` on the check before it writes anything, and so
 * does every close ({@link closeForChecks}), so a Probe landing while its
 * Service is being Stopped or its check turned off is judged either wholly
 * before the transition — and then closed by it — or wholly after, when it is
 * discarded because the Service is Stopped or the check is off. Without the
 * lock a Probe that started before a Stop could open an Incident after the
 * Stop had closed the last one.
 *
 * **Announced after the commit, awaited, and never thrown.** A Notification
 * describes a row that exists, so it goes out once the transaction that wrote
 * the row has committed; the dispatcher already swallows a failing channel,
 * and anything else is logged here, because the Incident is recorded and a
 * retry would announce it twice. The caller waits for it so that one tick is
 * one complete step — which is also what lets a suite count messages without
 * sleeping.
 *
 * **A Delete announces nothing**: an Incident is only ever deleted by
 * its owner's cascade, and nothing here runs on a delete.
 */
@Injectable()
export class IncidentsService {
  private readonly logger = new Logger(IncidentsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly dispatcher: NotificationDispatcherService,
    private readonly instanceUrl: InstanceUrlService,
    @Inject(SERVICE_HEALTH_CLOCK) private readonly clock: ServiceHealthClock,
    private readonly instanceMode: InstanceMode,
  ) {}

  /**
   * Records one Probe of a check at `at` and applies the rule to it:
   *
   * - **up** closes the check's open Incident with `recovered`;
   * - **down** opens one when it is the Nth down in a row, N being the check's
   *   `downAfter` as it is now — so an edit that raises N while an Incident is
   *   open leaves it open, and the next Probe is judged by the new N;
   * - a run of downs **across a gap** with no Probes still counts: the rule is
   *   over Probes, not over time, so a stretch in which the platform probed
   *   nothing (the backend down) neither opens nor closes anything;
   * - but a **deliberate transition ends the run**: only Probes after the
   *   check's `runStartedAt` count, which {@link startRuns} sets when the check
   *   is turned off or on and when its Service is Stopped, so a Service that
   *   comes back failing still needs N downs (US26, US7).
   *
   * The Probe is discarded, and nothing judged, when by the time the lock is
   * held the check is gone, off, or its Service Stopped, or when another Probe
   * at or after `at` - interval already landed (a second tick that raced the
   * first to the same due check).
   */
  async recordProbe(
    uptimeCheckId: string,
    outcome: ProbeOutcome,
    at: Date,
  ): Promise<void> {
    const transition = await this.db.transaction(async (tx) => {
      const check = await this.lockCheck(tx, uptimeCheckId);
      if (!check || !check.enabled) return null;
      const status = await ownerStatus(tx, check.serviceType, ownerIdOf(check));
      if (status === null || isStopped(status)) return null;

      const [last] = await tx
        .select({ probedAt: probe.probedAt })
        .from(probe)
        .where(eq(probe.uptimeCheckId, uptimeCheckId))
        .orderBy(desc(probe.probedAt))
        .limit(1);
      if (
        last &&
        new Date(last.probedAt).getTime() + check.intervalSeconds * 1000 >
          at.getTime()
      ) {
        return null;
      }

      const probedAt = at.toISOString();
      await tx.insert(probe).values({
        uptimeCheckId,
        probedAt,
        verdict: outcome.verdict,
        latencyMs: outcome.latencyMs,
        errorClass: outcome.errorClass,
      });

      if (outcome.verdict === 'up') {
        const [closed] = await this.closeOpen(
          tx,
          [uptimeCheckId],
          'recovered',
          probedAt,
        );
        return closed ? { state: 'closed' as const, incident: closed } : null;
      }

      const recent = await tx
        .select({ verdict: probe.verdict })
        .from(probe)
        .where(
          and(
            eq(probe.uptimeCheckId, uptimeCheckId),
            check.runStartedAt
              ? gt(probe.probedAt, check.runStartedAt)
              : undefined,
          ),
        )
        .orderBy(desc(probe.probedAt))
        .limit(check.downAfter);
      const nthDownInARow =
        recent.length === check.downAfter &&
        recent.every((row) => row.verdict === 'down');
      if (!nthDownInARow) return null;

      // At most one open per check: a second opening conflicts on
      // `incident_one_open_per_uptime_check` and inserts nothing, which is
      // also what a check already down for longer than N Probes does.
      const [opened] = await tx
        .insert(incident)
        .values({
          uptimeCheckId,
          openedAt: probedAt,
          openingError: outcome.errorClass,
        })
        .onConflictDoNothing()
        .returning();
      return opened ? { state: 'opened' as const, incident: opened } : null;
    });

    if (transition) await this.announce([transition]);
  }

  /**
   * **Turns a TCP check off because its port is no longer published**:
   * the probe tick found `port` missing from its Service's published ports
   * (`publishedPortsOf`), so instead of dialling a dead port and opening an
   * Incident the operator could only clear by editing the check, the check is
   * turned off with {@link unpublishedPortReason} stored on it, its open
   * Incident closes with `port-unpublished` and that close is announced once.
   * No Probe is recorded, up or down.
   *
   * Under the check's row lock, like every other judgement: nothing happens
   * when by then the check is gone, off, re-aimed at another port, or its
   * Service Stopped — a Stopped Service is not judged for a lost port, the
   * Stop's own close comes first.
   */
  async turnOffForUnpublishedPort(
    uptimeCheckId: string,
    port: number,
  ): Promise<void> {
    await this.turnOffTcpCheck(
      uptimeCheckId,
      port,
      unpublishedPortReason(port),
      'port-unpublished',
    );
  }

  /**
   * **Turns a TCP check off because there is no Server address to dial it
   * on**: the probe tick found its Service with no place a TCP check may dial
   * (`tcpPlaceOf` — a Service in a Cloud account, or one with no Server on
   * the Hosted instance), so rather than dial the platform host the check is
   * turned off with `reason` stored on it and its open Incident closes with
   * `turned-off`, as an operator's turn-off would. No Probe is recorded. The
   * same row-lock conditions as {@link turnOffForUnpublishedPort}.
   */
  async turnOffForNoServer(
    uptimeCheckId: string,
    port: number,
    reason: string,
  ): Promise<void> {
    await this.turnOffTcpCheck(uptimeCheckId, port, reason, 'turned-off');
  }

  private async turnOffTcpCheck(
    uptimeCheckId: string,
    port: number,
    disabledReason: string,
    closeReason: IncidentCloseReason,
  ): Promise<void> {
    const transitions = await this.db.transaction(async (tx) => {
      const check = await this.lockCheck(tx, uptimeCheckId);
      if (!check || !check.enabled || check.port !== port) return [];
      const status = await ownerStatus(tx, check.serviceType, ownerIdOf(check));
      if (status === null || isStopped(status)) return [];
      await tx
        .update(uptimeCheck)
        .set({ enabled: false, disabledReason })
        .where(eq(uptimeCheck.uptimeCheckId, uptimeCheckId));
      return this.closeForChecks(tx, [uptimeCheckId], closeReason);
    });
    await this.announce(transitions);
  }

  /**
   * Judges one Error-rate threshold on the window the collection tick just
   * summed, under the threshold's row lock:
   *
   * - fewer requests than `minRequests` is a **quiet** window: nothing opens,
   *   nothing closes, and the worst rate is not touched;
   * - a rate at or above `percentage` **breaches**: the first such window
   *   opens the Incident with its rate and request count, and every later one
   *   while it is open raises the worst rate if it is higher;
   * - any other judged window is **clear** and closes it with `recovered` —
   *   no run of clear windows is needed.
   *
   * Nothing is judged, and nothing written, when by the time the lock is held
   * the threshold is gone or off or its Service Stopped. The slow share is
   * not an input.
   */
  async judgeThreshold(
    errorRateThresholdId: string,
    window: Pick<ErrorRateWindow, 'requests' | 'errors'>,
    at: Date,
  ): Promise<void> {
    const transition = await this.db.transaction(async (tx) => {
      const [threshold] = await tx
        .select()
        .from(errorRateThreshold)
        .where(
          eq(errorRateThreshold.errorRateThresholdId, errorRateThresholdId),
        )
        .for('update');
      if (!threshold || !threshold.enabled) return null;
      const owner = thresholdOwnerOf(threshold);
      const status = await ownerStatus(tx, owner.serviceType, owner.serviceId);
      if (status === null || isStopped(status)) return null;
      if (window.requests === 0 || window.requests < threshold.minRequests) {
        return null;
      }

      const rate = window.errors / window.requests;
      const judgedAt = at.toISOString();
      if (rate * 100 < threshold.percentage) {
        const [closed] = await this.closeOpenThresholds(
          tx,
          [errorRateThresholdId],
          'recovered',
          judgedAt,
        );
        return closed ? { state: 'closed' as const, incident: closed } : null;
      }

      const [raised] = await tx
        .update(incident)
        .set({
          worstErrorRate: sql`GREATEST(${incident.worstErrorRate}, ${rate})`,
        })
        .where(
          and(
            eq(incident.errorRateThresholdId, errorRateThresholdId),
            isNull(incident.closedAt),
          ),
        )
        .returning({ incidentId: incident.incidentId });
      if (raised) return null;

      // At most one open per threshold: a racing opening conflicts on
      // `incident_one_open_per_error_rate_threshold` and inserts nothing.
      const [opened] = await tx
        .insert(incident)
        .values({
          errorRateThresholdId,
          openedAt: judgedAt,
          openingErrorRate: rate,
          openingRequests: window.requests,
          worstErrorRate: rate,
        })
        .onConflictDoNothing()
        .returning();
      return opened ? { state: 'opened' as const, incident: opened } : null;
    });

    if (transition) await this.announce([transition]);
  }

  /**
   * Starts a new run of Probes for `uptimeCheckIds` at the clock's now: the
   * downs before it no longer count towards N (see {@link recordProbe}).
   * Called for every deliberate transition — {@link closeForChecks} (a
   * turn-off, a Stop), a turn-on, and the probe tick meeting a Stopped
   * Service's check that no Stop hook reached — and never for a stretch in
   * which the platform simply was not probing.
   */
  async startRuns(
    tx: Tx | DrizzleDB,
    uptimeCheckIds: readonly string[],
  ): Promise<void> {
    if (uptimeCheckIds.length === 0) return;
    await tx
      .update(uptimeCheck)
      .set({ runStartedAt: new Date(this.clock.now()).toISOString() })
      .where(inArray(uptimeCheck.uptimeCheckId, [...uptimeCheckIds]));
  }

  /**
   * Closes the open Incidents of `uptimeCheckIds` with `reason`, starts each
   * check's run afresh ({@link startRuns}), and answers the transitions to
   * announce once. Every caller is a deliberate transition: turning a check
   * off calls it with `turned-off` inside its own write (so it passes its
   * transaction), and so does the probe tick's turn-off for a lost port with
   * `port-unpublished` ({@link turnOffForUnpublishedPort}); a Stop calls
   * {@link closeForService}.
   */
  async closeForChecks(
    tx: Tx,
    uptimeCheckIds: readonly string[],
    reason: IncidentCloseReason,
  ): Promise<Transition[]> {
    if (uptimeCheckIds.length === 0) return [];
    await tx
      .select({ id: uptimeCheck.uptimeCheckId })
      .from(uptimeCheck)
      .where(inArray(uptimeCheck.uptimeCheckId, [...uptimeCheckIds]))
      .for('update');
    await this.startRuns(tx, uptimeCheckIds);
    const closed = await this.closeOpen(
      tx,
      uptimeCheckIds,
      reason,
      new Date(this.clock.now()).toISOString(),
    );
    return closed.map((row) => ({ state: 'closed' as const, incident: row }));
  }

  /**
   * {@link closeForChecks} for Error-rate thresholds: turning one off passes
   * its own transaction with `turned-off`; a Stop passes `service-stopped`.
   */
  async closeForThresholds(
    tx: Tx,
    errorRateThresholdIds: readonly string[],
    reason: IncidentCloseReason,
  ): Promise<Transition[]> {
    if (errorRateThresholdIds.length === 0) return [];
    await tx
      .select({ id: errorRateThreshold.errorRateThresholdId })
      .from(errorRateThreshold)
      .where(
        inArray(errorRateThreshold.errorRateThresholdId, [
          ...errorRateThresholdIds,
        ]),
      )
      .for('update');
    const closed = await this.closeOpenThresholds(
      tx,
      errorRateThresholdIds,
      reason,
      new Date(this.clock.now()).toISOString(),
    );
    return closed.map((row) => ({ state: 'closed' as const, incident: row }));
  }

  /**
   * **The Stop hook**: a Service that has just been Stopped closes
   * every open Incident of its checks and of its Error-rate threshold
   * with `service-stopped`, and each is
   * announced once, and starts each check's run afresh. Called by every Stop (`ApplicationsService.stop`,
   * `ComposeService.stop` and `removeContainers`, and every engine's
   * `BaseDatabaseService.stop`) after the status write;
   * {@link closeForStoppedServices} catches a Stop that wrote the status by a
   * path that does not call this.
   */
  async closeForService(
    serviceType: ServiceType,
    serviceId: string,
  ): Promise<void> {
    // A bucket has no uptime check to close.
    if (serviceType === 'bucket') return;
    try {
      const owner = uptimeCheck[UPTIME_CHECK_OWNER_FIELD[serviceType]];
      const transitions = await this.db.transaction(async (tx) => {
        const checks = await tx
          .select({ id: uptimeCheck.uptimeCheckId })
          .from(uptimeCheck)
          .where(eq(owner, serviceId));
        const thresholds = isThresholdServiceType(serviceType)
          ? await tx
              .select({ id: errorRateThreshold.errorRateThresholdId })
              .from(errorRateThreshold)
              .where(eq(THRESHOLD_OWNER_COLUMN[serviceType], serviceId))
          : [];
        return [
          ...(await this.closeForChecks(
            tx,
            checks.map((row) => row.id),
            'service-stopped',
          )),
          ...(await this.closeForThresholds(
            tx,
            thresholds.map((row) => row.id),
            'service-stopped',
          )),
        ];
      });
      await this.announce(transitions);
    } catch (error) {
      // The Stop itself has happened; the tick's reconciliation closes what
      // this could not.
      this.logger.error(
        `Could not close the open Incidents of ${serviceType} ${serviceId} after its Stop`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * Closes, with `service-stopped`, every open Incident whose Service is now
   * Stopped — the probe tick's safety net for a Stop that wrote `'stopped'`
   * without passing {@link closeForService} (a status route, a Stop added
   * later). Nothing is probed while a Service is Stopped, so without this such
   * an Incident would stay open until the Service came back up.
   */
  async closeForStoppedServices(): Promise<void> {
    const open = await this.db
      .select({
        uptimeCheckId: uptimeCheck.uptimeCheckId,
        serviceType: uptimeCheck.serviceType,
        applicationId: uptimeCheck.applicationId,
        composeId: uptimeCheck.composeId,
        libsqlId: uptimeCheck.libsqlId,
        mariadbId: uptimeCheck.mariadbId,
        mongoId: uptimeCheck.mongoId,
        mysqlId: uptimeCheck.mysqlId,
        postgresId: uptimeCheck.postgresId,
        redisId: uptimeCheck.redisId,
      })
      .from(incident)
      .innerJoin(
        uptimeCheck,
        eq(uptimeCheck.uptimeCheckId, incident.uptimeCheckId),
      )
      .where(isNull(incident.closedAt));
    const stopped: string[] = [];
    for (const row of open) {
      const status = await ownerStatus(
        this.db,
        row.serviceType,
        ownerIdOf(row),
      );
      if (isStopped(status)) stopped.push(row.uptimeCheckId);
    }
    const openThresholds = await this.db
      .select({
        errorRateThresholdId: errorRateThreshold.errorRateThresholdId,
        serviceType: errorRateThreshold.serviceType,
        applicationId: errorRateThreshold.applicationId,
        composeId: errorRateThreshold.composeId,
      })
      .from(incident)
      .innerJoin(
        errorRateThreshold,
        eq(
          errorRateThreshold.errorRateThresholdId,
          incident.errorRateThresholdId,
        ),
      )
      .where(isNull(incident.closedAt));
    const stoppedThresholds: string[] = [];
    for (const row of openThresholds) {
      const owner = thresholdOwnerOf(row);
      const status = await ownerStatus(
        this.db,
        owner.serviceType,
        owner.serviceId,
      );
      if (isStopped(status)) stoppedThresholds.push(row.errorRateThresholdId);
    }
    if (stopped.length === 0 && stoppedThresholds.length === 0) return;
    const transitions = await this.db.transaction(async (tx) => [
      ...(await this.closeForChecks(tx, stopped, 'service-stopped')),
      ...(await this.closeForThresholds(
        tx,
        stoppedThresholds,
        'service-stopped',
      )),
    ]);
    await this.announce(transitions);
  }

  /**
   * Sends one `service-incident` Notification per transition, to the owning
   * Service's Organization. Swallows its failures (see the class docblock).
   */
  async announce(transitions: readonly Transition[]): Promise<void> {
    for (const { state, incident: row } of transitions) {
      try {
        await this.announceOne(state, row);
      } catch (error) {
        this.logger.error(
          `Could not announce Incident ${row.incidentId} ${state}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }

  private async announceOne(
    state: 'opened' | 'closed',
    row: Incident,
  ): Promise<void> {
    if (row.errorRateThresholdId) {
      return this.announceThreshold(state, row, row.errorRateThresholdId);
    }
    if (!row.uptimeCheckId) return;
    const [check] = await this.db
      .select()
      .from(uptimeCheck)
      .where(eq(uptimeCheck.uptimeCheckId, row.uptimeCheckId))
      .limit(1);
    if (!check) return;
    const serviceId = ownerIdOf(check);
    const owner = await ownerFacts(this.db, check.serviceType, serviceId);
    if (!owner) return;
    const target = await this.targetOf(check);
    const url = await this.instanceUrl.getInstanceUrl();

    await this.dispatcher.dispatch(owner.organizationId, {
      type: 'service-incident',
      organizationId: owner.organizationId,
      state,
      source: 'uptime-check',
      serviceName: owner.name,
      projectName: owner.projectName,
      environmentName: owner.environmentName,
      target,
      openingError: row.openingError ?? 'down',
      openedAt: row.openedAt,
      ...(state === 'closed' && row.closedAt && { closedAt: row.closedAt }),
      ...(state === 'closed' && row.closeReason && { reason: row.closeReason }),
      ...(url && {
        serviceLink: `${url}${healthTabPath(check.serviceType, serviceId)}`,
      }),
    });
  }

  /**
   * A threshold's Incident as the Notification words it: the threshold as
   * its target, the opening window's rate and request count as its error,
   * and on a close the worst rate while open.
   */
  private async announceThreshold(
    state: 'opened' | 'closed',
    row: Incident,
    errorRateThresholdId: string,
  ): Promise<void> {
    const [threshold]: ErrorRateThreshold[] = await this.db
      .select()
      .from(errorRateThreshold)
      .where(eq(errorRateThreshold.errorRateThresholdId, errorRateThresholdId))
      .limit(1);
    if (!threshold) return;
    const { serviceType, serviceId } = thresholdOwnerOf(threshold);
    const owner = await ownerFacts(this.db, serviceType, serviceId);
    if (!owner) return;
    const url = await this.instanceUrl.getInstanceUrl();

    await this.dispatcher.dispatch(owner.organizationId, {
      type: 'service-incident',
      organizationId: owner.organizationId,
      state,
      source: 'error-rate-threshold',
      serviceName: owner.name,
      projectName: owner.projectName,
      environmentName: owner.environmentName,
      target: thresholdWords(threshold),
      openingError: openingRateWords(
        row.openingErrorRate ?? 0,
        row.openingRequests ?? 0,
      ),
      openedAt: row.openedAt,
      ...(state === 'closed' &&
        row.worstErrorRate !== null && {
          worstRate: rateWords(row.worstErrorRate),
        }),
      ...(state === 'closed' && row.closedAt && { closedAt: row.closedAt }),
      ...(state === 'closed' && row.closeReason && { reason: row.closeReason }),
      ...(url && {
        serviceLink: `${url}${healthTabPath(serviceType, serviceId)}`,
      }),
    });
  }

  /**
   * What a check watches, as a Notification names it: the URL of an HTTP
   * check's Domain, or `host:port` for a TCP one — never its keyword
   * or its header.
   */
  private async targetOf(check: UptimeCheck): Promise<string> {
    if (check.kind === 'tcp' && check.port !== null) {
      const host = await tcpHostOf(
        this.db,
        check.serviceType,
        ownerIdOf(check),
        this.instanceMode,
      );
      // A check with nowhere to dial is named by its port alone.
      return host === null
        ? `port ${check.port}`
        : tcpAddress(host, check.port);
    }
    if (!check.domainId) return 'unknown target';
    const [target] = await this.db
      .select({ host: domain.host, https: domain.https, path: domain.path })
      .from(domain)
      .where(eq(domain.domainId, check.domainId))
      .limit(1);
    return target ? httpTargetUrl(target).toString() : 'unknown target';
  }

  /** The check, locked for the rest of the transaction; undefined when gone. */
  private async lockCheck(
    tx: Tx,
    uptimeCheckId: string,
  ): Promise<UptimeCheck | undefined> {
    const [check] = await tx
      .select()
      .from(uptimeCheck)
      .where(eq(uptimeCheck.uptimeCheckId, uptimeCheckId))
      .for('update');
    return check;
  }

  private closeOpen(
    tx: Tx,
    uptimeCheckIds: readonly string[],
    reason: IncidentCloseReason,
    closedAt: string,
  ): Promise<Incident[]> {
    return tx
      .update(incident)
      .set({ closedAt, closeReason: reason })
      .where(
        and(
          inArray(incident.uptimeCheckId, [...uptimeCheckIds]),
          isNull(incident.closedAt),
        ),
      )
      .returning();
  }

  private closeOpenThresholds(
    tx: Tx,
    errorRateThresholdIds: readonly string[],
    reason: IncidentCloseReason,
    closedAt: string,
  ): Promise<Incident[]> {
    return tx
      .update(incident)
      .set({ closedAt, closeReason: reason })
      .where(
        and(
          inArray(incident.errorRateThresholdId, [...errorRateThresholdIds]),
          isNull(incident.closedAt),
        ),
      )
      .returning();
  }
}
