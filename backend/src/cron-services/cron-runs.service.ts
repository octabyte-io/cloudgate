import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { quote } from 'shell-quote';

import { ApplicationsService } from '../applications/applications.service';
import { application } from '../applications/application.schema';
import { user } from '../auth/auth.schema';
import { BackupRunRecorderService } from '../backups/run-recorder.service';
import { cloudAccount } from '../cloud-accounts/cloud-account.schema';
import type { CloudKind } from '../cloud-accounts/cloud-account.schema';
import { byCloud, cloudOrLegacy } from '../cloud-accounts/cloud-provider';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { releasedImageName } from '../deployment-engine/mechanize';
import type { DeployableApplication } from '../deployment-engine/deployment-engine.types';
import { deployment } from '../deployments/deployment.schema';
import type { Deployment } from '../deployments/deployment.schema';
import { environment } from '../environments/environment.schema';
import { wiredEnv } from '../project-config/outputs';
import { project } from '../projects/project.schema';
import type { PermissionCtx } from '../rbac/permission.service';
import { PermissionService } from '../rbac/permission.service';
import { execOnServer } from '../remote/exec-dispatch';
import { RemoteExecService } from '../remote/remote-exec.service';
import { refuseWhileInMaintenance } from '../servers/server-maintenance';
import { formatTimeout } from './cron-fields';
import { starterWords } from './cron-run.types';
import type { CronRunMark, CronRunStarter } from './cron-run.types';
import type {
  CronRunEnding,
  CronRunJob,
  CronRunLogSettle,
  CronRunPlace,
} from './cron-run-place.port';
import type { CronRunStopper, CronRunsEnding } from './cron-run-stopper.port';
import { lastSuccessfulBuild } from './cron-service-read';
import type { LastBuild } from './cron-service-read';
import {
  CRON_RUN_SETTLE_TIMER,
  CRON_SERVICE_CLOCK,
} from './cron-service.clock';
import type {
  CronRunSettleTimer,
  CronServiceClock,
} from './cron-service.clock';
import { EcsCronRunPlace } from './ecs-cron-run-place';
import { GoogleCronRunPlace } from './google-cron-run-place';
import { SwarmCronRunPlace } from './swarm-cron-run-place';
import { describeError } from '../common/describe-error';

/** How long the watch waits between two looks at a run's job, in ms. */
export const CRON_RUN_POLL_MS = Symbol('CRON_RUN_POLL_MS');
export const DEFAULT_POLL_MS = 5_000;

/**
 * The refusal of a run while a Cron service has no successful build: there
 * is no image to start a container from.
 */
export const WAITING_FOR_FIRST_BUILD_CODE = 'CRON_WAITING_FOR_FIRST_BUILD';

/**
 * How much of a run's output is kept in its Deployment log: the last 1 MiB,
 * which is far more than a page of a log reader and still one bounded write.
 */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * One write's worth of output. The append travels as base64 inside one shell
 * word, and Linux caps a single argument at 128 KiB.
 */
const APPEND_CHUNK_BYTES = 48 * 1024;

/**
 * How one copy of a run's output went: something new copied,
 * nothing new, or the read failed, with why.
 */
type Copied = 'new' | 'none' | { failed: string };

/** A Run record still `running`, with what stopping or watching it needs. */
interface RunningRun {
  deploymentId: string;
  applicationId: string | null;
  logPath: string;
  startedAt: string | null;
  cronRun: CronRunMark;
  serverId: string | null;
  timeoutSeconds: number | null;
  /** Its Cron service's Cloud account, region and Environment. */
  cloudAccountId: string | null;
  /** That Cloud account's cloud, which picks the run's place. */
  cloud: CloudKind | null;
  region: string | null;
  environmentId: string;
}

/**
 * How ending a run went: its job removed and its record
 * settled; its job not confirmed gone, so it is still `running`; or it had
 * already ended another way, so nothing was done.
 */
type EndOutcome = 'ended' | 'left' | 'already-ended';

/** How a run is ended by Cloudgate rather than by its command. */
interface Ending {
  status: 'error' | 'cancelled';
  /** Its log's last line. */
  line: string;
  /** Ended by its Cron service's Stop, so its record says stopped. */
  stopped?: true;
}

