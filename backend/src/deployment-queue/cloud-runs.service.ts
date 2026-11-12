import { appendFile } from 'fs/promises';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  BeforeApplicationShutdown,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { FrozenOrganizations } from '../cloud/billing/frozen-organizations.service';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { deployment } from '../deployments/deployment.schema';
import { environmentNetwork } from '../environments/environment-network.schema';
import { linkSourceStates } from '../project-config/outputs';
import type {
  CloudRunShape,
  Deployment,
} from '../deployments/deployment.schema';
import type {
  CloudRunControl,
  CloudRunEnding,
  CloudRunExecutor,
  CloudRunJob,
  CloudRunKind,
  CloudRunPhase,
} from './cloud-run-job.types';
import { CloudRunPool } from './cloud-run-pool';
import {
  CLOUD_RUN_SETTINGS,
  CLOUD_RUN_TIMING,
} from './cloud-runs-concurrency.provider';
import type {
  CloudRunSettings,
  CloudRunTiming,
} from './cloud-runs-concurrency.provider';

/**
 * DI token for the work of a Cloud run. The pool owns waiting,
 * ordering, the time limit and ending a run; what a run *does* — `tofu plan`,
 * the plan check, `tofu apply` — is this function, bound by what builds it
 * (the tofu runner, deploy and network runs).
 */
export const CLOUD_RUN_EXECUTOR = Symbol('CLOUD_RUN_EXECUTOR');

/**
 * The executor bound until a ticket binds a real one: there is nothing yet
 * that can run `tofu`, so a run that reaches it fails, saying so.
 */
export const noCloudRunExecutor: CloudRunExecutor = () =>
  Promise.reject(
    new Error(
      'This Cloudgate cannot run a Cloud run yet: no runner is installed',
    ),
  );

/**
 * The Cloud runs a Frozen Organization may still start (ADR-0052):
 * the ones that remove what it has in its cloud, so a customer leaving can
 * always pull their Services out of their own account. Every other kind is
 * refused before it waits in the pool.
 */
export const RUNS_WHILE_FROZEN: ReadonlySet<CloudRunKind> = new Set([
  'destroy',
  'network-destroy',
  'bucket-destroy',
  'database-destroy',
  'stack-vm-destroy',
]);

/** A Service's Infrastructure state key, `application:<id>`. */
const APPLICATION_STATE = 'application:';

/** "Changes made so far …", the half every outside ending shares. */
export const CHANGES_STAY =
  'Changes made so far stay in your AWS account; the next deploy picks up from them.';

/** A cloud row still `running` at start-up, or cut off by a shutdown. */
export const CUT_OFF_BY_RESTART =
  'Cut off by a Cloudgate restart; the next deploy picks up from what was made.';

/**
 * The sentence a cut-off row ends with: {@link CUT_OFF_BY_RESTART}, or the
 * run's own when it recorded one (`CloudRunShape.cutOff`), since
 * "picks up from what was made" is not true of every run.
 */
const cutOffDescription = sql<string>`coalesce(${deployment.cloudRun}->>'cutOff', ${CUT_OFF_BY_RESTART})`;

/** Why Cancel is refused once the apply has begun (US69). */
export const CANCEL_REFUSED_WHILE_APPLYING =
  'This Cloud run has begun applying changes in your AWS account, so it can no longer be cancelled — "cancelled" means nothing was changed. Stop the run ends it; changes made so far stay in your AWS account and the next deploy picks up from them.';

/** The sentence a row ends with, by how its run ended from outside. */
export function endingDescription(ending: CloudRunEnding): string | null {
  switch (ending.kind) {
    case 'stopped':
      return `Stopped by ${ending.by}. ${CHANGES_STAY}`;
    case 'timed-out':
      return `Ended by the Cloud run time limit of ${ending.minutes} minutes. ${CHANGES_STAY}`;
    case 'shutdown':
      return ending.started ? CUT_OFF_BY_RESTART : null;
    case 'failed':
      return ending.message;
    default:
      return null;
  }
}

