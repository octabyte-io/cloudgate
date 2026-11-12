import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { readCronExpression } from '../common/cron-expression';
import { nextFireTimes } from './fire-times';
import type { WallClock } from '../common/cron-expression';

/** The longest delay `setTimeout` takes; a longer wait is armed in legs. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** A registered job, as {@link SchedulingService.get} reads it back. */
export interface ScheduledJob {
  readonly cronExpression: string;
  /** The zone its clock times are read in: the one given, else the host's. */
  readonly timezone: string;
  /** When it fires next, or `null` when no date matches it any more. */
  readonly nextFireAt: Date | null;
}

interface Job {
  readonly cronExpression: string;
  readonly timezone: string;
  readonly clock: WallClock;
  readonly task: () => Promise<void>;
  nextFireAt: Date | null;
  timer?: NodeJS.Timeout;
}

/**
 * Cron jobs by id: backup, volume-backup and user-schedule cron jobs, and the
 * platform's own housekeeping ones, all register through this service, keyed
 * by their row id (or a fixed name), so a schedule change is always
 * re-register-by-id. Task failures are logged and never escape a tick — a
 * failed run must not kill the recurring job.
 *
 * **When a job fires is {@link nextFireTimes}'s**, the rule a Cron
 * service fires by: around a daylight-saving change in the job's timezone a
 * clock time that does not exist is skipped, and one that happens twice
 * fires once, at its first occurrence. Each job arms one timer to its next
 * fire time, and on firing arms the next before its task runs. The `cron`
 * library that ran these before fired a sub-hourly time in the repeated hour
 * twice, and a missing time an hour late.
 *
 * Expressions are read by {@link readCronExpression}, in the `cron` library's
 * dialect they were always written in; a timezone of `null` is the host's,
 * as it was under `cron`.
 */
@Injectable()
export class SchedulingService implements OnModuleDestroy {
  private readonly logger = new Logger(SchedulingService.name);
  private readonly jobs = new Map<string, Job>();

  /**
   * Arms `task` on `cronExpression`, replacing any job with this id. Throws,
   * leaving no job under `id`, on an expression it cannot read, a timezone
   * `Intl` does not know, or an expression no date matches.
   */
  register(
    id: string,
    cronExpression: string,
    timezone: string | null | undefined,
    task: () => Promise<void>,
  ): void {
    this.unregister(id);
    const zone = timezone ?? hostTimezone();
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
    } catch {
      throw new Error(`Invalid timezone: ${zone}`);
    }
    const job: Job = {
      cronExpression,
      timezone: zone,
      clock: readCronExpression(cronExpression),
      task,
      nextFireAt: null,
    };
    this.arm(id, job, new Date());
    if (job.nextFireAt === null) {
      throw new Error(`No date matches the cron expression ${cronExpression}`);
    }
    this.jobs.set(id, job);
  }

  unregister(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    clearTimeout(job.timer);
    this.jobs.delete(id);
  }

  has(id: string): boolean {
    return this.jobs.has(id);
  }

  get(id: string): ScheduledJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const { cronExpression, timezone, nextFireAt } = job;
    return { cronExpression, timezone, nextFireAt };
  }

  /** Every registered job's id. */
  ids(): string[] {
    return [...this.jobs.keys()];
  }

  /**
   * Runs a registered job's task now, as its timer would, and settles when
   * the task has: a failure is logged, not thrown. Its timer is untouched.
   */
  runNow(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`No scheduled job ${id}`);
    return this.run(id, job);
  }

  onModuleDestroy(): void {
    for (const id of this.ids()) this.unregister(id);
  }

  /** Arms `job`'s timer to its first fire time after `after`. */
  private arm(id: string, job: Job, after: Date): void {
    const [next] = nextFireTimes(job.clock, job.timezone, after, 1);
    job.nextFireAt = next ?? null;
    if (next) this.wait(id, job, next);
  }

  private wait(id: string, job: Job, at: Date): void {
    const delay = Math.min(
      Math.max(at.getTime() - Date.now(), 0),
      MAX_TIMER_MS,
    );
    job.timer = setTimeout(() => {
      // A wait past the longest timer comes back early, in legs.
      if (Date.now() < at.getTime()) return this.wait(id, job, at);
      // Armed from now when the timer came late, so a process held up past
      // several fire times fires once, not once for each.
      this.arm(id, job, new Date(Math.max(at.getTime(), Date.now())));
      void this.run(id, job);
    }, delay);
  }

  private async run(id: string, job: Job): Promise<void> {
    try {
      await job.task();
    } catch (error) {
      this.logger.error(`Scheduled job ${id} failed`, error);
    }
  }
}

/** The zone this process's clock reads in, which `cron` used for no zone. */
function hostTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
