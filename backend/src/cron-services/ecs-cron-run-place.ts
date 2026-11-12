import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNotNull } from 'drizzle-orm';
import { customAlphabet } from 'nanoid';

import { defaultTags } from '../cloud-accounts/aws/definitions/tags';
import {
  logGroupName,
  taskLogStream,
} from '../cloud-accounts/aws/definitions/web-definition';
import { CloudAccountsService } from '../cloud-accounts/cloud-accounts.service';
import { awsAccountOf } from '../cloud-accounts/cloud-provider';
import type { AwsCloudAccount } from '../cloud-accounts/cloud-provider';
import { AWS_CLOUD_PORT } from '../cloud-accounts/cloud.port';
import type {
  AwsCloudPort,
  AwsCredential,
  EcsTaskState,
} from '../cloud-accounts/cloud.port';
import { InfrastructureStatesService } from '../cloud-accounts/infrastructure-state/infrastructure-states.service';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { environmentNetwork } from '../db/schema';
import type { DeployableApplication } from '../deployment-engine/deployment-engine.types';
import { environmentNetworkName } from '../deployments/service-scope';
import type { CronTask } from './cron-run.types';
import { CLOUD_LOG_SETTLE } from './cron-run-place.port';
import type {
  CronRunEnding,
  CronRunFound,
  CronRunJob,
  CronRunPlace,
  CronRunPlaceWords,
  CronRunRef,
} from './cron-run-place.port';
import { describeError } from '../common/describe-error';

/** A run id: short and lowercase, as on a Server. */
const runId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 8);

/** ECS's longest `startedBy`. */
const MAX_STARTED_BY = 128;

/** A deploy-role session is asked again after this long (STS gives 15 minutes). */
const SESSION_REFRESH_MS = 10 * 60_000;

/** Where a run's task is, read off its ARN and its Cron service's row. */
interface TaskPlace {
  readonly cloudAccountId: string;
  readonly region: string;
  readonly cluster: string;
  readonly logGroupName: string;
}

/**
 * A Cron service's run in an AWS Cloud account (ADR-0034 as amended):
 * one `RunTask` of the task definition revision its last
 * successful build wrote, on the Environment network's cluster, Fargate, in
 * the network's public subnets with a public IP and the Cron service's own
 * security group. There is no ECS service and no EventBridge: Cloudgate's
 * timetable fires each run, as on a Server.
 *
 * The task is watched by `DescribeTasks`, its own CloudWatch stream is
 * copied into the run's log while it runs (from where the copy reached,
 * kept on the Run record), and it is stopped with `StopTask`. A task ECS no
 * longer describes (it keeps a stopped one about an hour) has no ending to
 * read: its run's result is unknown.
 */
@Injectable()
export class EcsCronRunPlace implements CronRunPlace {
  private readonly logger = new Logger(EcsCronRunPlace.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(AWS_CLOUD_PORT) private readonly cloud: AwsCloudPort,
    private readonly cloudAccounts: CloudAccountsService,
    private readonly states: InfrastructureStatesService,
  ) {}

  /** A task's stream is copied into the run's log while it runs. */
  readonly copiesWhileRunning = true;

  /**
   * CloudWatch Logs can show an event after ECS reports the task stopped
   * its reads are eventually consistent, and `awslogs` sends the
   * last batch when the container closes.
   */
  readonly logSettle = CLOUD_LOG_SETTLE;

  readonly words: CronRunPlaceWords = {
    answersAgain: '↻ [Run] AWS answers again; watching the run again',
    lostSightOf: 'AWS',
    gone: (_when, why) =>
      why === 'restart'
        ? 'result unknown: Cloudgate was down when it finished'
        : 'result unknown: Cloudgate could not reach AWS when it finished',
  };

  jobName(appName: string): string {
    const id = runId();
    return `${appName.slice(0, MAX_STARTED_BY - `-run-${id}`.length)}-run-${id}`;
  }

  describeJob(job: string): string {
    return `a one-off ECS task (${job})`;
  }

