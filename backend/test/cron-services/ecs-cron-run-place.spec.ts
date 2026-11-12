import { EcsCronRunPlace } from '../../src/cron-services/ecs-cron-run-place';
import type { CloudAccountsService } from '../../src/cloud-accounts/cloud-accounts.service';
import type { InfrastructureStatesService } from '../../src/cloud-accounts/infrastructure-state/infrastructure-states.service';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import { makeApp } from '../deployment-engine/application.fixture';
import { FakeCloudPort, fakeTaskArn } from '../utils/fake-cloud-port';

const REGION = 'eu-central-1';
const CLUSTER = 'arn:aws:ecs:eu-central-1:123456789012:cluster/cloudgate-env-1';
const NETWORK = {
  clusterArn: CLUSTER,
  publicSubnetIds: ['subnet-a', 'subnet-b'],
};
const TASK = {
  taskDefinitionArn:
    'arn:aws:ecs:eu-central-1:123456789012:task-definition/cloudgate-app-1:7',
  securityGroupId: 'sg-cron',
};
const LOG_GROUP = '/cloudgate/env-1/app-1';
const SESSION = {
  accessKeyId: 'ASIA',
  secretAccessKey: 's',
  sessionToken: 'fake-session-token',
};

/** A database answering the Environment network's one read. */
function dbWith(network: typeof NETWORK | null): DrizzleDB {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => Promise.resolve(network ? [network] : []),
  };
  return chain as unknown as DrizzleDB;
}

function placeWith(
  over: {
    network?: typeof NETWORK | null;
    session?:
      { ok: true; session: typeof SESSION } | { ok: false; refusal: string };
  } = {},
) {
  const cloud = new FakeCloudPort();
  const accounts = {
    findForUse: jest.fn().mockResolvedValue({
      cloudAccountId: 'cloud-1',
      cloud: 'aws',
      name: 'Prod',
    }),
    deployRoleSession: jest
      .fn()
      .mockResolvedValue(over.session ?? { ok: true, session: SESSION }),
  };
  const states = {
    findForApplication: jest
      .fn()
      .mockResolvedValue({ infrastructureStateId: 'state-1' }),
  };
  const place = new EcsCronRunPlace(
    dbWith(over.network === undefined ? NETWORK : over.network),
    cloud,
    accounts as unknown as CloudAccountsService,
    states as unknown as InfrastructureStatesService,
  );
  return { place, cloud, accounts };
}

const app = makeApp({
  applicationId: 'app-1',
  environmentId: 'env-1',
  cloudAccountId: 'cloud-1',
  region: REGION,
  serverId: null,
});

const run = {
  job: 'shop-api-x1-run-abc',
  image:
    '123456789012.dkr.ecr.eu-central-1.amazonaws.com/cloudgate/app-1:dep-1',
  wiredEnv: () => Promise.reject(new Error('never built on ECS')),
  task: TASK,
};

const ref = (cronRun: Record<string, unknown>) => ({
  serverId: null,
  cloudAccountId: 'cloud-1',
  region: REGION,
  applicationId: 'app-1',
  environmentId: 'env-1',
  cronRun: {
    job: run.job,
    image: run.image,
    startedBy: { kind: 'timetable' as const },
    ...cronRun,
  },
});

const firstTask = fakeTaskArn(REGION, CLUSTER, 1);

