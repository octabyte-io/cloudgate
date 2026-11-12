import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { and, eq, inArray, isNotNull, ne } from 'drizzle-orm';

import { application } from '../applications/application.schema';
import { FrozenOrganizations } from '../cloud/billing/frozen-organizations.service';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { deployment } from '../deployments/deployment.schema';
import type { Deployment } from '../deployments/deployment.schema';
import { CRON_SERVICE_CLOCK } from './cron-service.clock';
import type { CronServiceClock } from './cron-service.clock';
import {
  CronRunsService,
  WAITING_FOR_FIRST_BUILD_CODE,
} from './cron-runs.service';
import { isSuccessfulBuild } from './cron-service-read';
import { nextFireTimes } from '../scheduling/fire-times';

/** How often the timetable looks for fire times it has crossed. */
export const TIMETABLE_TICK_MS = 10_000;
export const TIMETABLE_TICK_JOB = 'cron-service-timetable-tick';

/**
 * The most fire times one Cron service fires in one tick. A tick that
 * comes late while Cloudgate is up — a slow Server holding the tick before
 * it, an event loop held for minutes — still fires every fire time it
 * crossed, late, since only a fire time crossed while Cloudgate was down is
 * not made up (spec US43). Past this many, a `* * * * *` Cron service
 * held up for an hour would start a burst of runs, so the rest are skipped
 * and the backend log names how many.
 */
export const MAX_FIRES_PER_TICK = 10;

/** A Cron service the timetable fires: one with a build to run. */
interface Armed {
  applicationId: string;
  schedule: string;
  timezone: string;
}

/**
 * Every live Cron service's **timetable** on a Server (ADR-0034): it
 * starts a run at each fire time through the Run now path, recorded as
 * started by the timetable. It is not `SchedulingService`, which arms one
 * timer per registered job; fire times come from {@link nextFireTimes}, the
 * daylight-saving rule `SchedulingService` shares.
 *
 * **What is armed is read from the rows on every tick**, not kept: every
 * Application of the `cron` kind that has a successful build and is not
 * Stopped, with the `schedule` and `timezone` it has now. So Apply arms a new
 * Cron service, a plan that changes its `schedule` or `timezone` re-arms it
 * on the new times, a destroy disarms it and boot arms every one, whoever
 * wrote the row — there is no arming hook to forget, and none of those
 * writers depends on this module. A Cron service still waiting for its first
 * build is not armed, so it fires nothing and leaves no failed Run record.
 *
 * **The one thing kept is how far the timetable has looked**
 * ({@link checkedUpTo}), on {@link CRON_SERVICE_CLOCK}. Each tick fires every
 * fire time in `(checkedUpTo, now]` and moves it to now, so a tick that comes
 * late fires the times it crossed late rather than dropping them (up to
 * {@link MAX_FIRES_PER_TICK}). Boot sets it to the boot's now ({@link arm}),
 * so a fire time crossed while Cloudgate was down is never in a window and
 * is not made up. Cloudgate is one process (ADR-0003), so one in-memory mark
 * is the whole timetable's.
 *
 * **Every tick also holds the runs in flight**, whether the
 * timetable or Run now started them: {@link CronRunsService.holdRuns} at the
 * tick's now, after the tick's fire times have started, so a slow Server
 * there never holds up a run. And boot, before the first tick, picks up the
 * runs a restart left `running` ({@link recover}), so a run already past its
 * limit is stopped then.
 *
 * **A Frozen Organization's Cron services are not armed**
 * (ADR-0052): read like a Stopped one's, every tick, so they fire nothing
 * while it is frozen. The mark still moves on past their fire times, so once
 * it is paid again they fire from the next fire time, and the ones missed
 * meanwhile are never run late.
 *
 * **Runs may overlap and are never retried.** A tick waits for each job to be
 * created, not for it to end, so a run still going at the next fire time does
 * not stop the next one; a run that fails is not started again.
 */
