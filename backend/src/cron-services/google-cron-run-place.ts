import { Inject, Injectable, Logger } from '@nestjs/common';
import { customAlphabet } from 'nanoid';

import { CloudAccountsService } from '../cloud-accounts/cloud-accounts.service';
import { googleAccountOf } from '../cloud-accounts/cloud-provider';
import { googleRefusalReason } from '../cloud-accounts/gcp/api-off';
import { serviceName } from '../cloud-accounts/gcp/definitions/names';
import {
  logPlaceOf,
  logPlaceText,
  nextLogPlace,
} from '../cloud-accounts/gcp/execution-log';
import {
  GOOGLE_CLOUD_PORT,
  NOT_FOUND,
} from '../cloud-accounts/google-cloud.port';
import type {
  CloudRunExecutionRef,
  CloudRunExecutionStatus,
  ExecutionLogPlace,
  GoogleAccessToken,
  GoogleCloudPort,
} from '../cloud-accounts/google-cloud.port';
import { describeError } from '../common/describe-error';
import type { DeployableApplication } from '../deployment-engine/deployment-engine.types';
import { CLOUD_LOG_SETTLE } from './cron-run-place.port';
import type {
  CronRunEnding,
  CronRunFound,
  CronRunJob,
  CronRunPlace,
  CronRunPlaceWords,
  CronRunRef,
} from './cron-run-place.port';

/** A run id: short and lowercase, as on a Server and ECS. */
const runId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 8);

/** A sign-in is asked again after this long (its access token lasts an hour). */
const SESSION_REFRESH_MS = 30 * 60_000;

/** The most entries one look copies; the next look reads on. */
const LOG_PAGE = 1000;

/** Where a run's execution is: its Cron service's job, by its fixed name. */
interface JobPlace {
  readonly projectId: string;
  readonly region: string;
  readonly job: string;
}

/**
 * A Cron service's run in a Google Cloud account (ADR-0034 as
 * amended): one execution of the Cron
 * service's Cloud Run job, started with `jobs.run` as its last deploy left
 * the job. There is no Cloud Scheduler: Cloudgate's timetable fires each
 * run, as on a Server and on ECS, so a run happens only while Cloudgate is
 * up. Each tick is its own execution, so a run still going at the next
 * tick does not stop the next.
 *
 * The execution is watched with `executions.get` (its exit code read from
 * its one task), its own output is copied from Cloud Logging into the run's
 * log while it runs, from where the copy reached (kept on the Run record by
 * entry timestamp and insert id), and it is stopped with
 * `executions.cancel`. An execution Google no longer has has no ending to
 * read: its run's result is unknown.
 */
@Injectable()
export class GoogleCronRunPlace implements CronRunPlace {
  private readonly logger = new Logger(GoogleCronRunPlace.name);

  constructor(
    @Inject(GOOGLE_CLOUD_PORT) private readonly google: GoogleCloudPort,
    private readonly cloudAccounts: CloudAccountsService,
  ) {}

  /** An execution's output is copied into the run's log while it runs. */
  readonly copiesWhileRunning = true;

  /** Cloud Logging shows an entry a few seconds after it is received. */
  readonly logSettle = CLOUD_LOG_SETTLE;

  readonly words: CronRunPlaceWords = {
    answersAgain: '↻ [Run] Google Cloud answers again; watching the run again',
    lostSightOf: 'Google Cloud',
    gone: (_when, why) =>
      why === 'restart'
        ? 'result unknown: Cloudgate was down when it finished'
        : 'result unknown: Cloudgate could not reach Google Cloud when it finished',
  };

  /**
   * Cloudgate's own name for the run, kept on its Run record beside the
   * execution's: Google names an execution itself, and Cloudgate passes no
   * overrides to `jobs.run` (no `run.jobs.runWithOverrides`).
   */
  jobName(appName: string): string {
    return `${appName}-run-${runId()}`;
  }

  describeJob(job: string): string {
    return `an execution of its Cloud Run job (${job})`;
  }

  async start(app: DeployableApplication): Promise<CronRunJob> {
    if (!app.cloudAccountId || !app.region) {
      throw new Error(`${app.name} does not run in a Cloud account`);
    }
    // Its variables are the job's own Secret Manager secrets, written by
    // the deploy that last updated it; the execution reads them there.
    const { projectId, token } = await this.sessions(app.cloudAccountId);
    const place: JobPlace = {
      projectId,
      region: app.region,
      job: serviceName(app.applicationId),
    };
    const ran = await this.google.runCloudRunJob(await token(), {
      projectId: place.projectId,
      region: place.region,
      name: place.job,
    });
    if (!ran.ok) {
      throw new Error(
        `Cloud Run refused to start it: ${ran.code}: ${googleRefusalReason(ran.message, projectId)}`,
      );
    }
    return this.jobOf(token, place, ran.value.execution, null);
  }

