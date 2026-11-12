import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, lte } from 'drizzle-orm';
import { application } from '../applications/application.schema';
import { runTeardownSteps } from '../common/teardown-steps';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { buildHostServerId } from '../deployment-engine/build-host';
import { deployment } from '../deployments/deployment.schema';
import { DeploymentsService } from '../deployments/deployments.service';
import { auditLog } from '../enterprise/audit-logs/audit-log.schema';
import { AuditLogService } from '../enterprise/audit-logs/audit-log.service';
import { environment } from '../environments/environment.schema';
import { project } from '../projects/project.schema';
import { RemoteExecService } from '../remote/remote-exec.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { previewDeployment } from './preview-deployment.schema';
import type { PreviewExpiryCause } from './preview-deployment.schema';
import {
  expiredBuildDescription,
  planExpiry,
  tearDownPerServer,
} from './preview-expiry';
import {
  previewServicePresence,
  previewTeardownSteps,
} from './preview-teardown';
import { requesterIdOf } from './requester';
import {
  PREVIEW_TEARDOWN_STUCK_NOTIFIER,
  TeardownStuckEpisodes,
} from './teardown-stuck-episodes';
import type {
  PendingTeardown,
  PreviewTeardownStuckNotifier,
} from './teardown-stuck-episodes';

/**
 * When the sweep runs: **every minute**, so a Requested
 * preview goes within about a minute of its expiry plus its teardown.
 */
export const PREVIEW_EXPIRY_CRON = '* * * * *';

const EXPIRY_JOB_NAME = 'requested-preview-expiry';

/** A Requested preview with what its teardown and its audit row need. */
interface ExpiringPreview {
  previewDeploymentId: string;
  appName: string;
  branch: string;
  applicationId: string;
  /** The parent's display name, which a stuck-teardown Notification names. */
  applicationName: string;
  requesterId: string | null;
  expiresAt: string;
  expiredAt: string | null;
  expiryCause: PreviewExpiryCause | null;
  serverId: string | null;
  buildServerId: string | null;
  /** Set when the parent runs in a Cloud account: then nothing is torn down on any machine. */
  cloudAccountId: string | null;
  organizationId: string;
}

/** Where one expired preview's pass left it. */
export type ExpiryOutcome =
  /** A build past its cancel window is still releasing; tried again next tick. */
  | 'waiting'
  /**
   * The teardown ran but the presence read did not answer `absent` (an
   * unreachable Server, a daemon that is down, a service that would not go):
   * the row stays *expired, teardown pending* and is tried again next tick.
   * A Server whose pending teardowns have been retried for fifteen minutes
   * raises the stuck-teardown Notification, once per episode.
   */
  | 'pending'
  /** The copy is gone and the row with it; the platform's row is written. */
  | 'removed';

/**
 * The sweep that makes a Requested preview go at its expiry, and by the same
 * path when someone deletes one (ADR-0026).
 *
 * **ADR-0020's shape.** One instance-wide job on `SchedulingService`, like
 * `DeploymentLogRetentionService`, which reads the rows when it fires rather
 * than arming a timer per row: a `setTimeout` per row would not survive a
 * restart, and a delayed job on the build queue would wait behind the
 * parent's builds in its queue group. The cron expression
 * is exported and {@link sweep} is public, so a test asserts the
 * registration and drives a pass directly with its own now.
 *
 * **A tick is skipped while the previous one runs** ({@link tick}): an
 * unreachable Server costs each step its SSH connect timeout, and a minute of
 * those must not stack a second pass on top of the first.
 *
 * **At expiry, in order**: mark the row expired, so extend
 * and redeploy are refused and nothing new is queued; cancel its builds, or
 * leave the row for the next tick while one past its cancel window releases;
 * tear it down through `previewTeardownSteps`, on the machine that made each
 * artifact (ADR-0018); and only when the presence read answers `absent`,
 * delete the row and write the platform's one audit row. A `DELETE` of a
 * Requested preview marks it with its own now (`PreviewDeploymentsService.remove`)
 * and this does the rest, so a kill and a timeout leave by one path.
 *
 * **Each row is handled on its own, best effort, and logged.** A row whose
 * Server is down stays expired and is retried every tick, each attempt
 * bounded by the connect timeout. **Servers at once, each Server's rows in
 * turn** (`tearDownPerServer`): taking every row in turn held every other
 * Server's teardowns behind a dead one's connect timeouts, while one Server's
 * rows in turn keeps `DeploymentLogRetentionService.sweep`'s reason for being
 * sequential, one connection at a time to one machine.
 *
 * **Nothing else is written**: no audit row when a row is marked, and
 * none per failed or retried teardown. An expiry notifies nobody. The one
 * Notification is a Server whose pending teardowns have
 * been retried for fifteen minutes ({@link TeardownStuckEpisodes}): told
 * once per episode, from memory beside this pass, and never awaited, so a
 * slow channel cannot hold the next row's teardown back.
 */
