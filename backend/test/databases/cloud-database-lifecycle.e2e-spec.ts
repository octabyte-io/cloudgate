import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { rdsInstanceIdentifier } from '../../src/cloud-accounts/aws/definitions/postgres-definition';
import { tofuStates } from '../../src/cloud-accounts/infrastructure-state/infrastructure-state.schema';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import {
  cloudAccount,
  deployment,
  environmentNetwork,
  infrastructureState,
  postgres,
  redis,
} from '../../src/db/schema';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(240_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';
const DAY = 24 * 60 * 60 * 1000;

const ELASTICACHE = "ElastiCache can't be stopped. Delete it to stop paying.";
const REBUILD = 'Delete the Service and Apply again for a fresh one.';

interface RdsStopBody {
  state: string;
  restartsAt: string;
  sentence: string;
  warning: string | null;
}

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

/**
 * Lifecycle: a postgres on RDS and a redis on
 * ElastiCache have a Server database's Start, Stop and Rebuild, minus what
 * AWS cannot do, and no Remove containers, Reload or Restart.
 *
 * RDS Stop and Start are direct calls through the fake cloud port
 * (`ctx.cloud`); Stop records `stopped` and the date AWS starts the
 * instance again, and the API reads "Started again by AWS" once it has
 * passed. ElastiCache Start and Stop, and Rebuild on either, are refused
 * with the console's sentences, through the API and an Agent's tools alike.
 * A plan never starts a stopped instance: its change is blocked, and the
 * rest of the Apply goes ahead.
 */
describe('Lifecycle of a database in a Cloud account (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let projectId: string;
  let cloudAccountId: string;
  let environmentId: string;
  const queue = {
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    getJobs: jest.fn().mockResolvedValue([]),
    cancel: jest.fn(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: DEPLOYMENT_QUEUE, useValue: queue }],
    });
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    queue.add.mockClear();
    const res = await request(http).post('/api/auth/sign-up/email').send(owner);
    expect(res.status).toBe(200);
    cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const orgs = await request(http)
      .get('/organizations')
      .set('Cookie', cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const project = await request(http)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'Shop' });
    expect(project.status).toBe(201);
    projectId = (project.body as { projectId: string }).projectId;

    const [account] = await ctx.db
      .insert(cloudAccount)
      .values({
        organizationId,
        name: 'Production AWS',
        cloud: 'aws',
        cloudId: ACCOUNT,
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        deployRoleArn: `arn:aws:iam::${ACCOUNT}:role/cloudgate-deploy`,
        taskExecutionRoleArn: `arn:aws:iam::${ACCOUNT}:role/cloudgate-task-execution`,
        externalId: 'external-id-made-by-cloudgate',
        policyVersion: 1,
        lastCheckedAt: new Date().toISOString(),
        lastCheckResult: 'passed',
      })
      .returning();
    cloudAccountId = account.cloudAccountId;

    const env = await request(http)
      .post('/environments')
      .set('Cookie', cookie)
      .send({
        projectId,
        name: 'production',
        deployTarget: { kind: 'cloud', cloudAccountId, region: REGION },
      });
    expect(env.status).toBe(201);
    environmentId = (env.body as { environmentId: string }).environmentId;

    const [network] = await ctx.db
      .insert(environmentNetwork)
      .values({
        environmentId,
        cloudAccountId,
        region: REGION,
        status: 'ready',
        vpcId: 'vpc-0a1b',
        publicSubnetIds: ['subnet-0aaa', 'subnet-0bbb'],
        privateSubnetIds: ['subnet-0ccc', 'subnet-0ddd'],
        clusterArn: `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/env`,
        httpsListenerArn: `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:listener/app/env/1/2`,
        albSecurityGroupId: 'sg-0alb',
      })
      .returning();
    const [networkState] = await ctx.db
      .insert(infrastructureState)
      .values({ environmentNetworkId: network.environmentNetworkId })
      .returning();
    await ctx.db.insert(tofuStates).values({
      name: networkState.infrastructureStateId,
      data: 'encrypted-by-opentofu',
    });
    ctx.cloud.replayPlanFor('postgres', 'postgres-create');
  });

  /** A postgres on RDS and a redis on ElastiCache, as their Apply made them. */
  async function madeInCloud() {
    const [pg] = await ctx.db
      .insert(postgres)
      .values({
        name: 'pg-1',
        configName: 'pg-1',
        environmentId,
        databaseName: 'app',
        databaseUser: 'app',
        databasePassword: 'pg-pass-0e1f2a3b4c',
        cloudAccountId,
        region: REGION,
        applicationStatus: 'done',
      })
      .returning();
    const [cache] = await ctx.db
      .insert(redis)
      .values({
        name: 'redis',
        configName: 'redis',
        environmentId,
        databasePassword: 'redis-pass-0e1f2a3b4c',
        cloudAccountId,
        region: REGION,
        applicationStatus: 'done',
      })
      .returning();
    ctx.cloud.calls.length = 0;
    return { postgresId: pg.postgresId, redisId: cache.redisId };
  }

  const post = (kind: 'postgres' | 'redis', id: string, action: string) =>
    request(http).post(`/${kind}/${id}/${action}`).set('Cookie', cookie);

  const rdsCalls = () =>
    ctx.cloud.calls.filter((call) => call.method.startsWith('rds'));

  const rowOf = async (postgresId: string) => {
    const [row] = await ctx.db
      .select()
      .from(postgres)
      .where(eq(postgres.postgresId, postgresId));
    return row;
  };

  const day = (iso: string) => iso.slice(0, 10);

  it('stops an RDS instance by a direct call, records the date AWS starts it again, and reads "Started again by AWS" once it has passed', async () => {
    const { postgresId } = await madeInCloud();
    const before = Date.now();

    const stopped = await post('postgres', postgresId, 'stop');

    expect(stopped.status).toBe(200);
    expect(rdsCalls()).toEqual([
      {
        method: 'rdsStopInstance',
        region: REGION,
        identifier: rdsInstanceIdentifier(postgresId),
      },
    ]);
    // Through a deploy-role session, and never a Cloud run.
    expect(ctx.cloud.calls[0]).toMatchObject({ method: 'assumeRole' });
    expect(
      ctx.cloud.calls.filter((call) =>
        ['plan', 'apply', 'destroy'].includes(call.method),
      ),
    ).toEqual([]);
    const row = await rowOf(postgresId);
    expect(row.applicationStatus).toBe('stopped');
    const restartsAt = new Date(row.restartsAt!).getTime();
    expect(restartsAt).toBeGreaterThanOrEqual(before + 7 * DAY);
    expect(restartsAt).toBeLessThanOrEqual(Date.now() + 7 * DAY);
    const date = day(row.restartsAt!);
    expect((stopped.body as { rdsStop: RdsStopBody }).rdsStop).toEqual({
      state: 'stopped',
      restartsAt: row.restartsAt,
      sentence: `Stopped, AWS starts it again on ${date}`,
      warning: `AWS starts it again on ${date}, and storage and backups still bill`,
    });

    const read = await request(http)
      .get(`/postgres/${postgresId}`)
      .set('Cookie', cookie);
    expect(read.status).toBe(200);
    expect((read.body as { rdsStop: RdsStopBody }).rdsStop).toMatchObject({
      state: 'stopped',
      sentence: `Stopped, AWS starts it again on ${date}`,
    });

    // Seven days on, AWS has started it again by itself.
    await ctx.db
      .update(postgres)
      .set({ restartsAt: new Date(Date.now() - 60_000).toISOString() })
      .where(eq(postgres.postgresId, postgresId));
    const later = await request(http)
      .get(`/postgres/${postgresId}`)
      .set('Cookie', cookie);
    expect((later.body as { rdsStop: RdsStopBody }).rdsStop).toMatchObject({
      state: 'started-by-aws',
      sentence: 'Started again by AWS',
      warning: null,
    });
    // Cloudgate never stops it again by itself.
    expect(rdsCalls()).toHaveLength(1);
  });

  it('starts it by a direct call and clears the stop record', async () => {
    const { postgresId } = await madeInCloud();
    expect((await post('postgres', postgresId, 'stop')).status).toBe(200);
    ctx.cloud.calls.length = 0;

    const started = await post('postgres', postgresId, 'start');

    expect(started.status).toBe(200);
    expect(rdsCalls()).toEqual([
      {
        method: 'rdsStartInstance',
        region: REGION,
        identifier: rdsInstanceIdentifier(postgresId),
      },
    ]);
    expect(started.body).toMatchObject({
      applicationStatus: 'done',
      restartsAt: null,
      rdsStop: null,
    });
    const row = await rowOf(postgresId);
    expect(row).toMatchObject({ applicationStatus: 'done', restartsAt: null });
  });

  it("answers RDS's refusal as a 409 in its words and records nothing", async () => {
    const { postgresId } = await madeInCloud();
    ctx.cloud.refuseRds(
      'InvalidDBInstanceStateFault',
      `Instance ${rdsInstanceIdentifier(postgresId)} is not in available state.`,
    );

    const res = await post('postgres', postgresId, 'stop');

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'CLOUD_LIFECYCLE_REFUSED',
      message: `RDS refused to stop pg-1: InvalidDBInstanceStateFault: Instance ${rdsInstanceIdentifier(postgresId)} is not in available state.`,
    });
    expect(await rowOf(postgresId)).toMatchObject({
      applicationStatus: 'done',
      restartsAt: null,
    });
  });

  it('refuses Start and Stop of ElastiCache, and Rebuild of either, with the sentences, calling AWS for none', async () => {
    const { postgresId, redisId } = await madeInCloud();

    for (const action of ['start', 'stop']) {
      const res = await post('redis', redisId, action);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        message: ELASTICACHE,
        code: 'ELASTICACHE_CANNOT_STOP',
      });
    }
    for (const [kind, id] of [
      ['postgres', postgresId],
      ['redis', redisId],
    ] as const) {
      const res = await post(kind, id, 'rebuild');
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        message: REBUILD,
        code: 'CLOUD_REBUILD_REFUSED',
      });
    }
    expect(ctx.cloud.calls).toEqual([]);
    const [cache] = await ctx.db.select().from(redis);
    expect(cache.applicationStatus).toBe('done');
    expect((await rowOf(postgresId)).applicationStatus).toBe('done');
  });

  it('offers neither Remove containers, Reload nor Restart on either', async () => {
    const { postgresId, redisId } = await madeInCloud();

    for (const [kind, id] of [
      ['postgres', postgresId],
      ['redis', redisId],
    ] as const) {
      for (const action of ['remove-containers', 'reload', 'restart']) {
        expect((await post(kind, id, action)).status).toBe(404);
      }
    }
    expect(ctx.cloud.calls).toEqual([]);
  });

  it("lets an Agent stop and start RDS through the one check, and answers ElastiCache's Start and Stop with the console's sentence", async () => {
    const { postgresId, redisId } = await madeInCloud();
    const created = await request(http)
      .post('/agents')
      .set('Cookie', cookie)
      .send({
        name: 'deploy-bot',
        role: 'agentOperator',
        grant: {
          accessedProjects: [projectId],
          accessedEnvironments: [environmentId],
          accessedServices: [postgresId, redisId],
        },
      });
    expect(created.status).toBe(201);
    const { key } = created.body as { key: string };
    const callTool = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<ToolResult> => {
      const res = await request(http)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${key}`)
        .set('MCP-Protocol-Version', '2025-06-18')
        .send({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name, arguments: args },
        });
      expect(res.status).toBe(200);
      return (res.body as { result: ToolResult }).result;
    };

    const stopped = await callTool('stop_service', {
      serviceType: 'postgres',
      serviceId: postgresId,
    });
    expect(stopped.isError).toBeFalsy();
    expect((await rowOf(postgresId)).applicationStatus).toBe('stopped');
    const started = await callTool('start_service', {
      serviceType: 'postgres',
      serviceId: postgresId,
    });
    expect(started.isError).toBeFalsy();
    expect(rdsCalls().map((call) => call.method)).toEqual([
      'rdsStopInstance',
      'rdsStartInstance',
    ]);

    for (const tool of ['start_service', 'stop_service']) {
      const refused = await callTool(tool, {
        serviceType: 'redis',
        serviceId: redisId,
      });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain(ELASTICACHE);
    }
  });

  describe('a plan', () => {
    const TWO = `version: 1
services:
  pg-1:
    kind: postgres
    version: "17"
    size: small
  pg-2:
    kind: postgres
    version: "17"
    size: small
`;

    const save = (text: string) =>
      request(http)
        .post(`/projects/${projectId}/config/plans`)
        .set('Cookie', cookie)
        .send({ text });

    interface Step {
      action: string;
      configName?: string;
      blocked?: string;
      cloudRead?: { status: string };
    }
    interface Result {
      configName: string;
      action: string;
      status: string;
      message: string | null;
      deploy: { status: string; deploymentId: string } | null;
    }

    async function readPlan() {
      for (let attempt = 0; attempt < 200; attempt++) {
        const res = await request(http)
          .get(`/environments/${environmentId}/plan`)
          .set('Cookie', cookie);
        expect(res.status).toBe(200);
        const found = (
          res.body as {
            plan: { planId: string; status: string; steps: Step[] };
          }
        ).plan;
        if (!found.steps.some((step) => step.cloudRead?.status === 'reading')) {
          return {
            ...found,
            steps: found.steps.filter(
              (step) => step.action !== 'network-change',
            ),
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('The plan was still reading AWS');
    }

    async function ended(deploymentId: string) {
      for (let attempt = 0; attempt < 200; attempt++) {
        const [row] = await ctx.db
          .select()
          .from(deployment)
          .where(eq(deployment.deploymentId, deploymentId));
        if (row && row.status !== 'pending' && row.status !== 'running') {
          return row;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('The Cloud run did not end');
    }

    const apply = (planId: string) =>
      request(http)
        .post(`/environments/${environmentId}/plan/apply`)
        .set('Cookie', cookie)
        .send({ planId });

    it('marks a change to a stopped instance blocked and applies the rest; once AWS has started it again nothing is blocked', async () => {
      expect((await save(TWO)).status).toBe(201);
      const made = await apply((await readPlan()).planId);
      expect(made.status).toBe(200);
      for (const result of (made.body as { results: Result[] }).results) {
        expect(result.status).toBe('applied');
        expect((await ended(result.deploy!.deploymentId)).status).toBe('done');
      }
      const [pg1] = await ctx.db
        .select()
        .from(postgres)
        .where(eq(postgres.configName, 'pg-1'));
      expect((await post('postgres', pg1.postgresId, 'stop')).status).toBe(200);

      ctx.cloud.replayPlanFor('postgres', 'postgres-class-change');
      expect(
        (await save(TWO.replaceAll('size: small', 'size: large'))).status,
      ).toBe(201);
      const plan = await readPlan();
      expect(plan.steps.map((step) => [step.configName, step.blocked])).toEqual(
        [
          ['pg-1', 'pg-1 is stopped. Start it first.'],
          ['pg-2', undefined],
        ],
      );

      ctx.cloud.calls.length = 0;
      const applied = await apply(plan.planId);
      expect(applied.status).toBe(200);
      const body = applied.body as { status: string; results: Result[] };
      expect(body.status).toBe('partly-applied');
      expect(body.results).toEqual([
        expect.objectContaining({
          configName: 'pg-1',
          action: 'change',
          status: 'blocked',
          message: 'pg-1 is stopped. Start it first.',
          deploy: null,
        }),
        expect.objectContaining({
          configName: 'pg-2',
          action: 'change',
          status: 'applied',
          deploy: expect.objectContaining({ status: 'queued' }) as unknown,
        }),
      ]);
      // Cloudgate never starts a database by itself.
      expect(rdsCalls()).toEqual([]);
      expect(await rowOf(pg1.postgresId)).toMatchObject({
        applicationStatus: 'stopped',
        cpuLimit: pg1.cpuLimit,
        memoryLimit: pg1.memoryLimit,
      });

      // Seven days on, AWS has started it again: the next plan blocks nothing.
      await ctx.db
        .update(postgres)
        .set({ restartsAt: new Date(Date.now() - 60_000).toISOString() })
        .where(eq(postgres.postgresId, pg1.postgresId));
      expect(
        (
          await request(http)
            .post(`/environments/${environmentId}/plan`)
            .set('Cookie', cookie)
        ).status,
      ).toBe(201);
      const again = await readPlan();
      const pg1Step = again.steps.find((step) => step.configName === 'pg-1');
      expect(pg1Step).toBeDefined();
      expect(pg1Step!.blocked).toBeUndefined();
    });
  });
});
