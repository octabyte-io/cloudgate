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
  results: {
    action: string;
    configName: string;
    status: string;
    message: string | null;
  }[];
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
 * Links shape the Apply on a Server (ADR-0031): a source's step runs
 * before what links to it, an Apply that changes an Output redeploys what
 * links to it after the source, a rename moves the link before the old
 * source goes, a source is not deleted while linked, and a login edited in
 * the console marks the linked Service "deploy to pick up the new value"
 * without deploying it. The Swarm and the machine are the boundaries.
 */
describe('Wired variables shape the Apply (e2e)', () => {
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

  /** Applies an open plan, confirming the destroys named, and answers its results. */
  async function applyOpen(planId: string, confirmDestroy: string[] = []) {
    const applied = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId, confirmDestroy });
    expect(applied.status).toBe(200);
    const results = (applied.body as PlanBody).results;
    await waitFor(async () => {
      const rows = [
        ...(await ctx.db.select().from(postgres)),
        ...(await ctx.db.select().from(mysql)),
        ...(await ctx.db.select().from(redis)),
      ];
      return rows.every((row) => row.applicationStatus !== 'running');
    });
    return results;
  }

  type Step = PlanBody['steps'][number] & { because?: string[] };

  const order = (steps: readonly { action: string; configName: string }[]) =>
    steps.map((step) => `${step.action} ${step.configName}`);

  /** The Deployments queued for `web`, oldest first. */
  async function webJobs() {
    const { applicationId } = await webRow();
    return queue.jobs.filter(
      (job) =>
        'applicationId' in job.data && job.data.applicationId === applicationId,
    );
  }

  // `web` is listed first, so only the link puts `pg-1` before it.
  const STACK = (webEnv: string, pg = '  pg-1:\n    kind: postgres\n') =>
    `version: 1
services:
  web:
    kind: web
    source:
      image: nginx:1.27
    env: ${webEnv}
${pg}`;

  const LINKED = STACK('[{ DATABASE_URL: pg-1.url }]');

  it("runs pg-1's step before web's, in the plan and in the Apply", async () => {
    const open = await planFor(LINKED);
    expect(order(open.steps)).toEqual(['create pg-1', 'create web']);

    const results = await applyOpen(open.planId);
    expect(order(results)).toEqual(['create pg-1', 'create web']);
    expect(results.every((result) => result.status === 'applied')).toBe(true);
    expect(await webJobs()).toHaveLength(1);
  });

  it('redeploys web after pg-1 when an Apply changes what pg-1.url is built from', async () => {
    await applyPlan(
      STACK('[{ DATABASE_URL: pg-1.url }, { DB_HOST: pg-1.host }]'),
    );
    queue.jobs = [];

    const open = await planFor(
      STACK(
        '[{ DATABASE_URL: pg-1.url }, { DB_HOST: pg-1.host }]',
        '  pg-1:\n    kind: postgres\n    user: shop\n',
      ),
    );
    expect(order(open.steps)).toEqual(['change pg-1', 'redeploy web']);
    expect((open.steps[1] as Step).because).toEqual(['pg-1.url']);

    const results = await applyOpen(open.planId);
    expect(order(results)).toEqual(['change pg-1', 'redeploy web']);
    expect(results.every((result) => result.status === 'applied')).toBe(true);
    expect(await webJobs()).toHaveLength(1);

    // Nothing left: the redeploy was this plan's, not a standing difference.
    const again = await save(
      STACK(
        '[{ DATABASE_URL: pg-1.url }, { DB_HOST: pg-1.host }]',
        '  pg-1:\n    kind: postgres\n    user: shop\n',
      ),
    );
    expect((again.body as { stored: boolean }).stored).toBe(true);
    expect(
      (again.body as { plans: PlanBody[] }).plans.find(
        (plan) => plan.environmentId === environmentId,
      )?.steps ?? [],
    ).toEqual([]);
  });

  it('redeploys web after pg-1 is re-created as another kind', async () => {
    await applyPlan(
      STACK('[{ CACHE_URL: pg-1.url }]', '  pg-1:\n    kind: redis\n'),
    );
    queue.jobs = [];

    const open = await planFor(STACK('[{ CACHE_URL: pg-1.url }]'));
    expect(order(open.steps)).toEqual([
      'destroy pg-1',
      'create pg-1',
      'redeploy web',
    ]);
    expect((open.steps[2] as Step).because).toEqual(['pg-1.url']);

    const results = await applyOpen(open.planId, ['pg-1']);
    expect(order(results)).toEqual([
      'destroy pg-1',
      'create pg-1',
      'redeploy web',
    ]);
    expect(results.filter((result) => result.status !== 'applied')).toEqual([]);
    expect(await ctx.db.select().from(redis)).toHaveLength(0);
    expect(await ctx.db.select().from(postgres)).toHaveLength(1);
    expect(await webJobs()).toHaveLength(1);
  });

  it('renames a linked source as create pg-2, move web to it, destroy pg-1', async () => {
    await applyPlan(LINKED);
    queue.jobs = [];

    const open = await planFor(
      STACK('[{ DATABASE_URL: pg-2.url }]', '  pg-2:\n    kind: postgres\n'),
    );
    expect(order(open.steps)).toEqual([
      'create pg-2',
      'change web',
      'destroy pg-1',
    ]);
    expect(open.steps[1].fields).toEqual([
      { field: 'env.DATABASE_URL', from: 'pg-1.url', to: 'pg-2.url' },
    ]);

    const results = await applyOpen(open.planId, ['pg-1']);
    expect(order(results)).toEqual([
      'create pg-2',
      'change web',
      'destroy pg-1',
    ]);
    // The destroy found nothing linking to pg-1 any more.
    expect(results.filter((result) => result.status !== 'applied')).toEqual([]);
    expect((await webRow()).configLinks).toEqual({
      DATABASE_URL: { source: 'pg-2', output: 'url' },
    });
    const rows = await ctx.db
      .select({ configName: postgres.configName })
      .from(postgres);
    expect(rows).toEqual([{ configName: 'pg-2' }]);
  });

  it('refuses deleting pg-1 while web links to it, naming the link', async () => {
    await applyPlan(LINKED);
    const [pg] = await ctx.db.select().from(postgres);

    const refused = await request(http)
      .delete(`/postgres/${pg.postgresId}`)
      .set('Cookie', cookie);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'SERVICE_IS_LINKED' });
    expect((refused.body as { message: string }).message).toContain(
      'web.env.DATABASE_URL → pg-1.url',
    );
    expect(await ctx.db.select().from(postgres)).toHaveLength(1);
  });

  it('switches a link back to a typed value as a plan change, and drops the link', async () => {
    await applyPlan(STACK('[NODE_ENV, { DATABASE_URL: pg-1.url }]'));

    const open = await planFor(STACK('[NODE_ENV, DATABASE_URL]'));
    expect(
      open.steps.find((step) => step.configName === 'web')?.fields,
    ).toEqual([
      { field: 'env.DATABASE_URL', from: 'pg-1.url', to: 'typed value' },
    ]);
    expect(open.notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'variable-without-value',
          variable: 'DATABASE_URL',
        }),
      ]),
    );
    await applyOpen(open.planId);
    expect((await webRow()).configLinks).toEqual({});
  });

  it("marks web when pg-1's login is edited in the console, deploys nothing, and a deploy of web clears it", async () => {
    await applyPlan(STACK('[{ DATABASE_URL: pg-1.url }]'));
    queue.jobs = [];
    const { applicationId } = await webRow();
    expect((await webRow()).wiredChangedAt).toBeNull();

    const [pg] = await ctx.db.select().from(postgres);
    const edited = await request(http)
      .patch(`/postgres/${pg.postgresId}`)
      .set('Cookie', cookie)
      .send({ databaseUser: 'reader', databasePassword: 'Rotated-Secret-1' });
    expect(edited.status).toBe(200);

    const read = await request(http)
      .get(`/applications/${applicationId}`)
      .set('Cookie', cookie);
    expect(read.status).toBe(200);
    expect(
      (read.body as { wiredChangedAt: string | null }).wiredChangedAt,
    ).toEqual(expect.any(String));
    expect(queue.jobs).toEqual([]);

    const env = await deployWeb();
    expect(env).toEqual(
      expect.arrayContaining([
        `DATABASE_URL=postgresql://reader:Rotated-Secret-1@${pg.appName}:5432/${pg.databaseName}`,
      ]),
    );
    expect((await webRow()).wiredChangedAt).toBeNull();
  });

  it("marks web when a mysql's password is edited in the console, and a deploy of web takes the new one", async () => {
    await applyPlan(
      STACK('[{ DATABASE_URL: my-1.url }]', '  my-1:\n    kind: mysql\n'),
    );
    queue.jobs = [];
    expect((await webRow()).wiredChangedAt).toBeNull();

    const [my] = await ctx.db.select().from(mysql);
    const edited = await request(http)
      .patch(`/mysql/${my.mysqlId}`)
      .set('Cookie', cookie)
      .send({ databasePassword: 'Rotated-Secret-1' });
    expect(edited.status).toBe(200);
    expect((await webRow()).wiredChangedAt).toEqual(expect.any(String));
    expect(queue.jobs).toEqual([]);

    const env = await deployWeb();
    expect(env).toEqual(
      expect.arrayContaining([
        `DATABASE_URL=mysql://${my.databaseUser}:Rotated-Secret-1@${my.appName}:3306/${my.databaseName}`,
      ]),
    );
    expect((await webRow()).wiredChangedAt).toBeNull();
  });

  it('leaves a Service that links only to an Output the edit does not feed unmarked', async () => {
    await applyPlan(STACK('[{ DB_HOST: pg-1.host }]'));
    const [pg] = await ctx.db.select().from(postgres);
    const edited = await request(http)
      .patch(`/postgres/${pg.postgresId}`)
      .set('Cookie', cookie)
      .send({ databasePassword: 'Rotated-Secret-1' });
    expect(edited.status).toBe(200);
    expect((await webRow()).wiredChangedAt).toBeNull();
  });
});
