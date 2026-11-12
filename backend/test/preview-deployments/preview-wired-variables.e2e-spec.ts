import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { ApplicationsService } from '../../src/applications/applications.service';
import {
  application,
  deployment,
  postgres,
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
import { previewDeployment } from '../../src/preview-deployments/preview-deployment.schema';
import { PreviewDeploymentsService } from '../../src/preview-deployments/preview-deployments.service';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

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
 * Preview deployments of a Service with wired variables (ADR-0031,
 * ADR-0021): a preview of `web`, linked to `pg-1.url`, resolves that link at
 * its own deploy as `web` does, and a `previewEnv` value for the linked name
 * replaces it for the preview only. Nothing resolved is saved on either row
 * or answered by the API. The Swarm and the machine are the boundaries.
 */
describe('Preview deployments with wired variables (e2e)', () => {
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

  /** A writable platform root: a converged preview's host is routed there. */
  const configuredRoot = fs.realpathSync(
    fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-preview-wired-')),
  );
  const originalRoot = process.env.CLOUDGATE_DIRECTORY;

  beforeAll(async () => {
    // Before `createTestApp`: `validateEnv` reads it once at boot.
    process.env.CLOUDGATE_DIRECTORY = configuredRoot;
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
    if (originalRoot === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = originalRoot;
    fs.rmSync(configuredRoot, { recursive: true, force: true });
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

    const [server] = await ctx.db
      .insert(serverTable)
      .values({
        name: 'worker',
        ipAddress: '203.0.113.10',
        port: 22,
        serverType: 'deploy',
        organizationId,
      })
      .returning();
    const environment = await request(http)
      .post('/environments')
      .set('Cookie', cookie)
      .send({
        name: 'production',
        projectId,
        deployTarget: { kind: 'server', serverId: server.serverId },
      });
    expect(environment.status).toBe(201);
    environmentId = (environment.body as { environmentId: string })
      .environmentId;
  });

  const CONFIG = `version: 1
services:
  web:
    kind: web
    source:
      git: https://example.com/octabyte/shop.git
    env: [NODE_ENV, { DATABASE_URL: pg-1.url }, { DB_HOST: pg-1.host }]
  pg-1:
    kind: postgres
    database: shop
    user: shop
`;

  /** Plans and applies {@link CONFIG} through the API, and lets pg-1's deploy settle. */
  async function applyConfig() {
    const saved = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text: CONFIG });
    expect(saved.status).toBe(201);
    const plan = (
      saved.body as { plans: { planId: string; environmentId: string }[] }
    ).plans.find((found) => found.environmentId === environmentId);
    const applied = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: plan?.planId });
    expect(applied.status).toBe(200);
    await waitFor(async () =>
      (await ctx.db.select().from(postgres)).every(
        (row) => row.applicationStatus !== 'running',
      ),
    );
  }

  async function webRow() {
    const [row] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.configName, 'web'));
    return row;
  }

  /** `web` with Requested previews allowed and `body` saved through the API. */
  async function previewable(body: object = {}) {
    await applyConfig();
    const { applicationId } = await webRow();
    const saved = await request(http)
      .patch(`/applications/${applicationId}`)
      .set('Cookie', cookie)
      .send({ requestedPreviewsAllowed: true, ...body });
    expect(saved.status).toBe(200);
    return applicationId;
  }

  /** The Env the last Swarm spec named `name` carries. */
  function emittedEnv(name: string): string[] {
    const call = docker.createService.mock.calls
      .map((args: unknown[]) => args[args.length - 1])
      .filter((settings) => (settings as { Name: string }).Name === name)
      .pop() as { TaskTemplate: { ContainerSpec: { Env: string[] } } };
    expect(call).toBeDefined();
    return call.TaskTemplate.ContainerSpec.Env;
  }

  /**
   * Asks for a preview through the API and runs its queued deploy, as the
   * queue processor would. Answers the preview's id and its emitted Env.
   */
  async function deployPreview(applicationId: string) {
    const asked = await request(http)
      .post(`/applications/${applicationId}/preview-deployments`)
      .set('Cookie', cookie)
      .send({ branch: 'feature/staging' });
    expect(asked.status).toBe(201);
    const { previewDeploymentId, deploymentId, appName } = asked.body as {
      previewDeploymentId: string;
      deploymentId: string;
      appName: string;
    };
    await ctx.app
      .get(PreviewDeploymentsService)
      .deployPreview(previewDeploymentId, { deploymentId });
    const [row] = await ctx.db
      .select()
      .from(previewDeployment)
      .where(eq(previewDeployment.previewDeploymentId, previewDeploymentId));
    expect(row.previewStatus).toBe('done');
    return { previewDeploymentId, env: emittedEnv(appName) };
  }

  /** Deploys `web` itself through the real engine. */
  async function deployWeb() {
    const { applicationId, appName } = await webRow();
    const deployable = await ctx.app
      .get(ApplicationsService)
      .findDeployable(applicationId);
    await ctx.app.get(DeploymentEngineService).deploy(deployable);
    return emittedEnv(appName);
  }

  /** Fails when `secret` is on any saved row or in any API answer about `web` or its preview. */
  async function expectSavedNowhere(
    secret: string,
    applicationId: string,
    previewDeploymentId: string,
  ) {
    const rows = [
      await webRow(),
      ...(await ctx.db.select().from(previewDeployment)),
      ...(await ctx.db.select().from(deployment)),
    ];
    expect(JSON.stringify(rows)).not.toContain(secret);
    for (const path of [
      `/applications/${applicationId}`,
      `/applications/${applicationId}/preview-deployments`,
      `/preview-deployments/${previewDeploymentId}`,
    ]) {
      const read = await request(http).get(path).set('Cookie', cookie);
      expect(read.status).toBe(200);
      expect(JSON.stringify(read.body)).not.toContain(secret);
    }
  }

  it("gives a preview its parent's wired variables, built at its own deploy and saved nowhere", async () => {
    const applicationId = await previewable();
    const [pg] = await ctx.db.select().from(postgres);
    const url = `postgresql://shop:${encodeURIComponent(pg.databasePassword)}@${pg.appName}:5432/shop`;

    const { previewDeploymentId, env } = await deployPreview(applicationId);

    expect(env).toEqual(
      expect.arrayContaining([`DATABASE_URL=${url}`, `DB_HOST=${pg.appName}`]),
    );
    await expectSavedNowhere(url, applicationId, previewDeploymentId);
    await expectSavedNowhere(
      pg.databasePassword,
      applicationId,
      previewDeploymentId,
    );
  });

  it("lets previewEnv replace a link's value for the preview only, while the parent keeps the link", async () => {
    const staging = 'postgresql://staging:pw@staging-db:5432/shop';
    const applicationId = await previewable({
      previewEnv: `NODE_ENV=staging\nDATABASE_URL=${staging}`,
    });
    const [pg] = await ctx.db.select().from(postgres);
    const linked = `postgresql://shop:${encodeURIComponent(pg.databasePassword)}@${pg.appName}:5432/shop`;

    const { previewDeploymentId, env } = await deployPreview(applicationId);

    expect(env).toEqual(
      expect.arrayContaining([
        `DATABASE_URL=${staging}`,
        'NODE_ENV=staging',
        // A link previewEnv does not name is still the parent's.
        `DB_HOST=${pg.appName}`,
      ]),
    );
    expect(env.filter((entry) => entry.startsWith('DATABASE_URL='))).toEqual([
      `DATABASE_URL=${staging}`,
    ]);

    const parent = await deployWeb();
    expect(parent).toEqual(
      expect.arrayContaining([
        `DATABASE_URL=${linked}`,
        `DB_HOST=${pg.appName}`,
      ]),
    );
    expect(parent).not.toContain(`DATABASE_URL=${staging}`);

    // The parent row still links the name; the override is only previewEnv.
    expect((await webRow()).configLinks).toEqual({
      DATABASE_URL: { source: 'pg-1', output: 'url' },
      DB_HOST: { source: 'pg-1', output: 'host' },
    });
    await expectSavedNowhere(linked, applicationId, previewDeploymentId);
  });

  it('never reads the source of a link previewEnv overrides', async () => {
    const applicationId = await previewable({
      previewEnv:
        'DATABASE_URL=postgresql://staging:pw@staging-db:5432/shop\nDB_HOST=staging-db',
    });
    // No pg-1 answers to the name any more: every link to it is unmet.
    await ctx.db.update(postgres).set({ configName: 'pg-renamed' });

    const { env } = await deployPreview(applicationId);
    expect(env).toEqual(
      expect.arrayContaining([
        'DATABASE_URL=postgresql://staging:pw@staging-db:5432/shop',
        'DB_HOST=staging-db',
      ]),
    );

    // The parent, which has no override, still fails naming the variable.
    await expect(deployWeb()).rejects.toThrow(/links to pg-1\./);
  });

  it('accepts a previewEnv value for a linked name, which env refuses', async () => {
    const applicationId = await previewable();
    const typed = await request(http)
      .patch(`/applications/${applicationId}`)
      .set('Cookie', cookie)
      .send({ previewEnv: 'DATABASE_URL=postgresql://staging' });
    expect(typed.status).toBe(200);
    expect((await webRow()).previewEnv).toBe(
      'DATABASE_URL=postgresql://staging',
    );

    const refused = await request(http)
      .patch(`/applications/${applicationId}`)
      .set('Cookie', cookie)
      .send({ env: 'DATABASE_URL=postgresql://staging' });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'VARIABLE_IS_LINKED' });
  });
});