@Injectable()
export class PreviewExpiryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PreviewExpiryService.name);

  /** The pass a cron tick started and that has not finished yet. */
  private inFlight: Promise<void> | null = null;

  /**
   * Which Servers' stuck teardowns have been told. In memory on
   * purpose: the pending rows are the durable record, so a restart re-arms
   * the fifteen minutes from its first pass rather than firing.
   */
  private readonly stuckEpisodes = new TeardownStuckEpisodes();

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly remoteExec: RemoteExecService,
    private readonly scheduling: SchedulingService,
    /** The platform's cancel of a preview's builds. */
    private readonly deployments: DeploymentsService,
    private readonly auditLogs: AuditLogService,
    @Inject(PREVIEW_TEARDOWN_STUCK_NOTIFIER)
    private readonly stuckNotifier: PreviewTeardownStuckNotifier,
  ) {}

  /**
   * Arms the job at boot, tolerant of a registry that refuses, on
   * `DeploymentLogRetentionService.onApplicationBootstrap`'s reason: a boot
   * that cannot arm housekeeping must still be a boot that starts.
   */
  onApplicationBootstrap(): void {
    try {
      this.scheduling.register(EXPIRY_JOB_NAME, PREVIEW_EXPIRY_CRON, null, () =>
        this.tick(),
      );
    } catch (error) {
      this.logger.error('Requested-preview expiry could not be armed', error);
    }
  }

  /**
   * What the cron calls: one {@link sweep}, or nothing when the last one is
   * still running.
   */
  tick(): Promise<void> {
    if (this.inFlight) {
      this.logger.debug(
        'Skipping a requested-preview expiry tick: the previous one is still running',
      );
      return Promise.resolve();
    }
    const pass = this.sweep()
      .then(() => undefined)
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = pass;
    return pass;
  }

  /**
   * One pass, judged at `now`: marks every Requested preview past its expiry,
   * then tries each expired one's teardown. Answers where each expired row
   * was left, for the caller that wants to know; the cron ignores it.
   */
  async sweep(now: Date = new Date()): Promise<Map<string, ExpiryOutcome>> {
    const rows = await this.requestedPreviews();
    const plan = planExpiry(rows, now);
    const marked = await this.mark(plan.mark, now);

    const outcomes = new Map<string, ExpiryOutcome>();
    const expiredRows = rows.flatMap((row) => {
      if (!plan.tearDown.includes(row.previewDeploymentId)) return [];
      const mark = marked.get(row.previewDeploymentId);
      // Marked by this pass, or lost the mark to an extend in between.
      if (row.expiredAt === null && !mark) return [];
      return [mark ? { ...row, ...mark } : row];
    });
    // Servers at once, each Server's rows in turn: an unreachable Server's
    // connect timeouts hold back only its own rows.
    await tearDownPerServer(
      expiredRows,
      (row) => row.serverId,
      async (expired) => {
        try {
          outcomes.set(
            expired.previewDeploymentId,
            await this.tearDownExpired(expired),
          );
        } catch (error) {
          // Journalled, never thrown: one preview's failure must not stop the
          // rows after it, and the row is still expired, so the next tick
          // tries again.
          outcomes.set(expired.previewDeploymentId, 'pending');
          this.logger.warn(
            `Expired preview ${expired.appName} could not be torn down this pass, and is tried again next minute: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      },
    );
    this.tellStuckServers(rows, outcomes, now);
    return outcomes;
  }

  /**
   * Hands this pass's pending teardowns to the episode tracker, and tells each
   * Server whose episode opened. The notifier is not awaited — the
   * pass, and the tick guard waiting on it, never wait on a sender — and it
   * swallows its own failures; the catch here is for a notifier that does not.
   */
  private tellStuckServers(
    rows: readonly ExpiringPreview[],
    outcomes: ReadonlyMap<string, ExpiryOutcome>,
    now: Date,
  ): void {
    const pending: PendingTeardown[] = rows
      .filter((row) => outcomes.get(row.previewDeploymentId) === 'pending')
      .map((row) => ({
        previewDeploymentId: row.previewDeploymentId,
        serverId: row.serverId,
        organizationId: row.organizationId,
        applicationId: row.applicationId,
        applicationName: row.applicationName,
      }));
    for (const stuck of this.stuckEpisodes.observe(pending, now)) {
      this.logger.warn(
        `Requested-preview teardown has been stuck on ${
          stuck.serverId ?? 'the platform host'
        } since ${stuck.stuckSince.toISOString()} (${stuck.previews.length} pending); telling its Organization`,
      );
      void this.stuckNotifier
        .previewTeardownStuck(stuck)
        .catch((error: unknown) =>
          this.logger.error(
            'The stuck-teardown Notification could not be sent',
            error instanceof Error ? error.stack : String(error),
          ),
        );
    }
  }

  /**
   * Every Requested preview, with its parent's two Servers and its
   * Organization. The expiry is judged by {@link planExpiry}, not here, so
   * the predicate is written once; the rows are bounded by each
   * Application's requested-preview cap.
   */
  private requestedPreviews(): Promise<ExpiringPreview[]> {
    return this.db
      .select({
        previewDeploymentId: previewDeployment.previewDeploymentId,
        appName: previewDeployment.appName,
        branch: previewDeployment.branch,
        applicationId: previewDeployment.applicationId,
        applicationName: application.name,
        requesterId: previewDeployment.requesterId,
        // A requested row always has one (`preview_deployment_fields_match_trigger`).
        expiresAt: previewDeployment.expiresAt,
        expiredAt: previewDeployment.expiredAt,
        expiryCause: previewDeployment.expiryCause,
        serverId: application.serverId,
        buildServerId: application.buildServerId,
        cloudAccountId: application.cloudAccountId,
        organizationId: project.organizationId,
      })
      .from(previewDeployment)
      .innerJoin(
        application,
        eq(previewDeployment.applicationId, application.applicationId),
      )
      .innerJoin(
        environment,
        eq(application.environmentId, environment.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(eq(previewDeployment.trigger, 'requested'))
      .orderBy(asc(previewDeployment.createdAt)) as Promise<ExpiringPreview[]>;
  }

  /**
   * Marks `ids` expired at `now`, with cause `expiry`. The write repeats the
   * predicate as its guard, because an extend can land between the read and
   * this: a row an extend has just moved past `now` is not marked, and
   * answers nothing here. Writes no audit row.
   */
  private async mark(
    ids: string[],
    now: Date,
  ): Promise<Map<string, Pick<ExpiringPreview, 'expiredAt' | 'expiryCause'>>> {
    if (ids.length === 0) return new Map();
    const at = now.toISOString();
    const rows = await this.db
      .update(previewDeployment)
      .set({ expiredAt: at, expiryCause: 'expiry' })
      .where(
        and(
          inArray(previewDeployment.previewDeploymentId, ids),
          isNull(previewDeployment.expiredAt),
          lte(previewDeployment.expiresAt, at),
        ),
      )
      .returning({
        previewDeploymentId: previewDeployment.previewDeploymentId,
        appName: previewDeployment.appName,
        expiredAt: previewDeployment.expiredAt,
        expiryCause: previewDeployment.expiryCause,
      });
    for (const row of rows) {
      this.logger.log(`Requested preview ${row.appName} expired at ${at}`);
    }
    return new Map(rows.map((row) => [row.previewDeploymentId, row]));
  }

  /**
   * One expired preview's attempt: its builds, its artifacts, and — only once
   * the copy is gone — its row and the platform's audit row.
   */
  private async tearDownExpired(row: ExpiringPreview): Promise<ExpiryOutcome> {
    // Set by the mark; a marked row always has both (the expired check).
    const cause = row.expiryCause as PreviewExpiryCause;
    const description = expiredBuildDescription(row.branch, cause);

    // Every tick, not only the first: a redeploy that passed its gate just
    // before the mark is cancelled on the next pass.
    const { building } = await this.deployments.cancelPreviewBuilds(
      row.previewDeploymentId,
      { description },
    );
    if (building) {
      this.logger.log(
        `Expired preview ${row.appName} has a build past its cancel window; it is torn down on the first pass after that build ends`,
      );
      return 'waiting';
    }

    const target = {
      appName: row.appName,
      serverId: row.serverId,
      buildHostId: buildHostServerId(row),
      cloudAccountId: row.cloudAccountId,
    };
    await runTeardownSteps(previewTeardownSteps(this.remoteExec, target));
    const presence = await previewServicePresence(this.remoteExec, target);
    if (presence !== 'absent') {
      // Counted toward the Server's stuck-teardown episode by the pass
      // (`tellStuckServers`), not told from here: one Server is one
      // Notification, however many previews it holds.
      this.logger.warn(
        `Expired preview ${row.appName} is not confirmed gone from ${
          row.serverId ?? 'the platform host'
        } (presence ${presence}); it stays expired, teardown pending, and is tried again next minute`,
      );
      return 'pending';
    }

    // Read before the delete: `deployment.preview_deployment_id` is
    // `set null`, so afterwards these builds no longer name the preview.
    const cancelled = await this.db
      .select({ deploymentId: deployment.deploymentId })
      .from(deployment)
      .where(
        and(
          eq(deployment.previewDeploymentId, row.previewDeploymentId),
          eq(deployment.status, 'cancelled'),
          eq(deployment.description, description),
        ),
      )
      .orderBy(asc(deployment.createdAt));
    const requester = await this.requesterOf(row);

    const [deleted] = await this.db
      .delete(previewDeployment)
      .where(eq(previewDeployment.previewDeploymentId, row.previewDeploymentId))
      .returning({
        previewDeploymentId: previewDeployment.previewDeploymentId,
      });
    // Someone else removed it in between (the parent's own delete): theirs
    // is the row that says so.
    if (!deleted) return 'removed';

    await this.auditLogs.recordAsPlatform(row.organizationId, {
      action: 'delete',
      resourceType: 'previewDeployment',
      resourceId: row.previewDeploymentId,
      resourceName: row.appName,
      metadata: {
        cause,
        requesterId: requester.id,
        requesterName: requester.name,
        applicationId: row.applicationId,
        branch: row.branch,
        expiredAt: row.expiredAt,
        cancelledDeploymentIds: cancelled.map((build) => build.deploymentId),
      },
    });
    this.logger.log(
      `Requested preview ${row.appName} is gone: its copy was torn down after it expired (${cause})`,
    );
    return 'removed';
  }

  /**
   * Who asked for the preview, as its create row recorded them: the
   * row keeps the name after the requester is deleted, and the column is
   * `set null` by then.
   */
  private async requesterOf(
    row: ExpiringPreview,
  ): Promise<{ id: string | null; name: string | null }> {
    const [created] = await this.db
      .select({
        userId: auditLog.userId,
        userName: auditLog.userName,
        metadata: auditLog.metadata,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'create'),
          eq(auditLog.resourceType, 'previewDeployment'),
          eq(auditLog.resourceId, row.previewDeploymentId),
        ),
      )
      .orderBy(asc(auditLog.createdAt))
      .limit(1);
    return {
      id: requesterIdOf(created ?? null, row.requesterId),
      name: created?.userName ?? null,
    };
  }
}