@Injectable()
export class CronTimetable implements OnApplicationBootstrap {
  private readonly logger = new Logger(CronTimetable.name);
  /** Every fire time up to here has been looked at, in ms since the epoch. */
  private checkedUpTo: number | null = null;
  /** The tick in progress: one tick at a time, so no window is fired twice. */
  private ticking: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly runs: CronRunsService,
    private readonly registry: SchedulerRegistry,
    @Inject(CRON_SERVICE_CLOCK) private readonly clock: CronServiceClock,
    private readonly frozen: FrozenOrganizations,
  ) {}

  /**
   * Arms the timetable from now and its tick, tolerant of a registry that
   * refuses: a boot that cannot arm it must still be a boot that starts.
   */
  onApplicationBootstrap(): void {
    this.arm();
    this.recover().catch((error) =>
      this.logger.error(
        'Runs left running by a restart were not picked up',
        error,
      ),
    );
    try {
      const handle = setInterval(() => {
        this.tick().catch((error) =>
          this.logger.error('Cron service timetable tick failed', error),
        );
      }, TIMETABLE_TICK_MS);
      this.registry.addInterval(TIMETABLE_TICK_JOB, handle);
    } catch (error) {
      this.logger.error('The Cron service timetable could not be armed', error);
    }
  }

  /**
   * Arms every live Cron service from the clock's now, as a boot does:
   * whatever fire time came before it is not made up.
   */
  arm(): void {
    this.checkedUpTo = this.clock.now();
  }

  /**
   * One tick at the clock's now: starts a run for every fire time an armed
   * Cron service has crossed since the last tick, and answers their Run
   * records once each run's job is created.
   */
  tick(): Promise<Deployment[]> {
    const next = this.ticking.then(() => this.tickOnce());
    this.ticking = next.catch(() => undefined);
    return next;
  }

  /**
   * Picks up the runs a restart left `running`, then holds them to their
   * `timeout` at once, in turn with the ticks: a run already past its limit,
   * counted from its original start, is stopped here.
   */
  recover(): Promise<void> {
    const next = this.ticking.then(async () => {
      await this.runs.recover();
      await this.runs.stopOverdue(this.clock.now());
    });
    this.ticking = next.catch(() => undefined);
    return next;
  }

  private async tickOnce(): Promise<Deployment[]> {
    const now = this.clock.now();
    const started = await this.fireUpTo(now);
    await this.runs
      .holdRuns(now)
      .catch((error) =>
        this.logger.error('The runs in flight were not held', error),
      );
    return started;
  }

  /** Starts a run for every fire time crossed in `(checkedUpTo, now]`. */
  private async fireUpTo(now: number): Promise<Deployment[]> {
    const from = this.checkedUpTo ?? now;
    if (now <= from) return [];
    const armed = await this.armed();
    // Moved before any run starts: a run that fails to start is not retried
    // by the next tick.
    this.checkedUpTo = now;

    const fires = armed.flatMap((service) =>
      this.fireTimesOf(service, from, now).map(() => service.applicationId),
    );
    const started = await Promise.all(fires.map((id) => this.fire(id)));
    return started.filter((record): record is Deployment => record !== null);
  }

  /**
   * The fire times of one Cron service in `(from, now]`, at most
   * {@link MAX_FIRES_PER_TICK}; the backend log names any skipped.
   */
  private fireTimesOf(service: Armed, from: number, now: number): Date[] {
    try {
      const crossed = nextFireTimes(
        service.schedule,
        service.timezone,
        new Date(from),
        MAX_FIRES_PER_TICK + 1,
      ).filter((fire) => fire.getTime() <= now);
      if (crossed.length > MAX_FIRES_PER_TICK) {
        this.logger.warn(
          `The timetable fell behind: Cron service ${service.applicationId} crossed more than ${MAX_FIRES_PER_TICK} fire times since ${new Date(from).toISOString()}, and only the first ${MAX_FIRES_PER_TICK} start a run`,
        );
      }
      return crossed.slice(0, MAX_FIRES_PER_TICK);
    } catch (error) {
      this.logger.error(
        `Cron service ${service.applicationId}'s fire times could not be read`,
        error,
      );
      return [];
    }
  }

  /**
   * One run, started by the timetable. A Cron service whose build vanished
   * since it was read is skipped as one never armed is: nothing is written.
   */
  private async fire(applicationId: string): Promise<Deployment | null> {
    try {
      return await this.runs.start(applicationId, { kind: 'timetable' });
    } catch (error) {
      if (isWaitingForFirstBuild(error)) return null;
      this.logger.error(
        `The timetable could not start a run of Cron service ${applicationId}`,
        error,
      );
      return null;
    }
  }

  /**
   * Every Cron service the timetable fires: of the `cron` kind, not Stopped,
   * with a Build deployment that succeeded (not a preview's, not a run), of
   * an Organization that is not frozen.
   */
  private async armed(): Promise<Armed[]> {
    const built = this.db
      .select({ applicationId: deployment.applicationId })
      .from(deployment)
      .where(and(isNotNull(deployment.applicationId), isSuccessfulBuild()));
    const rows = await this.db
      .select({
        applicationId: application.applicationId,
        schedule: application.cronSchedule,
        timezone: application.cronTimezone,
      })
      .from(application)
      .where(
        and(
          eq(application.configKind, 'cron'),
          ne(application.applicationStatus, 'stopped'),
          isNotNull(application.cronSchedule),
          inArray(application.applicationId, built),
        ),
      );
    const armed: Armed[] = [];
    for (const { applicationId, schedule, timezone } of rows) {
      if (!schedule || !timezone) continue;
      if (await this.frozen.isFrozenAt({ serviceId: applicationId })) continue;
      armed.push({ applicationId, schedule, timezone });
    }
    return armed;
  }
}

function isWaitingForFirstBuild(error: unknown): boolean {
  if (!(error instanceof HttpException)) return false;
  const body = error.getResponse();
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { code?: unknown }).code === WAITING_FOR_FIRST_BUILD_CODE
  );
}
