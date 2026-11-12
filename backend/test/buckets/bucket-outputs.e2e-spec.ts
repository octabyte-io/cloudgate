import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { ApplicationsService } from '../../src/applications/applications.service';
import {
  application,
  bucket,
  domain,
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

/** What the key program prints once Garage made the bucket's one key. */
const KEY_ID = 'GK3a1f0c9e2b7d4c6a8e1f0b2d';
const SECRET_KEY =
  '9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0';

interface PlanBody {
  planId: string;
  environmentId: string;
  steps: {
    action: string;
    configName: string;
    fields?: { field: string; from: unknown; to: unknown }[];
  }[];
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

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * A bucket's Outputs wired into Services on a Server (ADR-0031,
 * ADR-0032), through the HTTP API: `env: [{ S3_BUCKET: uploads.name }, …]`
 * plans, applies and deploys, and the faked engine hands the linked
 * Service's container the bucket's real name, `us-east-1`, its endpoint
 * (its generated Domain), its one key and `path_style: "true"`. Nothing is saved on the
 * linked row nor shown by the API; an Output a bucket does not hand out
 * refuses the plan. The Server's shell and its Docker daemon are the
 * doubles; words and values are written out here, never imported (§1.7).
 */
describe('Bucket Outputs wired on a Server (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let projectId: string;
  let serverId: string;
  let environmentId: string;

  const queue = new ListQueue();
  const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
  const machine = (command: string) => {
    if (isPresenceProbe(command)) return Promise.resolve(ok('absent'));
    if (command.includes('garage key create')) {
      return Promise.resolve(
        ok(`CLOUDGATE_KEY_ID=${KEY_ID}\nCLOUDGATE_SECRET_KEY=${SECRET_KEY}\n`),
      );
    }
    return Promise.resolve(ok());
  };
  const execMock = withArgvExec({
    execAsync: jest.fn<Promise<ExecResult>, [string, unknown?]>(),
    execAsyncRemote: jest.fn<Promise<ExecResult>, [string, string]>(),
  });
  const dockerService = { inspect: jest.fn(), update: jest.fn() };
  const docker = {
    getService: jest.fn(() => dockerService),
    createService: jest.fn(),
    listTasks: jest.fn(),
    getSecret: jest.fn(() => ({
      inspect: jest.fn().mockRejectedValue(new Error('no such secret')),
    })),
    createSecret: jest.fn(),
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
    docker.createSecret.mockReset().mockResolvedValue({ id: 'secret-1' });
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
    serverId = worker.serverId;

    const created = await request(http)
      .post('/environments')
      .set('Cookie', cookie)
      .send({
        name: 'production',
        projectId,
        deployTarget: { kind: 'server', serverId },
      });
    expect(created.status).toBe(201);
    environmentId = (created.body as { environmentId: string }).environmentId;
  });

  const save = (text: string) =>
    request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });

  async function applyPlan(text: string) {
    const saved = await save(text);
    expect(saved.status).toBe(201);
    const open = (saved.body as { plans: PlanBody[] }).plans.find(
      (plan) => plan.environmentId === environmentId,
    ) as PlanBody;
    const applied = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: open.planId });
    expect(applied.status).toBe(200);
    const results = (applied.body as PlanBody).results;
    expect(results.filter((result) => result.status !== 'applied')).toEqual([]);
    // The bucket's deploy runs after the Apply answers, and makes its key.
    await waitFor(async () => {
      const rows = await ctx.db.select().from(bucket);
      return rows.every((row) => row.applicationStatus !== 'running');
    });
    return open;
  }

  async function rowOf(configName: string) {
    const [row] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.configName, configName));
    return row;
  }

  /** Deploys an Application through the real engine, as the queue processor would. */
  async function deploy(configName: string): Promise<string[]> {
    const { applicationId, appName } = await rowOf(configName);
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

  const STACK = (webEnv: string, workerEnv = '[]') => `version: 1
services:
  web:
    kind: web
    source:
      image: nginx:1.27
    env: ${webEnv}
  thumbnailer:
    kind: worker
    source:
      image: busybox:1.36
    env: ${workerEnv}
  uploads:
    kind: bucket
`;

  const ALL_SIX =
    '[{ S3_BUCKET: uploads.name }, { S3_REGION: uploads.region }, { S3_ENDPOINT: uploads.endpoint }, { S3_ACCESS_KEY_ID: uploads.access_key_id }, { S3_SECRET_ACCESS_KEY: uploads.secret_access_key }, { S3_PATH_STYLE: uploads.path_style }]';

  it('plans, applies and deploys web with all six bucket Outputs in its Env, saved nowhere and shown as links', async () => {
    const open = await applyPlan(STACK(ALL_SIX));
    expect(
      open.steps.find((step) => step.configName === 'web')?.fields,
    ).toEqual(
      expect.arrayContaining([
        { field: 'env.S3_BUCKET', from: null, to: 'uploads.name' },
        { field: 'env.S3_ENDPOINT', from: null, to: 'uploads.endpoint' },
        {
          field: 'env.S3_SECRET_ACCESS_KEY',
          from: null,
          to: 'uploads.secret_access_key',
        },
      ]),
    );

    const [uploads] = await ctx.db.select().from(bucket);
    expect(uploads.accessKeyId).toBe(KEY_ID);
    // Its generated Domain is its endpoint; `bucket-domains` has the rest.
    const [generated] = await ctx.db
      .select()
      .from(domain)
      .where(eq(domain.bucketId, uploads.bucketId));
    const env = await deploy('web');

    expect(env).toEqual(
      expect.arrayContaining([
        `S3_BUCKET=${uploads.bucketName}`,
        'S3_REGION=us-east-1',
        `S3_ENDPOINT=https://${generated.host}`,
        `S3_ACCESS_KEY_ID=${KEY_ID}`,
        `S3_SECRET_ACCESS_KEY=${SECRET_KEY}`,
        'S3_PATH_STYLE=true',
      ]),
    );

    // On the row: the links, never a value.
    const row = await rowOf('web');
    expect(row.configLinks).toEqual({
      S3_BUCKET: { source: 'uploads', output: 'name' },
      S3_REGION: { source: 'uploads', output: 'region' },
      S3_ENDPOINT: { source: 'uploads', output: 'endpoint' },
      S3_ACCESS_KEY_ID: { source: 'uploads', output: 'access_key_id' },
      S3_SECRET_ACCESS_KEY: { source: 'uploads', output: 'secret_access_key' },
      S3_PATH_STYLE: { source: 'uploads', output: 'path_style' },
    });
    expect(JSON.stringify(row)).not.toContain(SECRET_KEY);
    expect(JSON.stringify(row)).not.toContain(KEY_ID);

    // Through the API: the variable reads as a link, and neither the
    // linked Service nor the bucket shows the key.
    const read = await request(http)
      .get(`/applications/${row.applicationId}`)
      .set('Cookie', cookie);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      configLinks: { S3_BUCKET: { source: 'uploads', output: 'name' } },
    });
    const store = await request(http)
      .get(`/buckets/${uploads.bucketId}`)
      .set('Cookie', cookie);
    expect(store.status).toBe(200);
    expect(store.body).toMatchObject({ hasKey: true });
    for (const body of [read.body, store.body]) {
      expect(JSON.stringify(body)).not.toContain(SECRET_KEY);
      expect(JSON.stringify(body)).not.toContain(KEY_ID);
    }
  });

  it('hands two Services linking one bucket the same key', async () => {
    await applyPlan(
      STACK(
        '[{ AWS_ACCESS_KEY_ID: uploads.access_key_id }, { AWS_SECRET_ACCESS_KEY: uploads.secret_access_key }]',
        '[{ KEY: uploads.access_key_id }, { SECRET: uploads.secret_access_key }]',
      ),
    );

    const web = await deploy('web');
    const thumbnailer = await deploy('thumbnailer');

    expect(web).toEqual(
      expect.arrayContaining([
        `AWS_ACCESS_KEY_ID=${KEY_ID}`,
        `AWS_SECRET_ACCESS_KEY=${SECRET_KEY}`,
      ]),
    );
    expect(thumbnailer).toEqual(
      expect.arrayContaining([`KEY=${KEY_ID}`, `SECRET=${SECRET_KEY}`]),
    );
  });

  it('refuses a plan linking an Output a bucket does not hand out, naming the Service and variable', async () => {
    const refused = await save(STACK('[{ S3_URL: uploads.url }]'));

    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'PLAN_REFUSED' });
    expect((refused.body as { message: string }).message).toContain(
      'web.env.S3_URL links to uploads.url, but a bucket',
    );
  });

  it("waits for the bucket's key while its first deploy is still making it", async () => {
    await applyPlan(STACK('[{ S3_ACCESS_KEY_ID: uploads.access_key_id }]'));
    const [uploads] = await ctx.db.select().from(bucket);
    await ctx.db
      .update(bucket)
      .set({
        accessKeyId: null,
        secretAccessKey: null,
        applicationStatus: 'running',
      })
      .where(eq(bucket.bucketId, uploads.bucketId));

    const deploying = deploy('web');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await ctx.db
      .update(bucket)
      .set({
        accessKeyId: 'GK0000000000000000000000ff',
        secretAccessKey: SECRET_KEY,
        applicationStatus: 'done',
      })
      .where(eq(bucket.bucketId, uploads.bucketId));

    expect(await deploying).toContain(
      'S3_ACCESS_KEY_ID=GK0000000000000000000000ff',
    );
  });

  it("fails the linked deploy, saying why, when the bucket's first deploy ended without its key", async () => {
    await applyPlan(STACK('[{ S3_ACCESS_KEY_ID: uploads.access_key_id }]'));
    const [uploads] = await ctx.db.select().from(bucket);
    await ctx.db
      .update(bucket)
      .set({
        accessKeyId: null,
        secretAccessKey: null,
        applicationStatus: 'error',
      })
      .where(eq(bucket.bucketId, uploads.bucketId));

    await expect(deploy('web')).rejects.toThrow(
      "uploads has no key: Garage makes it on the bucket's first deploy, which did not finish",
    );
  });
});
