import { Injectable, Logger } from '@nestjs/common';
import type Docker from 'dockerode';
import { customAlphabet } from 'nanoid';

import { buildRunJobSettings } from '../deployment-engine/mechanize';
import type { DeployableApplication } from '../deployment-engine/deployment-engine.types';
import { RemoteDockerFactory } from '../docker/remote-docker.factory';
import type { CronRunMark } from './cron-run.types';
import type {
  CronRunEnding,
  CronRunFound,
  CronRunJob,
  CronRunPlace,
  CronRunPlaceWords,
} from './cron-run-place.port';
import { demuxDockerLogs } from './docker-log-frames';
import { describeError } from '../common/describe-error';

/** A run id: short, lowercase, so the job name stays a valid service name. */
const runId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 8);

/** Swarm's longest service name. */
const MAX_SERVICE_NAME = 63;

/** The states a Swarm task does not leave. */
const ENDED_STATES = new Set([
  'complete',
  'failed',
  'rejected',
  'shutdown',
  'orphaned',
  'remove',
]);

interface SwarmTask {
  Status?: {
    State?: string;
    Err?: string;
    ContainerStatus?: { ExitCode?: number };
  };
}

/**
 * A Cron service's run on a Server (ADR-0034): a one-off Swarm
 * job built from the spec a `web` deploys with ({@link buildRunJobSettings}),
 * on the Cron service's run Server. It is watched by its task's state, its
 * output is the job's service log, and it is removed once it ends; a
 * finished run leaves no container.
 */
@Injectable()
export class SwarmCronRunPlace implements CronRunPlace {
  private readonly logger = new Logger(SwarmCronRunPlace.name);

  constructor(private readonly dockerFactory: RemoteDockerFactory) {}

  /** A job's service log is read whole, once it has ended. */
  readonly copiesWhileRunning = false;

  /** Docker has a job's whole log once it has ended: no settle. */
  readonly logSettle = null;

  readonly words: CronRunPlaceWords = {
    answersAgain: '↻ [Run] Its Server answers again; watching the run again',
    lostSightOf: "the run's Server",
    gone: (when) =>
      `lost: ${when} and the run's job was gone, with no exit status`,
  };

  jobName(appName: string): string {
    const id = runId();
    return `${appName.slice(0, MAX_SERVICE_NAME - `-run-${id}`.length)}-run-${id}`;
  }

  describeJob(job: string): string {
    return `Swarm job '${job}'`;
  }

  async start(
    app: DeployableApplication,
    run: {
      job: string;
      image: string;
      wiredEnv: () => Promise<Record<string, string>>;
    },
  ): Promise<CronRunJob> {
    const docker = await this.dockerFactory.getRemoteDocker(app.serverId);
    const settings = buildRunJobSettings(app, {
      name: run.job,
      image: run.image,
      wiredEnv: await run.wiredEnv(),
    });
    if (settings.authconfig) {
      await docker.createService(settings.authconfig, settings);
    } else {
      await docker.createService(settings);
    }
    return this.jobOn(docker, run.job);
  }

  async reach(run: {
    serverId: string | null;
    cronRun: CronRunMark;
  }): Promise<CronRunJob> {
    const docker = await this.dockerFactory.getRemoteDocker(run.serverId);
    return this.jobOn(docker, run.cronRun.job);
  }

  private jobOn(docker: Docker, job: string): CronRunJob {
    const tasks = async () =>
      (await docker.listTasks({
        filters: { service: [job] },
      })) as SwarmTask[];
    return {
      ending: async () => endingOf(await tasks()),
      output: () => readLogs(docker.getService(job)),
      remove: async () => {
        try {
          await docker.getService(job).remove();
          return true;
        } catch (error) {
          if (isNotFound(error)) return true;
          this.logger.warn(
            `Swarm job ${job} could not be removed: ${describeError(error)}`,
          );
          return false;
        }
      },
      find: async (): Promise<CronRunFound> => {
        try {
          await docker.getService(job).inspect();
          return { there: true };
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
        // Swarm may still list the gone job's last task.
        const last = await tasks().catch((): SwarmTask[] => []);
        return { there: false, ending: endingOf(last) };
      },
    };
  }
}

/** The first task of a job that has ended, as its ending. */
function endingOf(tasks: SwarmTask[]): CronRunEnding | null {
  const ended = tasks.find((task) =>
    ENDED_STATES.has(task.Status?.State ?? ''),
  );
  if (!ended) return null;
  return {
    exitCode: ended.Status?.ContainerStatus?.ExitCode ?? null,
    state: ended.Status?.State ?? 'unknown',
    err: ended.Status?.Err || null,
  };
}

/** Docker's answer for a service that does not exist. */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { statusCode?: unknown }).statusCode === 404
  );
}

/** A job's output, whichever shape dockerode answers it in. */
async function readLogs(service: Docker.Service): Promise<string> {
  const answer = (await service.logs({
    stdout: true,
    stderr: true,
    follow: false,
  })) as unknown;
  if (Buffer.isBuffer(answer)) return demuxDockerLogs(answer);
  if (typeof answer === 'string') return answer;
  const chunks: Buffer[] = [];
  for await (const chunk of answer as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return demuxDockerLogs(Buffer.concat(chunks));
}
