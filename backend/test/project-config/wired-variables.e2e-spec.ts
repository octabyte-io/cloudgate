import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { ApplicationsService } from '../../src/applications/applications.service';
import {
  application,
  mysql,
  postgres,
  redis,
  server as serverTable,
} from '../../src/db/schema';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import type { DeploymentJob } from '../../src/deployment-queue/job-types';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import type {
  JobState,
  QueuedJob,
  QueuePort,
} from '../../src/deployment-queue/queue.port';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

interface PlanBody {
  planId: string;
  environmentId: string;
  steps: {
    action: string;
    configName: string;
    fields?: { field: string; from: unknown; to: unknown }[];
  }[];
  notes?: { kind: string; variable?: string }[];
  results: { configName: string; status: string; message: string | null }[];
}

/** The deployment queue as a list: a queued job is asserted, never run. */
class ListQueue implements QueuePort {
  jobs: QueuedJob[] = [];
  private next = 0;

  add(data: DeploymentJob): Promise<QueuedJob> {
    const job: QueuedJob = { id: `job-${++this.next}`, data, state: 'waiting' };
    this.jobs.push(job);
    return Promise.resolve({ ...job });
  }

  getJobs(states?: JobState[]): Promise<QueuedJob[]> {
    return Promise.resolve(
      this.jobs.filter((job) => !states || states.includes(job.state)),
    );
  }

  cancel(): Promise<boolean> {
    return Promise.resolve(false);
  }

  clearWaiting(): Promise<QueuedJob[]> {
    return Promise.resolve([]);
  }
}

