// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first load.
import { useHostedMode } from '../utils/hosted-mode';
useHostedMode();

import request from 'supertest';
import { App } from 'supertest/types';

import { BucketsService } from '../../src/buckets/buckets.service';
import {
  application,
  bucket,
  cloudAccount,
  compose,
  environment,
  libsql,
  mariadb,
  mongo,
  mysql,
  postgres,
  redis,
  server,
  webServerSettings,
} from '../../src/db/schema';
import type { DeploymentJob } from '../../src/deployment-queue/job-types';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import type {
  QueuedJob,
  QueuePort,
} from '../../src/deployment-queue/queue.port';
import { STACK_VM_TAKES_NO_SERVER } from '../../src/compose/compose.service';
import { CLOUD_TARGET_NEEDS_SERVER } from '../../src/environments/deploy-target';
import { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import {
  PLATFORM_HOST_REFUSALS,
  PLATFORM_HOST_REFUSED_CODE,
} from '../../src/instance-mode/platform-host-refusal';
import type { PermissionCtx } from '../../src/rbac/permission.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { HOSTED_STAFF, openHostedSignUp } from '../utils/hosted-sign-up';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(180_000);

const PLATFORM_HOST = { kind: 'platform-host' };

/** A Cloud account target, written straight to the row: no account is read. */
const IN_CLOUD = {
  kind: 'cloud',
  cloudAccountId: 'ca_unlisted',
  region: 'eu-west-1',
};

/** The 400 every platform-host refusal of a Service says. */
const REFUSED = {
  statusCode: 400,
  code: PLATFORM_HOST_REFUSED_CODE,
  message: PLATFORM_HOST_REFUSALS.services,
};

/** Each create route and the least body it takes, beside `name` and `environmentId`. */
const CREATES: readonly (readonly [string, Record<string, unknown>])[] = [
  ['/applications', {}],
  ['/applications', { aiModel: { runtime: 'ollama', model: 'llama3.2:1b' } }],
  ['/compose', {}],
  ['/postgres', { databaseName: 'shop', databaseUser: 'shop_user' }],
  ['/mysql', { databaseName: 'shop', databaseUser: 'shop_user' }],
  ['/mariadb', { databaseName: 'shop', databaseUser: 'shop_user' }],
  ['/mongo', { databaseUser: 'shop_user' }],
  ['/redis', {}],
  ['/libsql', { databaseUser: 'shop_user' }],
];

const label = ([path, body]: readonly [string, Record<string, unknown>]) =>
  'aiModel' in body ? '/applications (AI model)' : path;

/**
 * The creates that ask for a Server in a cloud Environment. A Compose stack
 * there asks for none: it runs on its own Stack VM (ADR-0070, #1372), held
 * by its own tests below.
 */
const ASK_IN_CLOUD = CREATES.filter(([path]) => path !== '/compose');

const BUCKET = `version: 1
services:
  uploads:
    kind: bucket
`;

/** Takes the Apply's builds and runs none. */
class ListQueue implements QueuePort {
  jobs: QueuedJob[] = [];

  add(data: DeploymentJob): Promise<QueuedJob> {
    const job: QueuedJob = {
      id: `job-${this.jobs.length + 1}`,
      data,
      state: 'waiting',
    };
    this.jobs.push(job);
    return Promise.resolve({ ...job });
  }

  getJobs(): Promise<QueuedJob[]> {
    return Promise.resolve([...this.jobs]);
  }

  cancel(): Promise<boolean> {
    return Promise.resolve(false);
  }

  clearWaiting(): Promise<QueuedJob[]> {
    return Promise.resolve([]);
  }
}

/**
 * On the Hosted instance no Service is created on the platform host
 * (ADR-0053 seam 3): an Application, an AI model, a Compose stack,
 * each of the six database engines and a Bucket whose create names no Server
 * or names the platform host (`serverId: null`) is refused with
 * `PLATFORM_HOST_REFUSED` and the Services sentence, whatever the
 * Environment's Deploy target, and nothing is written. A console Application
 * in a cloud Environment never lands on the host. The host's GPU counts,
 * which only a create form on the host reads, are refused the same.
 *
 * The Self-hosted counterparts at the end turn `isHosted` off on the same
 * app: there, ADR-0008's branch puts each of them on the platform host as
 * before. In a cloud Environment a create that leaves the Server out is asked
 * for one instead; naming the platform host or a Server is kept.
 */
describe('Service creates on the platform host, Hosted instance (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let userId: string;
  let projectId: string;

  const queue = new ListQueue();
  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  };
  const succeeds = (command: string) =>
    Promise.resolve(
      isPresenceProbe(command)
        ? { stdout: 'absent', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0 },
    );

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: DEPLOYMENT_QUEUE, useValue: queue },
        { provide: RemoteExecService, useValue: execMock },
      ],
    });
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    jest.restoreAllMocks();
    queue.jobs = [];
    execMock.execAsync.mockReset().mockImplementation(succeeds);
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_serverId: string, command: string) =>
        succeeds(command),
      );

    await openHostedSignUp(ctx.db);
    const res = await request(http)
      .post('/api/auth/sign-in/email')
      .send({ email: HOSTED_STAFF.email, password: HOSTED_STAFF.password });
    expect(res.status).toBe(200);
    userId = (res.body as { user: { id: string } }).user.id;
    cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const orgs = await request(http)
      .get('/organizations')
      .set('Cookie', cookie);
    organizationId = (orgs.body as { id: string }[])[0].id;

    const project = await request(http)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'shop' });
    expect(project.status).toBe(201);
    projectId = (project.body as { projectId: string }).projectId;
  });

  const givenSelfHostedInstance = () =>
    jest
      .spyOn(ctx.app.get(InstanceMode), 'isHosted', 'get')
      .mockReturnValue(false);

  async function addServer(name: string): Promise<string> {
    const [row] = await ctx.db
      .insert(server)
      .values({ name, ipAddress: '203.0.113.5', port: 22, organizationId })
      .returning();
    return row.serverId;
  }

  /** An Environment written straight to its row, its Deploy target as given. */
  async function environmentRow(
    name: string,
    deployTarget: Record<string, unknown>,
  ): Promise<string> {
    const [row] = await ctx.db
      .insert(environment)
      .values({ name, projectId, deployTarget: deployTarget as never })
      .returning();
    return row.environmentId;
  }

  /** An Environment on one of the Organization's own Servers. */
  async function serverEnvironment(): Promise<string> {
    const serverId = await addServer('worker-1');
    return environmentRow('production', { kind: 'server', serverId });
  }

  const create = (path: string, body: Record<string, unknown>) =>
    request(http)
      .post(path)
      .set('Cookie', cookie)
      .send({ name: 'svc', ...body });

  /** Every Service row, all kinds together: none is expected after a refusal. */
  async function serviceRows(): Promise<unknown[]> {
    const tables = [
      application,
      compose,
      postgres,
      mysql,
      mariadb,
      mongo,
      redis,
      libsql,
      bucket,
    ] as const;
    const rows = await Promise.all(
      tables.map((table) => ctx.db.select().from(table)),
    );
    return rows.flat();
  }

  const asCaller = (): PermissionCtx => ({
    user: { id: userId },
    session: { activeOrganizationId: organizationId },
  });

  async function planFor(environmentId: string, text: string) {
    const saved = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });
    expect(saved.status).toBe(201);
    const plans = (
      saved.body as { plans: { planId: string; environmentId: string }[] }
    ).plans;
    const found = plans.find((one) => one.environmentId === environmentId);
    expect(found).toBeDefined();
    return found!.planId;
  }

  describe.each(CREATES.map((entry) => [label(entry), entry] as const))(
    '%s',
    (_name, [path, body]) => {
      it('is refused the platform host by name in an Environment on a Server', async () => {
        const environmentId = await serverEnvironment();

        const refused = await create(path, {
          ...body,
          environmentId,
          serverId: null,
        });

        expect(refused.status).toBe(400);
        expect(refused.body).toMatchObject(REFUSED);
        expect(await serviceRows()).toEqual([]);
      });

      it('is refused in a platform-host Environment from before hosted mode, and nothing is created', async () => {
        const environmentId = await environmentRow('legacy', PLATFORM_HOST);

        for (const serverId of [undefined, null]) {
          const refused = await create(path, {
            ...body,
            environmentId,
            ...(serverId === null ? { serverId } : {}),
          });
          expect(refused.status).toBe(400);
          expect(refused.body).toMatchObject(REFUSED);
        }
        expect(await serviceRows()).toEqual([]);
      });
    },
  );

  /** A Cloud account of the Organization's, enough for a Stack VM's settings. */
  async function cloudAccountRow(): Promise<string> {
    const [row] = await ctx.db
      .insert(cloudAccount)
      .values({
        organizationId,
        name: 'Production AWS',
        cloud: 'aws',
        cloudId: '123456789012',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        deployRoleArn: 'arn:aws:iam::123456789012:role/cloudgate-deploy',
        taskExecutionRoleArn:
          'arn:aws:iam::123456789012:role/cloudgate-task-execution',
        externalId: 'external-id-made-by-cloudgate',
        policyVersion: 1,
        lastCheckedAt: new Date().toISOString(),
        lastCheckResult: 'passed',
      })
      .returning();
    return row.cloudAccountId;
  }

  /**
   * A console Compose stack in a cloud Environment runs on its own Stack VM
   * (ADR-0070, #1372), so it never lands on the platform host on either
   * instance: one that names it is refused, with ADR-0053's sentence on the
   * Hosted instance, and one that leaves the Server out gets its Stack VM.
   */
  describe('/compose in a cloud Environment', () => {
    it.each([
      ['the Hosted instance', REFUSED],
      [
        'a Self-hosted instance',
        { statusCode: 400, message: STACK_VM_TAKES_NO_SERVER },
      ],
    ] as const)(
      'refuses the platform host named on %s, and writes nothing',
      async (instance, refusal) => {
        if (instance !== 'the Hosted instance') givenSelfHostedInstance();
        const environmentId = await environmentRow('cloud', {
          ...IN_CLOUD,
          cloudAccountId: await cloudAccountRow(),
        });

        const refused = await create('/compose', {
          environmentId,
          serverId: null,
        });

        expect(refused.status).toBe(400);
        expect(refused.body).toMatchObject(refusal);
        expect(await serviceRows()).toEqual([]);
      },
    );

    it.each(['the Hosted instance', 'a Self-hosted instance'])(
      'puts a stack that names no Server on its own Stack VM on %s, never the platform host',
      async (instance) => {
        if (instance !== 'the Hosted instance') givenSelfHostedInstance();
        const cloudAccountId = await cloudAccountRow();
        const environmentId = await environmentRow('cloud', {
          ...IN_CLOUD,
          cloudAccountId,
        });

        const created = await create('/compose', { environmentId });

        expect(created.status).toBe(201);
        expect(created.body).toMatchObject({
          serverId: null,
          cloudAccountId,
          region: IN_CLOUD.region,
        });
      },
    );

    it('refuses a named Server too, and writes nothing', async () => {
      givenSelfHostedInstance();
      const environmentId = await environmentRow('cloud', {
        ...IN_CLOUD,
        cloudAccountId: await cloudAccountRow(),
      });

      const refused = await create('/compose', {
        environmentId,
        serverId: await addServer('worker-1'),
      });

      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({
        message: STACK_VM_TAKES_NO_SERVER,
      });
      expect(await serviceRows()).toEqual([]);
    });
  });

  it.each(ASK_IN_CLOUD.map((entry) => [label(entry), entry] as const))(
    'never lands a console %s in a cloud Environment on the platform host: refused with ADR-0053 sentence whether it names no Server or the platform host',
    async (_name, [path, body]) => {
      const environmentId = await environmentRow('cloud', IN_CLOUD);

      for (const named of [{}, { serverId: null }]) {
        const refused = await create(path, {
          ...body,
          environmentId,
          ...named,
        });
        expect(refused.status).toBe(400);
        expect(refused.body).toMatchObject(REFUSED);
      }
      expect(await serviceRows()).toEqual([]);
    },
  );

  it('refuses a Bucket on the platform host: its Apply onto a platform-host Environment, and a create naming no Server and no Cloud account', async () => {
    await ctx.db.insert(webServerSettings).values({ serverIp: '198.51.100.7' });
    const environmentId = await environmentRow('legacy', PLATFORM_HOST);
    const planId = await planFor(environmentId, BUCKET);

    const applied = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId });
    expect(applied.status).toBe(400);
    expect(applied.body).toMatchObject(REFUSED);

    // The create itself, as an Apply reaches it, refuses the host too.
    const onServer = await serverEnvironment();
    await expect(
      ctx.app
        .get(BucketsService)
        .create(
          asCaller(),
          { environmentId: onServer, name: 'uploads', serverId: null },
          { configName: 'uploads', bucketName: 'cg-uploads-1' },
        ),
    ).rejects.toMatchObject({
      response: { code: REFUSED.code, message: REFUSED.message },
    });
    expect(await ctx.db.select().from(bucket)).toEqual([]);
  });

  it("refuses the platform host's GPU counts, and reads a Server's", async () => {
    const serverId = await addServer('gpu-1');

    const host = await request(http)
      .get('/settings/gpu/counts')
      .set('Cookie', cookie);
    const own = await request(http)
      .get('/settings/gpu/counts')
      .query({ serverId })
      .set('Cookie', cookie);

    expect(host.status).toBe(400);
    expect(host.body).toMatchObject(REFUSED);
    expect(execMock.execAsync).not.toHaveBeenCalled();
    expect(own.status).toBe(200);
  });

  describe('on a Self-hosted instance (counterpart)', () => {
    it.each(CREATES.map((entry) => [label(entry), entry] as const))(
      'puts %s with no Server on the platform host, as ADR-0008 says',
      async (_name, [path, body]) => {
        givenSelfHostedInstance();
        const environmentId = await environmentRow('legacy', PLATFORM_HOST);

        const created = await create(path, {
          ...body,
          environmentId,
          serverId: null,
        });

        expect(created.status).toBe(201);
        expect(created.body).toMatchObject({ serverId: null });
      },
    );

    describe.each(ASK_IN_CLOUD.map((entry) => [label(entry), entry] as const))(
      '%s in a cloud Environment',
      (_name, [path, body]) => {
        it('asks for a Server when the body leaves it out, and writes nothing', async () => {
          givenSelfHostedInstance();
          const environmentId = await environmentRow('cloud', IN_CLOUD);

          const refused = await create(path, { ...body, environmentId });

          expect(refused.status).toBe(400);
          expect(refused.body).toMatchObject({
            statusCode: 400,
            message: CLOUD_TARGET_NEEDS_SERVER,
          });
          expect(await serviceRows()).toEqual([]);
        });

        it('keeps the platform host chosen on purpose, or a named Server', async () => {
          givenSelfHostedInstance();
          const environmentId = await environmentRow('cloud', IN_CLOUD);
          const serverId = await addServer('worker-1');

          const onHost = await create(path, {
            ...body,
            environmentId,
            serverId: null,
          });
          const onServer = await create(path, {
            ...body,
            name: 'svc-2',
            environmentId,
            serverId,
          });

          expect(onHost.status).toBe(201);
          expect(onHost.body).toMatchObject({ serverId: null });
          expect(onServer.status).toBe(201);
          expect(onServer.body).toMatchObject({ serverId });
        });
      },
    );

    it('asks an AI deploy that leaves the Server out of a cloud Environment for one, and writes nothing', async () => {
      givenSelfHostedInstance();
      const environmentId = await environmentRow('cloud', IN_CLOUD);

      const refused = await request(http)
        .post('/ai/deploy')
        .set('Cookie', cookie)
        .send({
          environmentId,
          id: 'whoami',
          dockerCompose:
            'services:\n  whoami:\n    image: traefik/whoami:v1.10\n',
          envVariables: '',
          name: 'whoami',
          description: 'echoes requests',
        });

      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({
        statusCode: 400,
        message: CLOUD_TARGET_NEEDS_SERVER,
      });
      expect(await ctx.db.select().from(compose)).toEqual([]);
    });

    it('puts a Bucket with no Server and no Cloud account on the platform host', async () => {
      givenSelfHostedInstance();
      const environmentId = await environmentRow('legacy', PLATFORM_HOST);

      await ctx.app
        .get(BucketsService)
        .create(
          asCaller(),
          { environmentId, name: 'uploads', serverId: null },
          { configName: 'uploads', bucketName: 'cg-uploads-1' },
        );

      const rows = await ctx.db
        .select({ serverId: bucket.serverId })
        .from(bucket);
      expect(rows).toEqual([{ serverId: null }]);
    });

    it("reads the platform host's GPU counts", async () => {
      givenSelfHostedInstance();

      const host = await request(http)
        .get('/settings/gpu/counts')
        .set('Cookie', cookie);

      expect(host.status).toBe(200);
      expect(execMock.execAsync).toHaveBeenCalled();
    });
  });
});