  async reach(run: CronRunRef): Promise<CronRunJob> {
    if (!run.cloudAccountId || !run.applicationId || !run.region) {
      throw new Error('This run is not in a Cloud account');
    }
    const { projectId, token } = await this.sessions(run.cloudAccountId);
    // Reached now, so a Cloud account that cannot be leaves the run running.
    await token();
    return this.jobOf(
      token,
      { projectId, region: run.region, job: serviceName(run.applicationId) },
      run.cronRun.execution ?? null,
      logPlaceOf(run.cronRun.logFrom),
    );
  }

  private jobOf(
    token: () => Promise<GoogleAccessToken>,
    place: JobPlace,
    execution: string | null,
    logFrom: ExecutionLogPlace | null,
  ): CronRunJob {
    let from = logFrom;
    const ref = (name: string): CloudRunExecutionRef => ({
      projectId: place.projectId,
      region: place.region,
      job: place.job,
      execution: name,
    });
    // A run whose execution was never saved (Cloudgate went down between
    // `jobs.run` and the save) has nothing to look at: it reads as gone.
    const read = async (): Promise<CloudRunExecutionStatus | null> => {
      if (!execution) return null;
      const answer = await this.google.cloudRunExecution(
        await token(),
        ref(execution),
      );
      if (!answer.ok && answer.code === NOT_FOUND) return null;
      if (!answer.ok) {
        throw new Error(
          `Cloud Run could not be asked about the run's execution: ${answer.code}: ${answer.message}`,
        );
      }
      return answer.value;
    };
    return {
      ending: async () => {
        const status = await read();
        if (!status) {
          return {
            exitCode: null,
            state: 'gone',
            err: 'Google Cloud no longer has the execution',
          };
        }
        return endingOf(status);
      },
      output: async () => {
        if (!execution) return '';
        const answer = await this.google.executionLogEntries(await token(), {
          ...ref(execution),
          from,
          limit: LOG_PAGE,
        });
        if (!answer.ok) {
          throw new Error(
            `Cloud Logging refused the read of its log: ${answer.code}: ${answer.message}`,
          );
        }
        // A read that found nothing leaves the place where it was.
        from = nextLogPlace(from, answer.value);
        return answer.value.map((entry) => `${entry.text}\n`).join('');
      },
      kept: () => ({
        ...(execution ? { execution } : {}),
        ...(from ? { logFrom: logPlaceText(from) } : {}),
      }),
      remove: async () => {
        if (!execution) return true;
        try {
          // One that has ended, or that Google no longer has, is gone.
          const status = await read();
          if (!status || status.state !== 'running') return true;
          const cancelled = await this.google.cancelCloudRunExecution(
            await token(),
            ref(execution),
          );
          if (cancelled.ok || cancelled.code === NOT_FOUND) return true;
          this.logger.warn(
            `Execution ${execution} could not be cancelled: ${cancelled.code}: ${cancelled.message}`,
          );
          // Ended between the look and the cancel.
          return (await read())?.state !== 'running';
        } catch (error) {
          this.logger.warn(
            `Execution ${execution} could not be cancelled: ${describeError(error)}`,
          );
          return false;
        }
      },
      find: async (): Promise<CronRunFound> => {
        const status = await read();
        if (!status) return { there: false, ending: null };
        const ending = endingOf(status);
        return ending ? { there: false, ending } : { there: true };
      },
    };
  }

  /**
   * The Cloud account's project and its deploy service account's access
   * token, asked once and again near its end; a refusal throws, with its
   * words, as an unreachable place does.
   */
  private async sessions(cloudAccountId: string): Promise<{
    projectId: string;
    token: () => Promise<GoogleAccessToken>;
  }> {
    const row = await this.cloudAccounts.findForUse(cloudAccountId);
    if (!row) throw new Error('The Cloud account this Service runs in is gone');
    const account = googleAccountOf(row);
    let held: { token: GoogleAccessToken; at: number } | null = null;
    return {
      projectId: account.cloudId,
      token: async () => {
        if (held && Date.now() - held.at < SESSION_REFRESH_MS) {
          return held.token;
        }
        const signed = await this.cloudAccounts.googleRunSession(account);
        if (!signed.ok) throw new Error(signed.refusal);
        held = { token: signed.token, at: Date.now() };
        return signed.token;
      },
    };
  }
}

/**
 * How an ended execution ended: its container's exit code when Google
 * reports one, else Google's condition (an image it could not pull, a
 * secret it could not read); `null` while it runs.
 */
function endingOf(status: CloudRunExecutionStatus): CronRunEnding | null {
  if (status.state === 'running') return null;
  return {
    exitCode: status.exitCode,
    state: status.state,
    err: status.exitCode === null ? status.message : null,
  };
}