/**
 * The Cloud run pool as the backend runs it: one install-wide
 * {@link CloudRunPool}, its settings read from the settings row, its work the
 * bound {@link CLOUD_RUN_EXECUTOR}, and its endings written to the Deployment
 * rows the runs record.
 *
 * **The rows are what survive.** The pool is in memory like the build queue;
 * a cloud row is one whose `cloud_run` is set, and start-up settles them —
 * `pending` is queued again, `running` ends `error` with
 * {@link CUT_OFF_BY_RESTART} (or the sentence the run recorded as its
 * `cutOff`) and is never re-run (US71/US72).
 * Shutdown (`enableShutdownHooks` in `main.ts`, SIGTERM from systemd) waits
 * for the runs, interrupting them, and settles their rows before the unit's
 * `TimeoutStopSec=5min`.
 */
@Injectable()
export class CloudRunsService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(CloudRunsService.name);
  private readonly pool: CloudRunPool;
  /** Resolves once {@link settleAtStartUp} has settled what a restart left. */
  private readonly startUp: Promise<void>;
  private startedUp: () => void = () => undefined;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(CLOUD_RUN_SETTINGS) settings: CloudRunSettings,
    @Inject(CLOUD_RUN_TIMING) timing: CloudRunTiming,
    @Inject(CLOUD_RUN_EXECUTOR) private readonly executor: CloudRunExecutor,
    private readonly frozen: FrozenOrganizations,
  ) {
    this.startUp = new Promise<void>((resolve) => {
      this.startedUp = resolve;
    });
    this.pool = new CloudRunPool({
      resolveLimit: () => settings.resolveLimit(),
      resolveTimeLimitMinutes: () => settings.timeLimitMinutes(),
      minuteMs: timing.minuteMs,
      killGraceMs: timing.killGraceMs,
      shutdownGraceMs: timing.shutdownGraceMs,
      executor: (job, control) => this.execute(job, control),
      onEnded: (job, ending) => this.settle(job, ending),
    });
  }

  /**
   * Queue the run a Deployment records: the row is marked a cloud row and
   * `pending` (its build, if any, is behind it), then waits in the pool.
   * Resolves with how the run ended, the row already settled.
   *
   * A Frozen Organization's run is refused here unless it removes something
   * ({@link RUNS_WHILE_FROZEN}): its row ends `error` with the refusal and
   * the run fails without waiting.
   */
  async submit(
    deploymentId: string,
    shape: CloudRunShape,
  ): Promise<CloudRunEnding> {
    const refusal = await this.frozenRefusal(shape);
    if (refusal !== null) return this.refuse(deploymentId, refusal);
    await this.db
      .update(deployment)
      .set({ cloudRun: shape, status: 'pending' })
      .where(eq(deployment.deploymentId, deploymentId));
    return this.pool.submit({ deploymentId, ...shape });
  }

  /**
   * {@link submit} for a row whose build has just finished in the build slot
   * resolves once the row is a waiting cloud row, not when the run
   * ends, so the build slot is free while the run waits in the pool. The
   * ending settles the row as every run's does.
   *
   * Not asked whether its Organization is frozen: the build before it has
   * already run, and a deploy already started finishes.
   */
  async handOff(deploymentId: string, given: CloudRunShape): Promise<void> {
    const shape: CloudRunShape = {
      ...(await this.withLinkSources(given)),
      afterBuild: true,
    };
    await this.db
      .update(deployment)
      .set({ cloudRun: shape, status: 'pending' })
      .where(eq(deployment.deploymentId, deploymentId));
    void this.pool
      .submit({ deploymentId, ...shape })
      .catch((error: unknown) =>
        this.logger.error(`Cloud run ${deploymentId} failed to settle`, error),
      );
  }

  /**
   * A Service's deploy waits for the Cloud runs of the sources its links
   * name (ADR-0031): kept on the row, so a run start-up queues again
   * waits alike.
   */
  private async withLinkSources(shape: CloudRunShape): Promise<CloudRunShape> {
    const applicationId = shape.stateKey.startsWith(APPLICATION_STATE)
      ? shape.stateKey.slice(APPLICATION_STATE.length)
      : null;
    if (shape.kind !== 'deploy' || applicationId === null) return shape;
    const after = await linkSourceStates(this.db, applicationId);
    return after.length === 0 ? shape : { ...shape, after };
  }

  /**
   * A plan-only read; joins one of the same state already queued or running.
   * A Frozen Organization's read fails with the refusal, unread.
   */
  async read(
    job: Omit<CloudRunJob, 'deploymentId' | 'kind'>,
  ): Promise<CloudRunEnding> {
    const refusal = await this.frozenRefusal({ ...job, kind: 'read' });
    if (refusal !== null) return { kind: 'failed', message: refusal };
    return this.pool.read({ ...job, deploymentId: null, kind: 'read' });
  }

  /** The refusal of a run its frozen Organization may not start, or null. */
  private frozenRefusal(
    shape: Pick<CloudRunShape, 'kind' | 'environmentId'>,
  ): Promise<string | null> {
    if (RUNS_WHILE_FROZEN.has(shape.kind)) return Promise.resolve(null);
    return this.frozen.refusalAt({ environmentId: shape.environmentId });
  }

  /** {@link frozenRefusal} for a run leaving the pool, a handed-off one exempt. */
  private async refusalAtPickUp(job: CloudRunJob): Promise<string | null> {
    if (job.deploymentId !== null) {
      const [row] = await this.db
        .select({ cloudRun: deployment.cloudRun })
        .from(deployment)
        .where(eq(deployment.deploymentId, job.deploymentId))
        .limit(1);
      if (row?.cloudRun?.afterBuild) return null;
    }
    return this.frozenRefusal(job);
  }

  /** A refused run: its row settled `error` with the sentence, never queued. */
  private async refuse(
    deploymentId: string,
    message: string,
  ): Promise<CloudRunEnding> {
    const [row] = await this.db
      .update(deployment)
      .set({
        status: 'error',
        description: message,
        finishedAt: new Date().toISOString(),
      })
      .where(eq(deployment.deploymentId, deploymentId))
      .returning();
    if (row) await this.logLine(row, message);
    return { kind: 'failed', message };
  }

  /** Where the run recording this Deployment is, or null if not in the pool. */
  phaseOf(deploymentId: string): CloudRunPhase | null {
    return this.pool.phaseOf(deploymentId);
  }

  /** Cancel, as the pool answers it; the caller writes `cancelled`. */
  cancel(deploymentId: string): 'cancelled' | 'applying' | 'unknown' {
    return this.pool.cancel(deploymentId);
  }

  /**
   * Stop the run: the run is interrupted, then killed after 5 minutes, and
   * its row ends `error` naming `by` once it has. Until then it stays
   * `running`, its description saying it is being stopped.
   */
  async stop(
    deploymentId: string,
    by: string,
  ): Promise<'stopping' | 'waiting' | 'unknown'> {
    const outcome = this.pool.stop(deploymentId, by);
    if (outcome === 'stopping') {
      await this.db
        .update(deployment)
        .set({ description: `Stopping — asked by ${by}. ${CHANGES_STAY}` })
        .where(
          and(
            eq(deployment.deploymentId, deploymentId),
            eq(deployment.status, 'running'),
          ),
        );
    }
    return outcome;
  }

  onApplicationBootstrap(): Promise<void> {
    return this.settleAtStartUp();
  }

  /**
   * Resolves once start-up has settled the cloud rows a restart left: what
   * a restart's own follow-up submits waits for it, so start-up neither
   * settles its row as cut off nor queues it a second time.
   */
  settledAtStartUp(): Promise<void> {
    return this.startUp;
  }

  /**
   * Start-up: a cloud row still `running` was cut off — it is
   * settled `error` and never run again by itself, and a network it was
   * making or removing settled as that run failing would; a cloud row still
   * `pending` never started, and is queued again. Tolerant of an un-migrated
   * database, like every boot hook: a boot that cannot settle still boots.
   */
  async settleAtStartUp(): Promise<void> {
    try {
      const cutOff = await this.db
        .update(deployment)
        .set({
          status: 'error',
          description: cutOffDescription,
          finishedAt: new Date().toISOString(),
        })
        .where(
          and(isNotNull(deployment.cloudRun), eq(deployment.status, 'running')),
        )
        .returning();
      for (const row of cutOff) {
        await this.logLine(row, row.description ?? CUT_OFF_BY_RESTART);
      }
      // A network's run holds its row `creating` or `deleting` while it goes,
      // and only the run moves it on: cut off, the network reads as a run that
      // failed would leave it, so Check for changes or Retry reaches it again.
      for (const row of cutOff) {
        if (row.cloudRun?.kind !== 'network' || !row.environmentNetworkId) {
          continue;
        }
        for (const [from, to] of [
          ['creating', 'create-failed'],
          ['deleting', 'delete-incomplete'],
        ] as const) {
          await this.db
            .update(environmentNetwork)
            .set({ status: to })
            .where(
              and(
                eq(
                  environmentNetwork.environmentNetworkId,
                  row.environmentNetworkId,
                ),
                eq(environmentNetwork.status, from),
              ),
            );
        }
      }

      const queued = await this.db
        .select()
        .from(deployment)
        .where(
          and(isNotNull(deployment.cloudRun), eq(deployment.status, 'pending')),
        )
        .orderBy(deployment.createdAt);
      for (const row of queued) {
        if (!row.cloudRun) continue;
        void this.pool.submit({
          deploymentId: row.deploymentId,
          ...row.cloudRun,
        });
      }
    } catch (error) {
      this.logger.error('Cloud runs could not be settled at start-up', error);
    } finally {
      this.startedUp();
    }
  }

  /** SIGTERM: interrupt and wait for every run, and settle its row. */
  beforeApplicationShutdown(): Promise<void> {
    return this.pool.shutdown();
  }

  /**
   * The bound executor, behind the row turning `running` as the run starts.
   *
   * Frozen is asked again here, as the run leaves the pool: a run
   * that was waiting when its Organization froze, or one start-up queued
   * again, would otherwise start without the question {@link submit} asks.
   * Refused, it fails before the executor runs, so its row ends `error` with
   * the refusal like a refused submit's. A removal ({@link RUNS_WHILE_FROZEN})
   * and a deploy whose build already ran (`afterBuild`) still go.
   */
  private async execute(
    job: CloudRunJob,
    control: CloudRunControl,
  ): Promise<unknown> {
    const refusal = await this.refusalAtPickUp(job);
    if (refusal !== null) throw new Error(refusal);
    if (job.deploymentId !== null) {
      await this.db
        .update(deployment)
        .set({ status: 'running', startedAt: new Date().toISOString() })
        .where(
          and(
            eq(deployment.deploymentId, job.deploymentId),
            eq(deployment.status, 'pending'),
          ),
        );
    }
    return this.executor(job, control);
  }

  /**
   * The row a run ended, written once. A run that finished on its own is
   * `done` unless its executor already wrote another ending; `cancelled`
   * only for Cancel; every outside ending is `error` with its sentence, the
   * same sentence appended to the log as its last line. A run that never left
   * the queue at shutdown keeps its `pending` row for start-up.
   */
  private async settle(
    job: CloudRunJob,
    ending: CloudRunEnding,
  ): Promise<void> {
    if (job.deploymentId === null) return;
    if (ending.kind === 'shutdown' && !ending.started) return;
    const status =
      ending.kind === 'finished'
        ? 'done'
        : ending.kind === 'cancelled'
          ? 'cancelled'
          : 'error';
    const description =
      ending.kind === 'shutdown'
        ? cutOffDescription
        : endingDescription(ending);
    const [row] = await this.db
      .update(deployment)
      .set({
        status,
        finishedAt: new Date().toISOString(),
        ...(description === null ? {} : { description }),
      })
      .where(
        and(
          eq(deployment.deploymentId, job.deploymentId),
          inArray(deployment.status, ['pending', 'running']),
        ),
      )
      .returning();
    if (row?.description && description !== null) {
      await this.logLine(row, row.description);
    }
  }

  /**
   * The last line of a run's log. Best effort: the row is the record, and a
   * log that cannot be written must not leave it unsettled. Cloud runs log
   * on the platform host, where this process is.
   */
  private logLine(row: Deployment, line: string): Promise<void> {
    return this.appendLog(row.logPath, line);
  }

  /**
   * One line of a running Cloud run's Deployment log: what `tofu` printed,
   * or a step the run reports. Best effort, like the last line, and
   * the one writer of a Cloud run's log beside it.
   */
  async appendLog(logPath: string, line: string): Promise<void> {
    try {
      await appendFile(logPath, `${line}\n`);
    } catch {
      // See above.
    }
  }
}