/**
 * The run path of a Cron service (ADR-0034): Run now, and later its
 * timetable, start a run here.
 *
 * **A run is a job in its Cron service's place** ({@link CronRunPlace}):
 * on a Server, a one-off Swarm job ({@link SwarmCronRunPlace}), from
 * the image of its last successful build; on AWS a one-off ECS task
 * ({@link EcsCronRunPlace}); on Google Cloud an execution of its
 * Cloud Run job ({@link GoogleCronRunPlace}). Its start, watch, output, removal
 * and recovery go through that place; everything else here is the same
 * wherever it runs. It is recorded as a **Run record** — a
 * `deployment` row on the Cron service's `application` arm, marked as a run —
 * by the run recorder, with its own Deployment log on the Server that ran
 * it: the first line names the image and who started it, then the
 * container's output, and the last line its exit code. Exit code 0 is `done`
 * (succeeded), anything else `error` (failed). The job is removed when it
 * ends; a finished run leaves no container.
 *
 * Starting answers once the job is created; the run is watched in the
 * background ({@link whenSettled}).
 *
 * **The first settle wins**: the watch, a timeout and a restart's
 * recovery each claim the record with `recorder.settle`, which writes only
 * while it is still `running`, and only the one that claimed it writes the
 * log's last line. The watch also stops as soon as it finds its record
 * settled another way, or another way of ending it under way.
 *
 * **A run is recorded as ended only once its job is gone.** A timeout, a
 * Cancel, a Stop or a Delete removes the job first and settles the record
 * after: a Server that cannot be reached, or a removal that fails, leaves
 * the run `running`, so it is never recorded as over while its container
 * goes on untracked. The next tick tries again ({@link holdRuns}).
 *
 * **No run goes on for ever**: {@link holdRuns}, on every tick, stops
 * every run past its Cron service's `timeout`, counted from the Run record's
 * start on {@link CRON_SERVICE_CLOCK}, ends again each run a Stop could not
 * end, and picks up every run this process is not watching — after a
 * restart, or after its Server could not be reached.
 */