describe('EcsCronRunPlace', () => {
  it('starts one Fargate task of the last build’s revision, in the network’s public subnets with a public IP and the Cron service’s group, tagged with its mark', async () => {
    const { place, cloud } = placeWith();

    const job = await place.start(app, run);

    expect(cloud.calls.filter((call) => call.method === 'ecsRunTask')).toEqual([
      {
        method: 'ecsRunTask',
        region: REGION,
        cluster: CLUSTER,
        taskDefinitionArn: TASK.taskDefinitionArn,
        subnets: ['subnet-a', 'subnet-b'],
        securityGroups: ['sg-cron'],
        startedBy: run.job,
        tags: {
          'cloudgate:cloud-account': 'cloud-1',
          'cloudgate:environment': 'env-1',
          'cloudgate:state': 'state-1',
        },
      },
    ]);
    expect(job.kept?.()).toEqual({ taskArn: firstTask });
  });

  it('never builds the wired variables: the task reads what its deploy wrote to SSM', async () => {
    const { place } = placeWith();
    await expect(place.start(app, run)).resolves.toBeDefined();
  });

  it('throws with ECS’s reason, holding nothing, when ECS starts no task', async () => {
    const { place, cloud } = placeWith();
    cloud.refuseTaskStart('RESOURCE:MEMORY');

    await expect(place.start(app, run)).rejects.toThrow(
      'ECS did not start it: RESOURCE:MEMORY',
    );
    expect(cloud.tasksStarted).toEqual([]);
  });

  it('throws with the refusal when the Cloud account cannot take on its deploy role', async () => {
    const { place, cloud } = placeWith({
      session: {
        ok: false,
        refusal: 'Cloud account Prod could not take on its deploy role',
      },
    });

    await expect(place.start(app, run)).rejects.toThrow(
      'could not take on its deploy role',
    );
    expect(cloud.tasksStarted).toEqual([]);
  });

  it('throws, waiting for first build, when no deploy registered a task definition', async () => {
    const { place } = placeWith();
    await expect(place.start(app, { ...run, task: null })).rejects.toThrow(
      'waiting for first build',
    );
  });

  it('throws when the Environment network is not made', async () => {
    const { place } = placeWith({ network: null });
    await expect(place.start(app, run)).rejects.toThrow('is not made');
  });

  describe('a run’s task', () => {
    it('goes on while ECS runs it, and ends with its container’s exit code', async () => {
      const { place, cloud } = placeWith();
      const job = await place.start(app, run);

      await expect(job.ending()).resolves.toBeNull();
      cloud.endTask(firstTask, 3);
      await expect(job.ending()).resolves.toEqual({
        exitCode: 3,
        state: 'stopped',
        err: null,
      });
    });

    it('ends with ECS’s reason when its container never ran', async () => {
      const { place, cloud } = placeWith();
      const job = await place.start(app, run);
      cloud.stopTaskUnstarted(
        firstTask,
        'CannotPullContainerError: pull image manifest has been retried',
      );

      await expect(job.ending()).resolves.toEqual({
        exitCode: null,
        state: 'stopped',
        err: 'CannotPullContainerError: pull image manifest has been retried',
      });
    });

    it('reads its own stream on from where the last read ended, and keeps where that is', async () => {
      const { place, cloud } = placeWith();
      const job = await place.start(app, run);
      cloud.printTask(LOG_GROUP, firstTask, ['one', 'two']);

      await expect(job.output()).resolves.toBe('one\ntwo\n');
      await expect(job.output()).resolves.toBe('');
      cloud.printTask(LOG_GROUP, firstTask, ['three']);
      await expect(job.output()).resolves.toBe('three\n');
      expect(job.kept?.()).toEqual({ taskArn: firstTask, logFrom: '3' });
      expect(
        cloud.calls.filter((call) => call.method === 'readLogStream')[0],
      ).toMatchObject({
        logGroupName: LOG_GROUP,
        logStreamName: `service/service/${firstTask.split('/').pop()}`,
        from: null,
      });
    });

    it('is stopped with StopTask, and a stop ECS refuses is not confirmed', async () => {
      const { place, cloud } = placeWith();
      const job = await place.start(app, run);

      await expect(job.remove()).resolves.toBe(true);
      expect(cloud.tasksStarted[0].lastStatus).toBe('STOPPED');

      const other = placeWith();
      const second = await other.place.start(app, run);
      other.cloud.refuseTaskStop('AccessDeniedException', 'not authorized');
      await expect(second.remove()).resolves.toBe(false);
    });
  });

  describe('reaching a run again from its Run record', () => {
    it('reads its stream on from where the record says the copy reached', async () => {
      const { place, cloud } = placeWith();
      await place.start(app, run);
      cloud.printTask(LOG_GROUP, firstTask, ['one', 'two', 'three']);

      const job = await place.reach(ref({ taskArn: firstTask, logFrom: '2' }));

      await expect(job.output()).resolves.toBe('three\n');
    });

    it('finds a task still going, a stopped one with its exit code, and one ECS forgot as gone with no ending', async () => {
      const { place, cloud } = placeWith();
      await place.start(app, run);
      const job = await place.reach(ref({ taskArn: firstTask }));

      await expect(job.find()).resolves.toEqual({ there: true });
      cloud.endTask(firstTask, 0);
      await expect(job.find()).resolves.toEqual({
        there: false,
        ending: { exitCode: 0, state: 'stopped', err: null },
      });
      cloud.forgetTask(firstTask);
      await expect(job.find()).resolves.toEqual({
        there: false,
        ending: null,
      });
    });

    it('throws when AWS cannot be reached, so the run stays running', async () => {
      const { place } = placeWith({
        session: { ok: false, refusal: 'AWS could not be reached' },
      });
      await expect(place.reach(ref({ taskArn: firstTask }))).rejects.toThrow(
        'AWS could not be reached',
      );
    });

    it('says its result is unknown, not lost, when its task is gone with no ending', () => {
      const { place } = placeWith();
      expect(place.words.gone('Cloudgate restarted', 'restart')).toBe(
        'result unknown: Cloudgate was down when it finished',
      );
    });
  });
});