  async start(
    app: DeployableApplication,
    run: {
      job: string;
      image: string;
      wiredEnv: () => Promise<Record<string, string>>;
      task?: CronTask | null;
    },
  ): Promise<CronRunJob> {
    if (!app.cloudAccountId || !app.region) {
      throw new Error(`${app.name} does not run in a Cloud account`);
    }
    // Its variables were written to SSM by the deploy that registered this
    // revision, and the task reads them from there.
    if (!run.task) {
      throw new Error(
        'This Cron service is waiting for first build: no deploy has registered its task definition yet',
      );
    }
    const session = await this.sessions(app.cloudAccountId);
    const network = await this.readyNetwork(
      app.environmentId,
      app.cloudAccountId,
      app.region,
    );
    const state = await this.states.findForApplication(app.applicationId);
    const ran = await this.cloud.ecsRunTask(await session(), {
      region: app.region,
      cluster: network.clusterArn,
      taskDefinitionArn: run.task.taskDefinitionArn,
      subnets: network.publicSubnetIds,
      securityGroups: [run.task.securityGroupId],
      startedBy: run.job,
      // Cloudgate's mark, so StopTask, granted only on what carries this
      // Cloud account's tag, can stop it.
      tags: defaultTags({
        cloudAccountId: app.cloudAccountId,
        environmentId: app.environmentId,
        stateId: state?.infrastructureStateId ?? app.applicationId,
      }),
    });
    if (!ran.ok) {
      throw new Error(`ECS refused to start it: ${ran.code}: ${ran.message}`);
    }
    if (!ran.value.started) {
      throw new Error(`ECS did not start it: ${ran.value.reason}`);
    }
    return this.jobOf(
      session,
      placeOfTask(ran.value.taskArn, {
        cloudAccountId: app.cloudAccountId,
        logGroupName: logGroupName(app.environmentId, app.applicationId),
      }),
      ran.value.taskArn,
      null,
    );
  }

  async reach(run: CronRunRef): Promise<CronRunJob> {
    if (!run.cloudAccountId || !run.applicationId || !run.environmentId) {
      throw new Error('This run is not in a Cloud account');
    }
    const session = await this.sessions(run.cloudAccountId);
    // Reached now, so a Cloud account that cannot be leaves the run running.
    await session();
    const taskArn = run.cronRun.taskArn ?? null;
    return this.jobOf(
      session,
      taskArn
        ? placeOfTask(taskArn, {
            cloudAccountId: run.cloudAccountId,
            logGroupName: logGroupName(run.environmentId, run.applicationId),
          })
        : null,
      taskArn,
      run.cronRun.logFrom ?? null,
    );
  }

  private jobOf(
    session: () => Promise<AwsCredential>,
    place: TaskPlace | null,
    taskArn: string | null,
    logFrom: string | null,
  ): CronRunJob {
    let from = logFrom;
    // A run whose task ARN was never saved (Cloudgate went down between
    // RunTask and the save) has nothing to look at.
    const describe = async (): Promise<EcsTaskState | null> => {
      if (!place || !taskArn) return null;
      const answer = await this.cloud.ecsDescribeTasks(await session(), {
        region: place.region,
        cluster: place.cluster,
        taskArns: [taskArn],
      });
      if (!answer.ok) {
        throw new Error(
          `ECS could not be asked about the run's task: ${answer.code}: ${answer.message}`,
        );
      }
      return answer.value.find((task) => task.taskArn === taskArn) ?? null;
    };
    return {
      ending: async () => {
        const task = await describe();
        if (!task) {
          return {
            exitCode: null,
            state: 'gone',
            err: 'ECS no longer describes the task',
          };
        }
        return endingOf(task);
      },
      output: async () => {
        if (!place || !taskArn) return '';
        const read = await this.cloud.readLogStream(await session(), {
          region: place.region,
          logGroupName: place.logGroupName,
          logStreamName: taskLogStream(taskIdOf(taskArn)),
          from,
        });
        if (!read.ok) {
          throw new Error(
            `CloudWatch refused the read of its log: ${read.code}: ${read.message}`,
          );
        }
        from = read.value.next;
        return read.value.messages.map((line) => `${line}\n`).join('');
      },
      kept: () => ({
        ...(taskArn ? { taskArn } : {}),
        ...(from !== null ? { logFrom: from } : {}),
      }),
      remove: async () => {
        if (!place || !taskArn) return true;
        try {
          const stopped = await this.cloud.ecsStopTask(await session(), {
            region: place.region,
            cluster: place.cluster,
            taskArn,
            reason: 'Stopped by Cloudgate',
          });
          if (stopped.ok) return true;
          this.logger.warn(
            `ECS task ${taskArn} could not be stopped: ${stopped.code}: ${stopped.message}`,
          );
          return false;
        } catch (error) {
          this.logger.warn(
            `ECS task ${taskArn} could not be stopped: ${describeError(error)}`,
          );
          return false;
        }
      },
      find: async (): Promise<CronRunFound> => {
        const task = await describe();
        if (!task) return { there: false, ending: null };
        if (task.lastStatus !== 'STOPPED') return { there: true };
        return { there: false, ending: endingOf(task) };
      },
    };
  }