/** Polls until the condition holds (a database deploy runs after the Apply answers). */
async function waitFor(condition: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Wired variables on a Server (ADR-0031): a config whose `web` links
 * to `pg-1.url` and `redis.url` plans, applies and deploys, and the faked
 * engine is handed both URLs in the Server forms. The value is built at the
 * deploy and never saved on `web`'s row nor shown by the API; a link the
 * plan cannot honour refuses it, and a typed value for a linked name is
 * refused. The Swarm and the machine are the boundaries.
 */
describe('Wired variables on a Server (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let projectId: string;
  let serverId: string;
  let environmentId: string;

  const queue = new ListQueue();
  const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
  const machine = (command: string) =>
    Promise.resolve(isPresenceProbe(command) ? ok('absent') : ok());
  const execMock = withArgvExec({
    execAsync: jest.fn<Promise<ExecResult>, [string, unknown?]>(),
    execAsyncRemote: jest.fn<Promise<ExecResult>, [string, string]>(),
  });
  const dockerService = { inspect: jest.fn(), update: jest.fn() };
  const docker = {
    getService: jest.fn(() => dockerService),
    createService: jest.fn(),
    listTasks: jest.fn(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: DEPLOYMENT_QUEUE, useValue: queue },
        { provide: RemoteExecService, useValue: execMock },
        {
          provide: RemoteDockerFactory,
          useValue: { getRemoteDocker: jest.fn().mockResolvedValue(docker) },
        },
      ],
    });
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    queue.jobs = [];
    execMock.execAsync.mockReset().mockImplementation(machine);
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_serverId, command) => machine(command));
    dockerService.inspect
      .mockReset()
      .mockRejectedValue(new Error('no such service'));
    dockerService.update.mockReset().mockResolvedValue(undefined);
    docker.createService.mockReset().mockResolvedValue(undefined);
    docker.listTasks
      .mockReset()
      .mockResolvedValue([
        { Status: { State: 'running', Timestamp: '2026-10-17T00:00:00Z' } },
      ]);

    const res = await request(http).post('/api/auth/sign-up/email').send({
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
    });
    expect(res.status).toBe(200);
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

    serverId = await addServer('worker', '203.0.113.10');
    environmentId = await createEnvironment('production', serverId);
  });

  async function addServer(name: string, ipAddress: string) {
    const [row] = await ctx.db
      .insert(serverTable)
      .values({
        name,
        ipAddress,
        port: 22,
        serverType: 'deploy',
        organizationId,
      })
      .returning();
    return row.serverId;
  }

  async function createEnvironment(name: string, onServer: string) {
    const created = await request(http)
      .post('/environments')
      .set('Cookie', cookie)
      .send({
        name,
        projectId,
        deployTarget: { kind: 'server', serverId: onServer },
      });
    expect(created.status).toBe(201);
    return (created.body as { environmentId: string }).environmentId;
  }

  const save = (text: string) =>
    request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });

  async function planFor(text: string) {
    const saved = await save(text);
    expect(saved.status).toBe(201);
    const plans = (saved.body as { plans: PlanBody[] }).plans;
    const found = plans.find((plan) => plan.environmentId === environmentId);
    expect(found).toBeDefined();
    return found as PlanBody;
  }

  async function applyPlan(text: string) {
    const open = await planFor(text);
    const applied = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: open.planId });
    expect(applied.status).toBe(200);
    const results = (applied.body as PlanBody).results;
    expect(results.filter((result) => result.status !== 'applied')).toEqual([]);
    // A database's deploy runs after the Apply answers; let it settle so
    // the last Swarm spec read below is `web`'s.
    await waitFor(async () => {
      const rows = [
        ...(await ctx.db.select().from(postgres)),
        ...(await ctx.db.select().from(mysql)),
        ...(await ctx.db.select().from(redis)),
      ];
      return rows.every((row) => row.applicationStatus !== 'running');
    });
    return open;
  }

  async function webRow() {
    const [row] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.configName, 'web'));
    return row;
  }

  /** Deploys `web` through the real engine, as the queue processor would. */
  async function deployWeb(): Promise<string[]> {
    const { applicationId, appName } = await webRow();
    const deployable = await ctx.app
      .get(ApplicationsService)
      .findDeployable(applicationId);
    await ctx.app.get(DeploymentEngineService).deploy(deployable);
    const call = docker.createService.mock.calls
      .map((args: unknown[]) => args[args.length - 1])
      .filter((settings) => (settings as { Name: string }).Name === appName)
      .pop() as { TaskTemplate: { ContainerSpec: { Env: string[] } } };
    return call.TaskTemplate.ContainerSpec.Env;
  }

  const STACK = (webEnv: string) => `version: 1
services:
  web:
    kind: web
    source:
      image: nginx:1.27
    env: ${webEnv}
  pg-1:
    kind: postgres
    database: shop
    user: shop
  redis:
    kind: redis
`;

  const LINKED = STACK(
    '[NODE_ENV, { DATABASE_URL: pg-1.url }, { REDIS_URL: redis.url }, { DB_HOST: pg-1.host }, { DB_PORT: pg-1.port }, { DB_USER: pg-1.user }, { DB_PASSWORD: pg-1.password }, { DB_NAME: pg-1.database }]',
  );

  it('plans, applies and deploys web with both URLs in its Env, saved nowhere', async () => {
    const open = await applyPlan(LINKED);
    const webStep = open.steps.find((step) => step.configName === 'web');
    expect(webStep?.fields).toEqual(
      expect.arrayContaining([
        { field: 'env.DATABASE_URL', from: null, to: 'pg-1.url' },
        { field: 'env.REDIS_URL', from: null, to: 'redis.url' },
      ]),
    );

    const [pg] = await ctx.db.select().from(postgres);
    const [cache] = await ctx.db.select().from(redis);
    const env = await deployWeb();

    expect(env).toEqual(
      expect.arrayContaining([
        `DATABASE_URL=postgresql://shop:${encodeURIComponent(pg.databasePassword)}@${pg.appName}:5432/shop`,
        `REDIS_URL=redis://default:${encodeURIComponent(cache.databasePassword)}@${cache.appName}:6379`,
        `DB_HOST=${pg.appName}`,
        'DB_PORT=5432',
        'DB_USER=shop',
        `DB_PASSWORD=${pg.databasePassword}`,
        'DB_NAME=shop',
      ]),
    );

    // On the row: the links, never a value.
    const row = await webRow();
    expect(row.configLinks).toEqual({
      DATABASE_URL: { source: 'pg-1', output: 'url' },
      REDIS_URL: { source: 'redis', output: 'url' },
      DB_HOST: { source: 'pg-1', output: 'host' },
      DB_PORT: { source: 'pg-1', output: 'port' },
      DB_USER: { source: 'pg-1', output: 'user' },
      DB_PASSWORD: { source: 'pg-1', output: 'password' },
      DB_NAME: { source: 'pg-1', output: 'database' },
    });
    expect(JSON.stringify(row)).not.toContain(pg.databasePassword);
    expect(JSON.stringify(row)).not.toContain(cache.databasePassword);

    // Through the API: the variable reads as a link to pg-1.url.
    const read = await request(http)
      .get(`/applications/${row.applicationId}`)
      .set('Cookie', cookie);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      configLinks: { DATABASE_URL: { source: 'pg-1', output: 'url' } },
    });
    expect(JSON.stringify(read.body)).not.toContain(pg.databasePassword);
    expect(JSON.stringify(read.body)).not.toContain(cache.databasePassword);
  });

  it('has nothing to change on the next plan of the same config', async () => {
    await applyPlan(LINKED);
    const again = await save(LINKED);
    expect(again.status).toBe(201);
    expect((again.body as { stored: boolean }).stored).toBe(true);
  });

  it('refuses a plan whose link names a source on another Server', async () => {
    await applyPlan(STACK('[]'));
    const other = await addServer('other', '203.0.113.11');
    const [pg] = await ctx.db.select().from(postgres);
    await ctx.db
      .update(postgres)
      .set({ serverId: other })
      .where(eq(postgres.postgresId, pg.postgresId));

    const refused = await save(STACK('[{ DATABASE_URL: pg-1.url }]'));
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'PLAN_REFUSED' });
    expect((refused.body as { message: string }).message).toContain(
      'web.env.DATABASE_URL links to pg-1.url',
    );
  });

  it('refuses a plan whose link names a missing source or an unknown Output', async () => {
    const missing = await save(STACK('[{ DATABASE_URL: pg-2.url }]'));
    expect(missing.status).toBe(409);
    expect((missing.body as { message: string }).message).toContain(
      'web.env.DATABASE_URL links to pg-2.url, but this config has no Service pg-2',
    );

    const ca = await save(STACK('[{ PGSSLROOTCERT: pg-1.ca }]'));
    expect(ca.status).toBe(409);
    expect((ca.body as { message: string }).message).toContain(
      'web.env.PGSSLROOTCERT links to pg-1.ca',
    );
  });

  const MYSQL = (webEnv: string) => `version: 1
services:
  web:
    kind: web
    source:
      image: nginx:1.27
    env: ${webEnv}
  my-1:
    kind: mysql
    database: shop
    user: shop
`;

  it("plans, applies and deploys web with a mysql's url in its Env, reached at its Service name", async () => {
    const open = await applyPlan(
      MYSQL(
        '[{ DATABASE_URL: my-1.url }, { DB_HOST: my-1.host }, { DB_PORT: my-1.port }, { DB_USER: my-1.user }, { DB_PASSWORD: my-1.password }, { DB_NAME: my-1.database }]',
      ),
    );
    expect(
      open.steps.find((step) => step.configName === 'web')?.fields,
    ).toEqual(
      expect.arrayContaining([
        { field: 'env.DATABASE_URL', from: null, to: 'my-1.url' },
      ]),
    );

    const [my] = await ctx.db.select().from(mysql);
    const env = await deployWeb();
    expect(env).toEqual(
      expect.arrayContaining([
        `DATABASE_URL=mysql://shop:${encodeURIComponent(my.databasePassword)}@${my.appName}:3306/shop`,
        `DB_HOST=${my.appName}`,
        'DB_PORT=3306',
        'DB_USER=shop',
        `DB_PASSWORD=${my.databasePassword}`,
        'DB_NAME=shop',
      ]),
    );
    expect(JSON.stringify(await webRow())).not.toContain(my.databasePassword);
  });

  it("refuses a link to a mysql's ca on a Server, as for a postgres's", async () => {
    const ca = await save(MYSQL('[{ MYSQL_CA: my-1.ca }]'));
    expect(ca.status).toBe(409);
    expect(ca.body).toMatchObject({ code: 'PLAN_REFUSED' });
    expect((ca.body as { message: string }).message).toContain(
      'web.env.MYSQL_CA links to my-1.ca, but a mysql',
    );
    expect((ca.body as { message: string }).message).toContain(
      'hands out no ca; it hands out url, host, port, user, password, database',
    );
  });

  it('drops a typed value when a link takes its name, and refuses typing one afterwards', async () => {
    await applyPlan(STACK('[NODE_ENV, DATABASE_URL]'));
    const { applicationId } = await webRow();
    const typed = await request(http)
      .patch(`/applications/${applicationId}/environment`)
      .set('Cookie', cookie)
      .send({ env: 'NODE_ENV=production\nDATABASE_URL=postgres://by-hand' });
    expect(typed.status).toBe(200);

    const open = await applyPlan(
      STACK('[NODE_ENV, { DATABASE_URL: pg-1.url }]'),
    );
    expect(
      open.steps.find((step) => step.configName === 'web')?.fields,
    ).toEqual(
      expect.arrayContaining([
        { field: 'env.DATABASE_URL', from: 'typed value', to: 'pg-1.url' },
      ]),
    );
    const row = await webRow();
    expect(row.env).toBe('NODE_ENV=production');
    expect(row.configLinks).toEqual({
      DATABASE_URL: { source: 'pg-1', output: 'url' },
    });

    for (const route of [
      { path: `/applications/${applicationId}/environment`, body: {} },
      { path: `/applications/${applicationId}`, body: {} },
    ]) {
      const refused = await request(http)
        .patch(route.path)
        .set('Cookie', cookie)
        .send({ ...route.body, env: 'DATABASE_URL=postgres://again' });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'VARIABLE_IS_LINKED' });
      expect((refused.body as { message: string }).message).toContain(
        'DATABASE_URL is linked to pg-1.url',
      );
    }
    expect((await webRow()).env).toBe('NODE_ENV=production');

    // A name the config does not link still takes a value.
    const fine = await request(http)
      .patch(`/applications/${applicationId}/environment`)
      .set('Cookie', cookie)
      .send({ env: 'NODE_ENV=staging' });
    expect(fine.status).toBe(200);
  });

  it('refuses typing a value for a name a database links', async () => {
    await applyPlan(`version: 1
services:
  pg-1:
    kind: postgres
    env: [{ CACHE_URL: redis.url }]
  redis:
    kind: redis
`);
    const [pg] = await ctx.db.select().from(postgres);
    const refused = await request(http)
      .patch(`/postgres/${pg.postgresId}/environment`)
      .set('Cookie', cookie)
      .send({ env: 'CACHE_URL=redis://by-hand' });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'VARIABLE_IS_LINKED' });
  });
});
