import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { serviceName } from '../../src/cloud-accounts/gcp/definitions/names';
import { makeSigningKey } from '../../src/cloud-accounts/gcp/id-token';
import { InfrastructureStatesService } from '../../src/cloud-accounts/infrastructure-state/infrastructure-states.service';
import {
  cloudAccount,
  deployment,
  environmentNetwork,
  plan as planTable,
  postgres,
  redis,
  webServerSettings,
} from '../../src/db/schema';
import type { Plan } from '../../src/db/schema';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { GOOGLE_COLUMNS } from '../utils/google-cloud-account';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(240_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const PROJECT = 'shop-prod';
const REGION = 'europe-west1';

const MEMORYSTORE = "Memorystore can't be stopped. Delete it to stop paying.";
const REBUILD = 'Delete the Service and Apply again for a fresh one.';
const STOP_WARNING =
  'Storage, backups and its private address still cost money. It stays stopped until you start it.';

const PG_ONLY = (sizes: Record<string, string>) =>
  `version: 1\nservices:\n${Object.entries(sizes)
    .map(
      ([name, size]) => `  ${name}:\n    kind: postgres\n    size: ${size}\n`,
    )
    .join('')}`;

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

interface Step {
  action: string;
  configName?: string;
  blocked?: string;
  cloudRead?: { status: 'reading' | 'read' | 'failed' };
}

interface PlanBody {
  planId: string;
  status: string;
  steps: Step[];
}

/**
 * Stop and Start: a `postgres` on Cloud SQL is
 * stopped and started by one Cloud SQL Admin patch of its activation policy
 * through the Google client port (`ctx.google`), never a Cloud run. Google
 * never starts a stopped instance by itself, so no restart date is
 * recorded and it reads "Stopped". A plan never counts Stop as a change and
 * an Apply never starts it; a change to it is blocked while the rest of the
 * Apply goes ahead. A `redis` on Memorystore has no stopped state: its Start
 * and Stop are refused with the console's sentence, through the API and an
 * Agent's tools alike. Rebuild is refused on both, and neither has Remove
 * containers, Reload or Restart, as on AWS.
 */
describe('Stop and Start of a database on Google Cloud (e2e)', () => {
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
    // The Google account's token issuer is the install's own address.
    await ctx.db
      .insert(webServerSettings)
      .values({ host: 'cloudgate.example.com', https: true });
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
      .send({ name: 'shop' });
    expect(project.status).toBe(201);
    projectId = (project.body as { projectId: string }).projectId;

    const key = makeSigningKey();
    const [account] = await ctx.db
      .insert(cloudAccount)
      .values({
        organizationId,
        name: 'Production Google',
        cloud: 'gcp',
        cloudId: PROJECT,
        ...GOOGLE_COLUMNS,
        signingKey: key.privateKey,
        signingKeyId: key.keyId,
        signingPublicKey: JSON.stringify(key.publicJwk),
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
    ctx.google.replayPlanFor('postgres', 'postgres-create');
    ctx.google.replayOutputsFor('postgres', 'postgres-create');
  });

  /** A postgres on Cloud SQL and a redis on Memorystore, as their Apply made them. */
  async function madeInGoogle() {
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
    ctx.google.calls.length = 0;
    return { postgresId: pg.postgresId, redisId: cache.redisId };
  }

  const post = (kind: 'postgres' | 'redis', id: string, action: string) =>
    request(http).post(`/${kind}/${id}/${action}`).set('Cookie', cookie);

  const activationCalls = () =>
    ctx.google.calls.filter(
      (call) => call.method === 'setCloudSqlActivationPolicy',
    );

  const rowOf = async (postgresId: string) => {
    const [row] = await ctx.db
      .select()
      .from(postgres)
      .where(eq(postgres.postgresId, postgresId));
    return row;
  };

  it('stops a Cloud SQL instance by one patch of its activation policy, records no restart date and reads "Stopped"; Start patches it back', async () => {
    const { postgresId } = await madeInGoogle();

    const stopped = await post('postgres', postgresId, 'stop');

    expect(stopped.status).toBe(200);
    expect(activationCalls()).toEqual([
      {
        method: 'setCloudSqlActivationPolicy',
        impersonated: true,
        projectId: PROJECT,
        name: serviceName(postgresId),
        policy: 'NEVER',
      },
    ]);
    // A direct call, never a Cloud run.
    expect(
      ctx.google.calls.filter((call) =>
        ['plan', 'apply', 'destroy'].includes(call.method),
      ),
    ).toEqual([]);
    expect(await rowOf(postgresId)).toMatchObject({
      applicationStatus: 'stopped',
      restartsAt: null,
    });
    const cloudSqlStop = {
      state: 'stopped',
      sentence: 'Stopped',
      warning: STOP_WARNING,
    };
    expect(stopped.body).toMatchObject({ cloudSqlStop });
    // No AWS stop, and no date: Google never starts it by itself.
    expect(stopped.body).not.toHaveProperty('rdsStop');

    const read = await request(http)
      .get(`/postgres/${postgresId}`)
      .set('Cookie', cookie);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      applicationStatus: 'stopped',
      restartsAt: null,
      cloudSqlStop,
    });
    expect(read.body).not.toHaveProperty('rdsStop');

    ctx.google.calls.length = 0;
    const started = await post('postgres', postgresId, 'start');

    expect(started.status).toBe(200);
    expect(activationCalls()).toEqual([
      expect.objectContaining({
        name: serviceName(postgresId),
        policy: 'ALWAYS',
      }),
    ]);
    expect(started.body).toMatchObject({
      applicationStatus: 'done',
      restartsAt: null,
      cloudSqlStop: null,
    });
    expect(await rowOf(postgresId)).toMatchObject({
      applicationStatus: 'done',
      restartsAt: null,
    });
  });

  it("answers Google's refusal as a 409 in its words and records nothing", async () => {
    const { postgresId } = await madeInGoogle();
    ctx.google.refuse(
      'setCloudSqlActivationPolicy',
      'FAILED_PRECONDITION',
      'The instance is not running.',
    );

    const res = await post('postgres', postgresId, 'stop');

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'CLOUD_LIFECYCLE_REFUSED',
      message:
        'Google Cloud refused to stop pg-1: FAILED_PRECONDITION: The instance is not running.',
    });
    expect(await rowOf(postgresId)).toMatchObject({
      applicationStatus: 'done',
      restartsAt: null,
    });
  });

  it('refuses Start and Stop of Memorystore, and Rebuild of either, with the sentences, calling Google for none', async () => {
    const { postgresId, redisId } = await madeInGoogle();

    for (const action of ['start', 'stop']) {
      const res = await post('redis', redisId, action);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        message: MEMORYSTORE,
        code: 'MEMORYSTORE_CANNOT_STOP',
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
    expect(ctx.google.calls).toEqual([]);
    const [cache] = await ctx.db.select().from(redis);
    expect(cache.applicationStatus).toBe('done');
    expect((await rowOf(postgresId)).applicationStatus).toBe('done');
  });

  it('offers neither Remove containers, Reload nor Restart on either', async () => {
    const { postgresId, redisId } = await madeInGoogle();

    for (const [kind, id] of [
      ['postgres', postgresId],
      ['redis', redisId],
    ] as const) {
      for (const action of ['remove-containers', 'reload', 'restart']) {
        expect((await post(kind, id, action)).status).toBe(404);
      }
    }
    expect(ctx.google.calls).toEqual([]);
  });

  it("lets an Agent stop and start Cloud SQL, and answers Memorystore's Start and Stop with the console's sentence", async () => {
    const { postgresId, redisId } = await madeInGoogle();
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
    expect(activationCalls().map((call) => call.policy)).toEqual([
      'NEVER',
      'ALWAYS',
    ]);

    for (const tool of ['start_service', 'stop_service']) {
      const refused = await callTool(tool, {
        serviceType: 'redis',
        serviceId: redisId,
      });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain(MEMORYSTORE);
    }
  });

  describe('a plan', () => {
    async function currentPlan(): Promise<PlanBody> {
      const res = await request(http)
        .get(`/environments/${environmentId}/plan`)
        .set('Cookie', cookie);
      expect(res.status).toBe(200);
      return (res.body as { plan: PlanBody }).plan;
    }

    async function planned(text: string): Promise<PlanBody> {
      const saved = await request(http)
        .post(`/projects/${projectId}/config/plans`)
        .set('Cookie', cookie)
        .send({ text });
      expect(saved.status).toBe(201);
      for (let attempt = 0; attempt < 400; attempt++) {
        const found = await currentPlan();
        if (!found.steps.some((step) => step.cloudRead?.status === 'reading')) {
          return found;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('The plan was still reading Google Cloud');
    }

    const apply = (planId: string) =>
      request(http)
        .post(`/environments/${environmentId}/plan/apply`)
        .set('Cookie', cookie)
        .send({ planId });

    async function until<T>(
      what: string,
      check: () => Promise<T | null | undefined>,
    ): Promise<T> {
      for (let attempt = 0; attempt < 600; attempt++) {
        const found = await check();
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Never: ${what}`);
    }

    /** The plan's row once no step of its Apply is still running. */
    function settled(planId: string): Promise<Plan> {
      return until('the Apply ended', async () => {
        const [row] = await ctx.db
          .select()
          .from(planTable)
          .where(eq(planTable.planId, planId));
        return row.results !== null &&
          !row.results.some((result) => result.status === 'running')
          ? row
          : null;
      });
    }

    /** Every Cloud run of a postgres once `count` of them have ended. */
    function runsOf(postgresId: string, count: number) {
      return until(`${count} Cloud runs ended`, async () => {
        const rows = await ctx.db
          .select()
          .from(deployment)
          .where(eq(deployment.postgresId, postgresId));
        return rows.length === count &&
          rows.every(
            (row) => row.status !== 'pending' && row.status !== 'running',
          )
          ? rows
          : null;
      });
    }

    /**
     * pg-1 and pg-2 made on Cloud SQL by an Apply, on a made network that
     * already has Cloud SQL's private link, and pg-1 then stopped.
     */
    async function twoMadeAndOneStopped() {
      const [network] = await ctx.db
        .insert(environmentNetwork)
        .values({
          environmentId,
          cloudAccountId,
          region: REGION,
          status: 'ready',
          networkName: 'cloudgate-net',
          subnetName: 'cloudgate-subnet',
          ipAddress: '34.117.42.7',
          urlMapName: 'cloudgate-urls',
          certificateMapName: 'cloudgate-certs',
          privateLinks: ['cloud-sql'],
        })
        .returning();
      await ctx.app
        .get(InfrastructureStatesService)
        .create(
          { environmentNetworkId: network.environmentNetworkId },
          'state_net_1',
          'google',
        );
      const read = await planned(PG_ONLY({ 'pg-1': 'small', 'pg-2': 'small' }));
      expect((await apply(read.planId)).status).toBe(200);
      await settled(read.planId);
      const rows = await until('pg-1 and pg-2 made on Cloud SQL', async () => {
        const made = await ctx.db.select().from(postgres);
        return made.length === 2 &&
          made.every(
            (row) => row.cloudSqlEndpoint && row.applicationStatus === 'done',
          )
          ? made
          : null;
      });
      const pg1 = rows.find((row) => row.configName === 'pg-1')!;
      const pg2 = rows.find((row) => row.configName === 'pg-2')!;
      // Each create's run has ended, so none writes its status after the Stop.
      await runsOf(pg1.postgresId, 1);
      await runsOf(pg2.postgresId, 1);
      expect((await post('postgres', pg1.postgresId, 'stop')).status).toBe(200);
      ctx.google.calls.length = 0;
      return { pg1, pg2 };
    }

    it('counts no change for a stopped instance, and its Apply does not start it', async () => {
      const { pg1, pg2 } = await twoMadeAndOneStopped();
      ctx.google.replayPlanFor('postgres', 'postgres-change');

      const read = await planned(
        PG_ONLY({ 'pg-1': 'small', 'pg-2': 'medium' }),
      );

      // Stop is no change: only pg-2's size moved.
      expect(
        read.steps
          .filter((step) => step.configName !== undefined)
          .map((step) => [step.action, step.configName, step.blocked]),
      ).toEqual([['change', 'pg-2', undefined]]);
      const res = await apply(read.planId);
      expect(res.status).toBe(200);
      const row = await settled(read.planId);
      expect(row.results).toEqual([
        expect.objectContaining({ configName: 'pg-2', status: 'applied' }),
      ]);
      await runsOf(pg2.postgresId, 2);

      // Cloudgate never starts a database by itself.
      expect(activationCalls()).toEqual([]);
      expect(await rowOf(pg1.postgresId)).toMatchObject({
        applicationStatus: 'stopped',
        restartsAt: null,
      });
    });

    it('blocks a change to a stopped instance with its Config name, and applies the rest', async () => {
      const { pg1, pg2 } = await twoMadeAndOneStopped();
      ctx.google.replayPlanFor('postgres', 'postgres-change');

      const read = await planned(
        PG_ONLY({ 'pg-1': 'medium', 'pg-2': 'medium' }),
      );

      expect(
        read.steps
          .filter((step) => step.configName !== undefined)
          .map((step) => [step.action, step.configName, step.blocked]),
      ).toEqual([
        ['change', 'pg-1', 'pg-1 is stopped. Start it first.'],
        ['change', 'pg-2', undefined],
      ]);
      const res = await apply(read.planId);
      expect(res.status).toBe(200);
      const row = await settled(read.planId);
      expect(row.status).toBe('partly-applied');
      expect(row.results).toEqual([
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
        }),
      ]);
      const [, change] = await runsOf(pg2.postgresId, 2);
      expect(change.status).toBe('done');

      // pg-1 was never run, and never started.
      expect(activationCalls()).toEqual([]);
      expect(
        await ctx.db
          .select()
          .from(deployment)
          .where(eq(deployment.postgresId, pg1.postgresId)),
      ).toHaveLength(1);
      expect(await rowOf(pg1.postgresId)).toMatchObject({
        applicationStatus: 'stopped',
        instanceClass: pg1.instanceClass,
      });
    });
  });
});
