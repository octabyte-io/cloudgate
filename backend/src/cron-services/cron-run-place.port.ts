import type { DeployableApplication } from '../deployment-engine/deployment-engine.types';
import type { CronRunMark, CronTask } from './cron-run.types';

/**
 * Where a Cron service's run happens (ADR-0034): the one seam a run's
 * start, watch, log copy, stop and boot recovery go through, one
 * implementation per place a run can happen. The Server's is a one-off Swarm
 * job (`SwarmCronRunPlace`); a Cron service in an AWS Cloud account's is a
 * one-off ECS task (`EcsCronRunPlace`), and in a Google Cloud
 * account's an execution of its Cloud Run job (`GoogleCronRunPlace`).
 *
 * Everything else about a run is place-blind and stays in `CronRunsService`
 * and `CronTimetable`: the timetable and its fire times, the missed-tick
 * rule, overlap, no retries, the Run record and its Deployment log, the
 * timeout, and the `CRON_RUN_STOPPER` promises (the first settle wins; a run
 * whose job is not confirmed gone stays `running`). A place only starts,
 * looks at, reads and removes one run's job.
 */
export interface CronRunPlace {
  /**
   * A new run's job name, unique per run and valid in this place: kept on
   * the Run record (`CronRunMark.job`) so the run can be found again.
   */
  jobName(appName: string): string;

  /** How the job reads in the run's first log line ("Swarm job 'x'"). */
  describeJob(job: string): string;

  /**
   * Whether the job's output is copied into the run's log while it runs
   * ({@link CronRunJob.output} then hands out only what is new), or read
   * whole once it has ended.
   */
  readonly copiesWhileRunning: boolean;

  /**
   * How long the watch keeps reading a run's output once its job has ended
   * for a place whose log store shows a line only some seconds
   * after the job wrote it: {@link CLOUD_LOG_SETTLE} on Google Cloud and
   * AWS. `null` for a place whose output is all there once the job has
   * ended (a Server's Swarm job, read whole from Docker).
   */
  readonly logSettle: CronRunLogSettle | null;

  /** How the run's log names this place in the lines about losing it. */
  readonly words: CronRunPlaceWords;

  /**
   * Starts the run's job. Throws, with the reason, when nothing was started:
   * there is then nothing to watch or remove. `wiredEnv` builds the
   * Service's wired variables now, as a deploy builds them; a place
   * that needs them calls it, and its throw fails the start. `task` is what
   * the last successful build registered in a Cloud account.
   */
  start(
    app: DeployableApplication,
    run: {
      job: string;
      image: string;
      wiredEnv: () => Promise<Record<string, string>>;
      task?: CronTask | null;
    },
  ): Promise<CronRunJob>;

  /**
   * Reaches a run started earlier, from its Run record, to watch, stop or
   * recover it. Throws when its place cannot be reached now; the run then
   * stays `running` and a later tick tries again.
   */
  reach(run: CronRunRef): Promise<CronRunJob>;
}

/**
 * A run's settle read: once its job has ended, the watch reads its
 * output again every `everyMs` until a read made at least `quietAfterMs`
 * after the end finds nothing new, and makes no read later than `capMs`
 * after the end. The run is settled first, by how its job ended, and its
 * exit code line written only after the last read.
 */
export interface CronRunLogSettle {
  readonly everyMs: number;
  readonly quietAfterMs: number;
  readonly capMs: number;
}

/**
 * The settle of a place whose log store shows a line late: every
 * 3 s, quiet after 10 s, at most 30 s. **Cloud Logging** makes an entry
 * readable a few seconds after it is received: a live walk saw the last two
 * lines of a run, received at 16:55:28.25, missing from a read at about
 * 16:55:33. **CloudWatch Logs** is eventually consistent too: an event
 * `PutLogEvents` took is not promised to the `GetLogEvents` made right after
 * it, and the task's `awslogs` driver sends its lines in batches (every 5 s
 * by default) and its last batch when the container closes, in no order
 * with ECS reporting the task `STOPPED`. A run with no output settles about
 * 12 s after its end, the first read past the quiet mark.
 */
export const CLOUD_LOG_SETTLE: CronRunLogSettle = {
  everyMs: 3_000,
  quietAfterMs: 10_000,
  capMs: 30_000,
};

/** A run started earlier, as its Run record and its Cron service's row hold it. */
export interface CronRunRef {
  serverId: string | null;
  cronRun: CronRunMark;
  /** Its Cron service's Cloud account and region, when it runs in one. */
  cloudAccountId?: string | null;
  region?: string | null;
  applicationId?: string | null;
  environmentId?: string | null;
}

/** The place in a run's log lines: "its Server", AWS or Google Cloud. */
export interface CronRunPlaceWords {
  /** The line of a run picked up again once its place answers. */
  readonly answersAgain: string;
  /** Whom Cloudgate lost sight of ("the run's Server"). */
  readonly lostSightOf: string;
  /**
   * The last line of a run whose job was gone, with no ending its place
   * kept, when it was picked up again: `when` says what happened first.
   */
  gone(when: string, why: 'restart' | 'unreachable'): string;
}

/** One run's job in its place. */
export interface CronRunJob {
  /**
   * How the job ended, or `null` while it still goes. Throws when its place
   * cannot be reached, which is not the job ended.
   */
  ending(): Promise<CronRunEnding | null>;

  /**
   * The job's output not yet handed out: all of it so far for a place that
   * reads it once it has ended, only what is new for one that copies it
   * while it runs. Throws when it cannot be read.
   */
  output(): Promise<string>;

  /**
   * What of the job to keep on its Run record, so {@link CronRunPlace.reach}
   * finds it again, and reads its output on from where the log is: an ECS
   * task's ARN and its stream's position. Nothing for a job found
   * by its name alone.
   */
  kept?(): Partial<CronRunMark>;

  /**
   * Stops the job and removes what it left, answering whether it is
   * confirmed gone (already gone counts). Never throws: an unconfirmed
   * removal is `false`.
   */
  remove(): Promise<boolean>;

  /**
   * For picking a run up again (after a restart, or once its place answers):
   * still there, or gone with how it ended when the place still knows, or
   * `null` when it does not. Throws when its place cannot be reached.
   */
  find(): Promise<CronRunFound>;
}

/** How a run's job ended, as its last log line and its status read it. */
export interface CronRunEnding {
  /** `null` when the place kept none. */
  exitCode: number | null;
  /** The place's word for how it ended ("complete", "failed"). */
  state: string;
  /** The place's reason, when it gave one. */
  err: string | null;
}

/** A run's job as {@link CronRunJob.find} finds it. */
export type CronRunFound =
  | { readonly there: true }
  | { readonly there: false; readonly ending: CronRunEnding | null };
