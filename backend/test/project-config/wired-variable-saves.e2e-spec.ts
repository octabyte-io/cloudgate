import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  application,
  auditLog,
  plan,
  server as serverTable,
} from '../../src/db/schema';
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
  source?: string;
  status?: string;
  steps: {
    action: string;
    configName: string;
    fields?: { field: string; from: unknown; to: unknown }[];
  }[];
  results: { status: string }[];
}

interface LinksView {
  keptIn: string | null;
  editable: boolean;
  links: { name: string; source: string; output: string }[];
  wiredChangedAt: string | null;
  sources: { configName: string; kind: string; outputs: string[] }[];
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

/**
 * A link set in the console (ADR-0031): on a Cloudgate-kept config,
 * picking a source and Output is a console Save — the config's `env` entry
 * and the Service's applied links are written together and recorded as an
 * applied `save` plan whose line reads "typed value → pg-1.url", so the
 * next plan has nothing to change. A link is read without a value, the
 * picker offers what a plan accepts, and a link the plan would refuse is
 * refused with nothing written.
 */
describe('Wired variables saved in the console (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let projectId: string;
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

    const [worker] = await ctx.db
      .insert(serverTable)
      .values({
        name: 'worker',
        ipAddress: '203.0.113.10',
        port: 22,
        serverType: 'deploy',
        organizationId,
      })
      .returning();
    const created = await request(http)
      .post('/environments')
      .set('Cookie', cookie)
      .send({
        name: 'production',
        projectId,
        deployTarget: { kind: 'server', serverId: worker.serverId },
      });
    expect(created.status).toBe(201);
    environmentId = (created.body as { environmentId: string }).environmentId;

    await applyConfig(STACK);
    await request(http)
      .patch(`/applications/${(await webRow()).applicationId}/environment`)
      .set('Cookie', cookie)
      .send({ env: 'NODE_ENV=production\nDATABASE_URL=postgres://typed' })
      .expect(200);
  });

  // `cache` is the console's: no link may name it.
  const STACK = `version: 1
services:
  web:
    kind: web
    source:
      image: nginx:1.27
    env: [NODE_ENV, DATABASE_URL]
  pg-1:
    kind: postgres
  redis:
    kind: redis
`;

  async function applyConfig(text: string) {
    const saved = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });
    expect(saved.status).toBe(201);
    const open = (saved.body as { plans: PlanBody[] }).plans.find(
      (one) => one.environmentId === environmentId,
    )!;
    const applied = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: open.planId });
    expect(applied.status).toBe(200);
    expect(
      (applied.body as PlanBody).results.every(
        (result) => result.status === 'applied',
      ),
    ).toBe(true);
  }

  async function webRow() {
    const [row] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.configName, 'web'));
    return row;
  }

  async function storedText() {
    const config = await request(http)
      .get(`/projects/${projectId}/config`)
      .set('Cookie', cookie);
    expect(config.status).toBe(200);
    return (config.body as { location: { text: string } }).location.text;
  }

  async function links() {
    const { applicationId } = await webRow();
    const res = await request(http)
      .get(`/services/application/${applicationId}/links`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.body as LinksView;
  }

  async function saveLinks(body: object) {
    const { applicationId } = await webRow();
    return request(http)
      .put(`/services/application/${applicationId}/links`)
      .set('Cookie', cookie)
      .send(body);
  }

  async function linked(body: object) {
    const saved = await saveLinks(body);
    expect(saved.status).toBe(200);
    return saved.body as LinksView;
  }

  it("offers each source the plan would accept, with its kind's Outputs", async () => {
    expect(await links()).toEqual({
      serviceType: 'application',
      serviceId: (await webRow()).applicationId,
      configName: 'web',
      keptIn: 'cloudgate',
      editable: true,
      links: [],
      wiredChangedAt: null,
      sources: [
        {
          configName: 'pg-1',
          kind: 'postgres',
          outputs: ['url', 'host', 'port', 'user', 'password', 'database'],
        },
        {
          configName: 'redis',
          kind: 'redis',
          outputs: ['url', 'host', 'port', 'password'],
        },
      ],
    });
  });

  it('saves a link as a console Save: the config entry, the applied plan, and nothing left to change', async () => {
    const saved = await saveLinks({
      links: [{ name: 'DATABASE_URL', source: 'pg-1', output: 'url' }],
    });
    expect(saved.status).toBe(200);
    const view = saved.body as LinksView;
    expect(view.links).toEqual([
      { name: 'DATABASE_URL', source: 'pg-1', output: 'url' },
    ]);
    expect(view.wiredChangedAt).not.toBeNull();

    // The row holds the link and has lost the typed value.
    const row = await webRow();
    expect(row.configLinks).toEqual({
      DATABASE_URL: { source: 'pg-1', output: 'url' },
    });
    expect(row.env).toBe('NODE_ENV=production');

    // The config says it in place of the typed name.
    const text = await storedText();
    expect(text).toContain('DATABASE_URL: pg-1.url');
    expect(text).not.toMatch(/- DATABASE_URL\n/);

    // Recorded as an applied plan whose line reads typed value → link.
    const [recorded] = await ctx.db
      .select()
      .from(plan)
      .where(eq(plan.source, 'save'));
    expect(recorded.status).toBe('applied');
    expect(recorded.steps).toEqual([
      expect.objectContaining({
        action: 'change',
        configName: 'web',
        fields: expect.arrayContaining([
          { field: 'env.DATABASE_URL', from: 'typed value', to: 'pg-1.url' },
        ]) as unknown,
      }),
    ]);
    expect(row.configPlanId).toBe(recorded.planId);

    // Audited as an update of the Service, naming the link and no value; the
    // interceptor's own entries (the set-up's) carry their route instead.
    const audited = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.resourceId, row.applicationId));
    expect(
      audited.filter((entry) => !entry.metadata?.includes('"route"')),
    ).toEqual([
      expect.objectContaining({
        action: 'update',
        resourceType: 'application',
        metadata: JSON.stringify({ links: ['DATABASE_URL'] }),
      }),
    ]);

    // The next plan has nothing to change.
    const next = await request(http)
      .post(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);
    expect(next.status).toBe(201);
    expect((next.body as PlanBody).steps).toEqual([]);
  });

  it('never shows or hands out the linked value', async () => {
    await linked({
      links: [{ name: 'DATABASE_URL', source: 'pg-1', output: 'url' }],
    });

    const { applicationId } = await webRow();
    const read = await request(http)
      .get(`/applications/${applicationId}`)
      .set('Cookie', cookie);
    expect(read.status).toBe(200);
    const body = JSON.stringify(read.body);
    expect(body).not.toContain('postgresql://');
    expect(body).not.toContain('postgres://typed');
    expect(JSON.stringify(await links())).not.toContain('postgresql://');
  });

  it('refuses a link its plan would refuse, writing nothing', async () => {
    const before = await storedText();
    const refused = await saveLinks({
      links: [{ name: 'DATABASE_URL', source: 'pg-1', output: 'ca' }],
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'LINK_REFUSED',
      message: expect.stringContaining('web.env.DATABASE_URL') as unknown,
    });

    const row = await webRow();
    expect(row.configLinks).toEqual({});
    expect(row.env).toBe('NODE_ENV=production\nDATABASE_URL=postgres://typed');
    expect(await storedText()).toBe(before);
    expect(
      await ctx.db.select().from(plan).where(eq(plan.source, 'save')),
    ).toEqual([]);
  });

  it('moves a link to another source, and removes it, each as a Save', async () => {
    await linked({
      links: [{ name: 'DATABASE_URL', source: 'pg-1', output: 'url' }],
    });
    await linked({
      links: [{ name: 'DATABASE_URL', source: 'pg-1', output: 'host' }],
    });
    expect(await storedText()).toContain('DATABASE_URL: pg-1.host');

    await linked({ links: [] });
    const text = await storedText();
    expect(text).not.toContain('DATABASE_URL');
    expect((await webRow()).configLinks).toEqual({});

    const next = await request(http)
      .post(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);
    expect((next.body as PlanBody).steps).toEqual([]);
  });

  it('refuses a typed value for the linked name afterwards', async () => {
    await linked({
      links: [{ name: 'DATABASE_URL', source: 'pg-1', output: 'url' }],
    });
    const { applicationId } = await webRow();
    const refused = await request(http)
      .patch(`/applications/${applicationId}/environment`)
      .set('Cookie', cookie)
      .send({ env: 'NODE_ENV=production\nDATABASE_URL=typed-again' });
    expect(refused.status).toBe(409);
    expect((refused.body as { code: string }).code).toBe('VARIABLE_IS_LINKED');
  });
});