  /**
   * A deploy-role session of the Cloud account, asked once and again near
   * its end; a refusal throws, with its words, as an unreachable place does.
   */
  private async sessions(
    cloudAccountId: string,
  ): Promise<() => Promise<AwsCredential>> {
    const row = await this.cloudAccounts.findForUse(cloudAccountId);
    if (!row) throw new Error('The Cloud account this Service runs in is gone');
    const aws = awsAccountOf(row);
    if (!aws.ok) throw new Error(aws.refusal);
    const account: AwsCloudAccount = aws.account;
    let held: { session: AwsCredential; at: number } | null = null;
    return async () => {
      if (held && Date.now() - held.at < SESSION_REFRESH_MS) {
        return held.session;
      }
      const answer = await this.cloudAccounts.deployRoleSession(account);
      if (!answer.ok) throw new Error(answer.refusal);
      held = { session: answer.session, at: Date.now() };
      return answer.session;
    };
  }

  /** The Environment network's cluster and public subnets, once made. */
  private async readyNetwork(
    environmentId: string,
    cloudAccountId: string,
    region: string,
  ): Promise<{ clusterArn: string; publicSubnetIds: string[] }> {
    const [found] = await this.db
      .select({
        clusterArn: environmentNetwork.clusterArn,
        publicSubnetIds: environmentNetwork.publicSubnetIds,
      })
      .from(environmentNetwork)
      .where(
        and(
          eq(environmentNetwork.environmentId, environmentId),
          eq(environmentNetwork.cloudAccountId, cloudAccountId),
          eq(environmentNetwork.region, region),
          eq(environmentNetwork.status, 'ready'),
          isNotNull(environmentNetwork.clusterArn),
          isNotNull(environmentNetwork.publicSubnetIds),
        ),
      );
    if (!found?.clusterArn || !found.publicSubnetIds) {
      throw new Error(
        `The ${environmentNetworkName(region)} is not made, so there is nowhere to run it`,
      );
    }
    return {
      clusterArn: found.clusterArn,
      publicSubnetIds: [...found.publicSubnetIds],
    };
  }
}

/**
 * How a stopped task ended: its container's exit code, else ECS's reason it
 * never ran (an image it could not pull, a secret it could not read).
 */
function endingOf(task: EcsTaskState): CronRunEnding | null {
  if (task.lastStatus !== 'STOPPED') return null;
  return {
    exitCode: task.exitCode,
    state: 'stopped',
    err: task.exitCode === null ? task.stoppedReason : null,
  };
}

/** A task's region and cluster, read off its ARN (`…:task/<cluster>/<id>`). */
function placeOfTask(
  taskArn: string,
  of: { cloudAccountId: string; logGroupName: string },
): TaskPlace {
  const [, , , region = ''] = taskArn.split(':');
  const parts = taskArn.split('/');
  return {
    ...of,
    region,
    cluster: parts.length >= 3 ? parts[parts.length - 2] : 'default',
  };
}

/** The task's id: the last part of its ARN, and of its log stream's name. */
function taskIdOf(taskArn: string): string {
  return taskArn.split('/').pop() ?? taskArn;
}