@Injectable()
export class CronRunsService implements CronRunStopper {
  private readonly logger = new Logger(CronRunsService.name);
  /** Each run being watched, by its deployment id. */
  private readonly watching = new Map<string, Promise<void>>();
  /**
   * Each run whose record is written and whose job is still being started
   * not watched yet, and with nothing kept on its record to find its
   * job by, so a tick that came now would take it for one whose job is gone.
   */
  private readonly starting = new Set<string>();
  /** Ends the wait between two looks of a run's watch, by deployment id. */
  private readonly wakers = new Map<string, () => void>();
  /** Each run being ended by Cloudgate, by its deployment id. */
  private readonly ending = new Map<string, Promise<EndOutcome>>();
  /**
   * Each run a Stop could not end yet (its job not confirmed gone), with how
   * to end it, tried again on every tick by {@link holdRuns}. Kept in memory:
   * after a restart such a run is still held to its `timeout`.
   */
  private readonly stopsLeft = new Map<string, Ending>();
  /** Each run whose output so far is in its log already. */
  private readonly outputLogged = new Set<string>();

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly applications: ApplicationsService,
    private readonly recorder: BackupRunRecorderService,
    private readonly swarm: SwarmCronRunPlace,
    private readonly ecs: EcsCronRunPlace,
    private readonly google: GoogleCronRunPlace,
    private readonly remoteExec: RemoteExecService,
    @Inject(CRON_SERVICE_CLOCK) private readonly clock: CronServiceClock,
    @Inject(CRON_RUN_SETTLE_TIMER)
    private readonly settleTimer: CronRunSettleTimer,
    @Optional()
    @Inject(CRON_RUN_POLL_MS)
    private readonly pollMs: number = DEFAULT_POLL_MS,
  ) {}

  /**
   * **Run now**: a run started by hand by the caller, gated like Deploy
   * (`deployment: ['create']`, ADR-0034) on a Service the caller can read.
   * Answers the Run record. Refused on a Server in maintenance, before any
   * record or SSH (spec #1420); the timetable's runs go through
   * {@link start} and carry on.
   */
  async runNow(ctx: PermissionCtx, applicationId: string): Promise<Deployment> {
    await this.permissions.checkPermission(ctx, { deployment: ['create'] });
    await this.permissions.checkServiceAccess(ctx, applicationId, 'read');
    const [found] = await this.db
      .select({
        configKind: application.configKind,
        serverId: application.serverId,
      })
      .from(application)
      .innerJoin(
        environment,
        eq(application.environmentId, environment.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(
        and(
          eq(application.applicationId, applicationId),
          eq(project.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException('Application not found');
    if (found.configKind !== 'cron') {
      throw new ConflictException(
        'Only a Cron service has runs; this Service is deployed instead',
      );
    }
    await refuseWhileInMaintenance(this.db, [found.serverId]);
    return this.start(applicationId, {
      kind: 'member',
      userId: ctx.user.id,
      name: await this.memberName(ctx.user.id),
    });
  }

  /**
   * **Cancel one run**: the caller is `DeploymentsService.cancel`,
   * which has gated on `deployment: ['cancel']` and found the Run record in
   * the caller's Organization. The job is removed, then the record settled
   * `cancelled` saying who, and the timetable left as it is. False when the
   * run had already ended. Refused, the run still `running`, when its job
   * could not be confirmed gone.
   */
  async cancelRun(deploymentId: string, userId: string): Promise<boolean> {
    const run = (await this.runningRuns()).find(
      (each) => each.deploymentId === deploymentId,
    );
    if (!run) return false;
    const name = await this.memberName(userId);
    const outcome = await this.end(run, {
      status: 'cancelled',
      line: `⏹️ [Run] Cancelled by ${name}`,
    });
    if (outcome === 'left') {
      throw new ConflictException(
        `Cloudgate could not confirm the run's job ${run.cronRun.job} is gone, so the run goes on — cancel again when its Server is reachable`,
      );
    }
    return outcome === 'ended';
  }

  /**
   * Ends every run of one Cron service in flight, for its Stop (the
   * pause) or its Delete, each settled `cancelled` with a last line saying
   * so; a Stop's are marked stopped. Answers the jobs whose removal could
   * not be confirmed, whose runs are still `running`: a Stop's are ended
   * again on every tick until they are gone, and a refused Delete's go on.
   */
  async stopRunsOf(
    applicationId: string,
    why: CronRunsEnding,
  ): Promise<string[]> {
    const runs = (await this.runningRuns()).filter(
      (run) => run.applicationId === applicationId,
    );
    if (runs.length === 0) return [];
    const name = await this.memberName(why.userId);
    const ending: Ending =
      why.kind === 'stopped'
        ? {
            status: 'cancelled',
            line: `⏹️ [Run] Stopped: ${name} stopped the Cron service`,
            stopped: true,
          }
        : {
            status: 'cancelled',
            line: `⏹️ [Run] Stopped: ${name} deleted the Cron service`,
          };
    const left: string[] = [];
    for (const run of runs) {
      if ((await this.end(run, ending)) !== 'left') continue;
      left.push(run.cronRun.job);
      if (ending.stopped) this.stopsLeft.set(run.deploymentId, ending);
    }
    return left;
  }

  /**
   * What every tick does for the runs in flight, at `now`:
   * ends again each run a Stop could not end, stops every run past its
   * `timeout` ({@link stopOverdue}), and picks up every run this process is
   * not watching ({@link recover}), so one whose Server could not be reached
   * is watched again once it can be. A run whose Server is still out of
   * reach stays `running`, and the next tick tries again.
   */
  async holdRuns(now: number): Promise<void> {
    const running = await this.runningRuns();
    for (const [deploymentId, ending] of this.stopsLeft) {
      const run = running.find((each) => each.deploymentId === deploymentId);
      if (run && (await this.end(run, ending)) === 'left') continue;
      this.stopsLeft.delete(deploymentId);
    }
    await this.stopOverdue(now);
    await this.recover('unreachable');
  }

  /**
   * Starts one run of a Cron service and answers its Run record, once its
   * job is created. Refused with "waiting for first build" before anything
   * is written when no build has succeeded.
   */
  async start(
    applicationId: string,
    startedBy: CronRunStarter,
  ): Promise<Deployment> {
    const built = await this.lastBuildOrRefuse(applicationId);
    const app = await this.applications.findDeployable(applicationId);
    // The image its last successful build pinned, resolved now, so the run
    // keeps it whatever is built while it runs. A build from before builds
    // pinned one runs the Service's image name.
    const image = built.cronImage ?? releasedImageName(app);
    const place = this.placeOf({ cloud: await this.cloudOf(app) });
    const job = place.jobName(app.appName);
    const cronRun: CronRunMark = { job, image, startedBy };
    const who = starterWords(startedBy);

    const record = await this.recorder.start({
      appName: app.appName,
      // The run Server: the log is where the run is (ADR-0034).
      serverId: app.serverId,
      title: startedBy.kind === 'member' ? 'Run now' : 'Timetable run',
      description: `Run of ${app.name}, started by ${who}`,
      initMessage: `▶️ [Run] Starting '${image}' as ${place.describeJob(job)}, started by ${who}`,
      parent: { kind: 'application', applicationId },
      cronRun,
      // Its `timeout` counts from here, on the clock the timetable reads.
      startedAt: new Date(this.clock.now()),
    });
    const log = (text: string) =>
      this.appendToLog(app.serverId, record.logPath, text);
    this.starting.add(record.deploymentId);
    try {
      return await this.startJob(app, place, cronRun, built, record, log);
    } finally {
      this.starting.delete(record.deploymentId);
    }
  }

  /** {@link start} once its record is written: the job, then its watch. */
  private async startJob(
    app: DeployableApplication,
    place: CronRunPlace,
    cronRun: CronRunMark,
    built: LastBuild,
    record: { deploymentId: string },
    log: (text: string) => Promise<void>,
  ): Promise<Deployment> {
    const { job, image } = cronRun;
    let started: CronRunJob;
    try {
      started = await place.start(app, {
        job,
        image,
        // Its wired variables, built now from their sources, as a
        // deploy builds them; a source gone since fails the run here.
        wiredEnv: () => wiredEnv(this.db, app.environmentId, app.configLinks),
        // In a Cloud account, the revision its last successful build
        // registered: a run in flight keeps the one it started on.
        task: built.cronTask,
      });
    } catch (error) {
      // Nothing was started, so there is nothing to watch or remove.
      await log(
        `❌ [Run] The job could not be created: ${describeError(error)}`,
      ).catch(() => undefined);
      await this.recorder.settle(record.deploymentId, 'error');
      return this.recordOf(record.deploymentId);
    }
    // The record was written before the job existed: what finds the job
    // again (an ECS task's ARN) is kept on it now.
    await this.keep(record.deploymentId, cronRun, started);

    this.keepWatching(started, place, cronRun, record.deploymentId, log);
    return this.recordOf(record.deploymentId);
  }

  /**
   * What of a run's job its place asks to keep on the Run record,
   * merged into its mark when it changed. Never throws: a run whose mark is
   * not written is still watched, and is read again from the start.
   */
  private async keep(
    deploymentId: string,
    cronRun: CronRunMark,
    started: CronRunJob,
  ): Promise<void> {
    const kept = started.kept?.() ?? {};
    const changed = Object.entries(kept).some(
      ([key, value]) => cronRun[key as keyof CronRunMark] !== value,
    );
    if (!changed) return;
    Object.assign(cronRun, kept);
    await this.db
      .update(deployment)
      .set({
        cronRun: sql`coalesce(${deployment.cronRun}, '{}'::jsonb) || ${JSON.stringify(kept)}::jsonb`,
      })
      .where(eq(deployment.deploymentId, deploymentId))
      .catch((error: unknown) =>
        this.logger.warn(
          `Run ${deploymentId}'s job could not be kept on its record: ${describeError(error)}`,
        ),
      );
  }

  /**
   * Stops every run past its Cron service's `timeout` at `now`, counted from
   * its Run record's start, whatever started it: the record is marked failed
   * and its log ends "timed out after <timeout>", after the output it made.
   * Answers the Run records it stopped.
   */
  async stopOverdue(now: number): Promise<string[]> {
    const overdue = (await this.runningRuns()).filter(
      (run) =>
        run.timeoutSeconds !== null &&
        run.startedAt !== null &&
        Date.parse(run.startedAt) + run.timeoutSeconds * 1000 <= now,
    );
    const stopped = await Promise.all(
      overdue.map(async (run) => {
        try {
          return (await this.stopTimedOut(run)) ? [run.deploymentId] : [];
        } catch (error) {
          this.logger.error(
            `Run ${run.deploymentId} could not be stopped at its timeout: ${describeError(error)}`,
          );
          return [];
        }
      }),
    );
    return stopped.flat();
  }

  /**
   * Picks up every Run record still `running` that this process is not
   * watching or ending: after a restart, or once the Server of a run whose
   * watch lost sight of it can be reached again. A run whose job is still on
   * its Server is watched again; its time limit needs no re-arming, since
   * {@link stopOverdue} counts it from the record's start. A run whose job
   * is gone is recorded from its last task's exit status, or as lost when
   * there is none.
   */
  async recover(why: 'restart' | 'unreachable' = 'restart'): Promise<void> {
    const orphans = (await this.runningRuns()).filter(
      (run) =>
        !this.watching.has(run.deploymentId) &&
        !this.starting.has(run.deploymentId) &&
        !this.ending.has(run.deploymentId) &&
        !this.stopsLeft.has(run.deploymentId),
    );
    await Promise.all(
      orphans.map((run) =>
        this.recoverOne(run, why).catch((error: unknown) =>
          this.logger.warn(
            `Run ${run.deploymentId} could not be picked up again: ${describeError(error)}`,
          ),
        ),
      ),
    );
  }

  /**
   * Resolves once the run is settled and its job removed, or at once when it
   * is not being watched by this process.
   */
  whenSettled(deploymentId: string): Promise<void> {
    return this.watching.get(deploymentId) ?? Promise.resolve();
  }

  /**
   * A Cron service's last successful build, or the refusal of a run while
   * none has succeeded.
   */
  private async lastBuildOrRefuse(applicationId: string): Promise<LastBuild> {
    const built = await lastSuccessfulBuild(this.db, applicationId);
    if (!built) {
      throw new ConflictException({
        message:
          'This Cron service is waiting for first build: a run starts from the image of the last build that succeeded, and none has yet',
        code: WAITING_FOR_FIRST_BUILD_CODE,
      });
    }
    return built;
  }

  /** Watches a run in the background, for {@link whenSettled}. */
  private keepWatching(
    started: CronRunJob,
    place: CronRunPlace,
    cronRun: CronRunMark,
    deploymentId: string,
    log: (text: string) => Promise<void>,
  ): void {
    const { job } = cronRun;
    const watch = this.watch(started, place, cronRun, deploymentId, log)
      .catch((error: unknown) =>
        this.logger.error(
          `Run ${deploymentId} (${job}) was not settled: ${describeError(error)}`,
        ),
      )
      .finally(() => {
        this.watching.delete(deploymentId);
        this.wakers.delete(deploymentId);
      });
    this.watching.set(deploymentId, watch);
  }

  /**
   * Waits for the job's task to end, then settles the record by its exit
   * code and, when that settle was the first, writes the container's output
   * and its exit code into the log and removes the job. Stops with nothing
   * written once the record is settled, or being ended, another way (a
   * timeout, a cancel), or when its Server cannot be reached.
   *
   * **A place whose log store shows a line late has its log read on until
   * it settles** ({@link settleOutput}), after the record is settled
   * and before the exit code line, so the tail of its output still lands
   * above that line. The record comes first, as for every place: a Cancel or
   * a timeout in the seconds the reads take finds the run ended and leaves
   * how it ended alone. A place with none has its output read once.
   */
  private async watch(
    started: CronRunJob,
    place: CronRunPlace,
    cronRun: CronRunMark,
    deploymentId: string,
    log: (text: string) => Promise<void>,
  ): Promise<void> {
    let ending: CronRunEnding | null;
    try {
      ending = await this.awaitEnd(started, place, cronRun, deploymentId, log);
    } catch (error) {
      // Its place out of reach is not its job ended: the run stays
      // `running`, and a later tick watches it again.
      this.logger.warn(
        `Lost sight of run ${deploymentId} (${cronRun.job}); it is picked up again once ${place.words.lostSightOf} answers: ${describeError(error)}`,
      );
      return;
    }
    if (ending === null || this.ending.has(deploymentId)) return;

    // The record says how the run ended whatever its log then manages.
    const won = await this.recorder.settle(
      deploymentId,
      ending.exitCode === 0 ? 'done' : 'error',
    );
    if (!won) return;
    try {
      if (!place.logSettle) await this.logOutput(started, log);
      else {
        const unread = await this.settleOutput(
          started,
          place.logSettle,
          cronRun,
          deploymentId,
          log,
        );
        if (unread !== null) {
          await log(`⚠️ [Run] Its output could not be read: ${unread}`);
        }
      }
      if (ending.exitCode !== null) {
        await log(`exit code ${ending.exitCode}`);
      } else {
        await log(`exit code unknown: the job ended ${ending.state}`);
        // Last, so the log ends on why: on ECS the reason it never ran.
        if (ending.err !== null) await log(`❌ [Run] ${ending.err}`);
      }
    } finally {
      await started.remove();
    }
  }

  /**
   * The job's task once it has ended, or `null` once the record is no longer
   * `running`: someone else settled it, and it is theirs to finish. A place
   * that copies its job's output while it runs has what is new
   * copied into the log at each look.
   */
  private async awaitEnd(
    started: CronRunJob,
    place: CronRunPlace,
    cronRun: CronRunMark,
    deploymentId: string,
    log: (text: string) => Promise<void>,
  ): Promise<CronRunEnding | null> {
    for (;;) {
      if (this.ending.has(deploymentId)) return null;
      if (!(await this.isRunning(deploymentId))) return null;
      const ended = await started.ending();
      if (ended) return ended;
      if (place.copiesWhileRunning) {
        await this.copyOutput(started, cronRun, deploymentId, log);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.pollMs);
        this.wakers.set(deploymentId, () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /**
   * A run's settle read: from its job's end, its output is copied
   * into the log now and every `settle.everyMs`, until a read made at least
   * `settle.quietAfterMs` after the end finds nothing new, and no read is
   * made later than `settle.capMs` after it. A run that wrote nothing is
   * done at the first read past the quiet mark, not at the cap; a read that
   * fails is never quiet. Answers why the last read failed, if it did, else
   * `null`. Its record is settled already, so nothing else ends the run
   * while it reads, and nothing cuts the reads short but the cap.
   *
   * The end is when the watch saw it, on {@link CRON_RUN_SETTLE_TIMER}: no
   * earlier than the job's own, so the window is never shorter than its
   * figures, and longer by at most one look's interval.
   */
  private async settleOutput(
    started: CronRunJob,
    settle: CronRunLogSettle,
    cronRun: CronRunMark,
    deploymentId: string,
    log: (text: string) => Promise<void>,
  ): Promise<string | null> {
    const endedAt = this.settleTimer.now();
    for (;;) {
      const readAt = this.settleTimer.now() - endedAt;
      const copied = await this.copyOutput(started, cronRun, deploymentId, log);
      if (copied === 'none' && readAt >= settle.quietAfterMs) return null;
      const left = settle.capMs - (this.settleTimer.now() - endedAt);
      if (left <= 0) return typeof copied === 'object' ? copied.failed : null;
      await this.settleTimer.wait(Math.min(settle.everyMs, left));
    }
  }

  private async isRunning(deploymentId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ status: deployment.status })
      .from(deployment)
      .where(eq(deployment.deploymentId, deploymentId));
    return row?.status === 'running';
  }

  /**
   * What the job printed since the last look, into the log while it runs
   * and while its end settles, and where the copy reached
   * onto its Run record. A read that fails is tried again at the next look.
   */
  private async copyOutput(
    started: CronRunJob,
    cronRun: CronRunMark,
    deploymentId: string,
    log: (text: string) => Promise<void>,
  ): Promise<Copied> {
    let output: string;
    try {
      output = await started.output();
    } catch (error) {
      this.logger.warn(
        `Run ${deploymentId}'s output could not be read yet: ${describeError(error)}`,
      );
      return { failed: describeError(error) };
    }
    if (output !== '') await log(trimOutput(output));
    await this.keep(deploymentId, cronRun, started);
    return output === '' ? 'none' : 'new';
  }

  /** The container's output so far into the log; read before the job goes. */
  private async logOutput(
    started: CronRunJob,
    log: (text: string) => Promise<void>,
  ): Promise<void> {
    let output: string;
    try {
      output = await started.output();
    } catch (error) {
      output = `⚠️ [Run] Its output could not be read: ${describeError(error)}`;
    }
    if (output !== '') await log(trimOutput(output));
  }

  /** Stops one run at its `timeout`, recorded failed: "timed out after …". */
  private async stopTimedOut(run: RunningRun): Promise<boolean> {
    const outcome = await this.end(run, {
      status: 'error',
      line: `timed out after ${formatTimeout(run.timeoutSeconds!)}`,
    });
    return outcome === 'ended';
  }

  /**
   * Ends one run its command did not end (a timeout, a Cancel, a Stop, a
   * Delete): its watch stops, its output so far goes into its
   * log, its job is removed, and only then is its record settled — the first
   * settle wins — and `ending.line` written last. A run whose job could not
   * be confirmed gone is `left`, still `running`. Two endings of one run at
   * once share the first.
   */
  private end(run: RunningRun, ending: Ending): Promise<EndOutcome> {
    const underWay = this.ending.get(run.deploymentId);
    if (underWay) {
      return underWay.then((outcome) =>
        outcome === 'ended' ? 'already-ended' : outcome,
      );
    }
    const ended = this.endOnce(run, ending).finally(() =>
      this.ending.delete(run.deploymentId),
    );
    this.ending.set(run.deploymentId, ended);
    return ended;
  }

  private async endOnce(run: RunningRun, ending: Ending): Promise<EndOutcome> {
    const { deploymentId } = run;
    // Its watch, if this process has one, stops now rather than at its next
    // look: the job is this ending's to remove.
    this.wakers.get(deploymentId)?.();
    await this.whenSettled(deploymentId);
    const log = (text: string) =>
      this.appendToLog(run.serverId, run.logPath, text);
    const place = this.placeOf(run);
    // Read again now its watch has stopped: how far that watch copied the
    // job's output is on the record, not on what was read before.
    const cronRun = (await this.markOf(deploymentId)) ?? run.cronRun;
    let started: CronRunJob;
    try {
      started = await place.reach({ ...run, cronRun });
    } catch (error) {
      this.logger.warn(
        `${place.describeJob(run.cronRun.job)} could not be reached to remove it: ${describeError(error)}`,
      );
      return 'left';
    }
    if (!this.outputLogged.has(deploymentId)) {
      // Read before the job goes, and once however many tries removing it
      // takes.
      await this.logOutput(started, log)
        .then(() => this.outputLogged.add(deploymentId))
        .catch(() => undefined);
    }
    if (!(await started.remove())) return 'left';
    this.outputLogged.delete(deploymentId);
    if (!(await this.recorder.settle(deploymentId, ending.status))) {
      return 'already-ended';
    }
    if (ending.stopped) {
      await this.db
        .update(deployment)
        .set({ cronRun: { ...cronRun, ...started.kept?.(), stopped: true } })
        .where(eq(deployment.deploymentId, deploymentId));
    }
    await log(ending.line).catch(() => undefined);
    return 'ended';
  }

  /** How a member reads in a run's log: their name, else their email. */
  private async memberName(userId: string): Promise<string> {
    const [caller] = await this.db
      .select({
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
      })
      .from(user)
      .where(eq(user.id, userId));
    return (
      `${caller?.firstName ?? ''} ${caller?.lastName ?? ''}`.trim() ||
      caller?.email ||
      userId
    );
  }

  /** {@link recover} for one run. */
  private async recoverOne(
    run: RunningRun,
    why: 'restart' | 'unreachable',
  ): Promise<void> {
    const log = (text: string) =>
      this.appendToLog(run.serverId, run.logPath, text);
    const place = this.placeOf(run);
    // A place that cannot be reached now leaves the run running: the next
    // tick tries again, and its timeout still counts.
    const started = await place.reach(run);
    const found = await started.find();
    if (!found.there) {
      return this.recordGone(found.ending, run, place, started, log, why);
    }
    await log(
      why === 'restart'
        ? '↻ [Run] Cloudgate restarted; watching the run again'
        : place.words.answersAgain,
    );
    this.keepWatching(started, place, run.cronRun, run.deploymentId, log);
  }

  /**
   * A run whose job vanished while Cloudgate was down, or while its place
   * could not be reached: recorded from its job's exit status when its place
   * still knows it, else in its place's words — lost on a Server, its result
   * unknown on ECS. What it printed that is not in the log yet goes
   * in first.
   */
  private async recordGone(
    ending: CronRunEnding | null,
    run: RunningRun,
    place: CronRunPlace,
    started: CronRunJob,
    log: (text: string) => Promise<void>,
    why: 'restart' | 'unreachable',
  ): Promise<void> {
    const when =
      why === 'restart'
        ? 'Cloudgate restarted'
        : `Cloudgate lost sight of ${place.words.lostSightOf}`;
    if (ending && ending.exitCode !== null) {
      const status = ending.exitCode === 0 ? 'done' : 'error';
      if (!(await this.recorder.settle(run.deploymentId, status))) return;
      if (place.copiesWhileRunning) {
        await this.logOutput(started, log).catch(() => undefined);
      }
      await log(
        `↻ [Run] ${when} and the run's job was gone; its exit status was kept`,
      );
      await log(`exit code ${ending.exitCode}`);
      return;
    }
    if (!(await this.recorder.settle(run.deploymentId, 'error'))) return;
    if (place.copiesWhileRunning) {
      await this.logOutput(started, log).catch(() => undefined);
    }
    // Its place still knows why it ended with no exit code: on ECS, the
    // reason its task never ran.
    if (ending?.err) {
      await log(`↻ [Run] ${when} and the run's job was gone`);
      await log(`❌ [Run] ${ending.err}`);
      return;
    }
    await log(place.words.gone(when, why));
  }

  /** Every Run record still `running`, with its Cron service's settings. */
  private async runningRuns(): Promise<RunningRun[]> {
    const rows = await this.db
      .select({
        deploymentId: deployment.deploymentId,
        applicationId: deployment.applicationId,
        logPath: deployment.logPath,
        startedAt: deployment.startedAt,
        cronRun: deployment.cronRun,
        serverId: application.serverId,
        timeoutSeconds: application.cronTimeoutSeconds,
        cloudAccountId: application.cloudAccountId,
        cloud: cloudAccount.cloud,
        region: application.region,
        environmentId: application.environmentId,
      })
      .from(deployment)
      .innerJoin(
        application,
        eq(deployment.applicationId, application.applicationId),
      )
      .leftJoin(
        cloudAccount,
        eq(application.cloudAccountId, cloudAccount.cloudAccountId),
      )
      .where(
        and(isNotNull(deployment.cronRun), eq(deployment.status, 'running')),
      );
    return rows.flatMap((row) =>
      row.cronRun ? [{ ...row, cronRun: row.cronRun }] : [],
    );
  }

  /**
   * Where a run of a Cron service happens, chosen from its Cloud account's
   * cloud (ADR-0043): on AWS a one-off ECS task, on Google
   * Cloud an execution of its Cloud Run job; with no Cloud
   * account, on its Server, a one-off Swarm job.
   */
  private placeOf(row: { cloud: CloudKind | null }): CronRunPlace {
    if (row.cloud === null) return this.swarm;
    return byCloud<CronRunPlace>(row.cloud, {
      aws: this.ecs,
      gcp: this.google,
    });
  }

  /** The cloud of a Cron service's Cloud account, or `null` on a Server. */
  private async cloudOf(app: {
    cloudAccountId: string | null;
  }): Promise<CloudKind | null> {
    if (!app.cloudAccountId) return null;
    const [found] = await this.db
      .select({ cloud: cloudAccount.cloud })
      .from(cloudAccount)
      .where(eq(cloudAccount.cloudAccountId, app.cloudAccountId));
    // A Cloud account gone is read by the one legacy rule (ADR-0043).
    return cloudOrLegacy(found?.cloud);
  }

  /** A Run record's mark as it is now. */
  private async markOf(deploymentId: string): Promise<CronRunMark | null> {
    const [row] = await this.db
      .select({ cronRun: deployment.cronRun })
      .from(deployment)
      .where(eq(deployment.deploymentId, deploymentId));
    return row?.cronRun ?? null;
  }

  /** Text into the run's log, on the Server the log is on, in chunks. */
  private async appendToLog(
    serverId: string | null,
    logPath: string,
    text: string,
  ): Promise<void> {
    const bytes = Buffer.from(text.endsWith('\n') ? text : `${text}\n`);
    for (let at = 0; at < bytes.length; at += APPEND_CHUNK_BYTES) {
      const chunk = bytes.subarray(at, at + APPEND_CHUNK_BYTES);
      await execOnServer(
        this.remoteExec,
        serverId,
        `echo ${quote([chunk.toString('base64')])} | base64 -d >> ${quote([logPath])};`,
      );
    }
  }

  private async recordOf(deploymentId: string): Promise<Deployment> {
    const [row] = await this.db
      .select()
      .from(deployment)
      .where(eq(deployment.deploymentId, deploymentId));
    return row;
  }
}

/** The last {@link MAX_OUTPUT_BYTES} of a run's output, saying so if cut. */
function trimOutput(output: string): string {
  const bytes = Buffer.from(output);
  if (bytes.length <= MAX_OUTPUT_BYTES) return output;
  return `[Run] Earlier output omitted; the last ${MAX_OUTPUT_BYTES / 1024} KiB follow\n${bytes.subarray(bytes.length - MAX_OUTPUT_BYTES).toString('utf8')}`;
}
