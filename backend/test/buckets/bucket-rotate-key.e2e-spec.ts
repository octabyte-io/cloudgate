import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { ApplicationsService } from '../../src/applications/applications.service';
import { KEY_ROTATION_CLOCK } from '../../src/buckets/bucket-key-rotation.service';
import {
  application,
  bucket,
  deployment,
  licenseKey,
  member,
  organizationRole,
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
import { signUpMember } from '../utils/test-auth';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

/** The key Garage makes on the bucket's first deploy. */
const OLD_ID = 'GK0a0a0a0a0a0a0a0a0a0a0a01';
const OLD_SECRET = 'a1'.repeat(32);
/** The key Garage makes when the key is rotated. */
const NEW_ID = 'GK0b0b0b0b0b0b0b0b0b0b0b02';
const NEW_SECRET = 'b2'.repeat(32);

interface PlanBody {
  planId: string;
  environmentId: string;
  results: { configName: string; status: string; message: string | null }[];
}

interface RotationBody {
  hasKey: boolean;
  keyRotation: {
    status: string;
    phase: string | null;
    failed: string[];
    message: string | null;
    redeploys: { configName: string; outcome: string | null }[];
    putBacks: { configName: string; outcome: string | null }[];
  } | null;
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
 * A Server bucket's Rotate key (ADR-0037), through the HTTP API: a
 * new Garage key, a redeploy of every Service linking the key queued, the
 * new key filled in by those redeploys, and the old key removed only once
 * they all succeeded. A failed redeploy puts the others back on the old
 * key, removes the new one and names the Service. The Server's shell and its
 * Docker daemon are the doubles, and the queue a list whose Deployments the
 * spec ends by hand; words and values are written out here (§1.7).
 */
describe('Bucket Rotate key on a Server (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let projectId: string;
  let serverId: string;
  let environmentId: string;

  const queue = new ListQueue();
  const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
  /** The keys `garage key create` hands out, one per call. */
  let keys: [string, string][] = [];
  /** Programs that make or remove a key, in the order the Server got them. */
  let keyPrograms: string[] = [];
  const machine = (command: string) => {
    if (isPresenceProbe(command)) return Promise.resolve(ok('absent'));
    // The CORS program's one-request owner key is not the bucket's.
    if (command.includes('-cors')) return Promise.resolve(ok());
    if (command.includes('garage key create')) {
      keyPrograms.push(command);
      const [id, secret] = keys.shift() ?? ['GKunexpected', 'unexpected'];
      return Promise.resolve(
        ok(`CLOUDGATE_KEY_ID=${id}\nCLOUDGATE_SECRET_KEY=${secret}\n`),
      );
    }
    if (command.includes('garage key delete')) {
      keyPrograms.push(command);
      const ids = [...command.matchAll(/key delete --yes (\S+)/g)].map(
        (match) => match[1],
      );
      return Promise.resolve(
        ok(ids.map((id) => `CLOUDGATE_KEY_REMOVED=${id}`).join('\n')),
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
        {
          provide: KEY_ROTATION_CLOCK,
          useValue: { everyMs: 25, budgetMs: 60_000 },
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
    keys = [
      [OLD_ID, OLD_SECRET],
      [NEW_ID, NEW_SECRET],
    ];
    keyPrograms = [];
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

  const STACK = `version: 1
services:
  web:
    kind: web
    source:
      image: nginx:1.27
    env: [{ S3_KEY: uploads.access_key_id }, { S3_SECRET: uploads.secret_access_key }]
  thumbnailer:
    kind: worker
    source:
      image: busybox:1.36
    env: [{ KEY: uploads.access_key_id }, { SECRET: uploads.secret_access_key }]
  reporter:
    kind: worker
    source:
      image: busybox:1.36
    env: [{ S3_BUCKET: uploads.name }]
  uploads:
    kind: bucket
`;

  /** Plans and applies {@link STACK}, the bucket deployed with its first key. */
  async function applyStack(): Promise<string> {
    const saved = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text: STACK });
    expect(saved.status).toBe(201);
    const open = (saved.body as { plans: PlanBody[] }).plans.find(
      (plan) => plan.environmentId === environmentId,
    ) as PlanBody;
    const applied = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: open.planId });
    expect(applied.status).toBe(200);
    expect(
      (applied.body as PlanBody).results.filter(
        (result) => result.status !== 'applied',
      ),
    ).toEqual([]);
    await waitFor(async () => {
      const rows = await ctx.db.select().from(bucket);
      return rows.every((row) => row.applicationStatus !== 'running');
    });
    const [uploads] = await ctx.db.select().from(bucket);
    expect(uploads).toMatchObject({
      accessKeyId: OLD_ID,
      applicationStatus: 'done',
    });
    queue.jobs = [];
    keyPrograms = [];
    return uploads.bucketId;
  }

  const rotate = (bucketId: string, as = cookie) =>
    request(http).post(`/buckets/${bucketId}/rotate-key`).set('Cookie', as);

  const read = async (bucketId: string) => {
    const res = await request(http)
      .get(`/buckets/${bucketId}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.body as RotationBody;
  };

  async function applicationOf(configName: string) {
    const [row] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.configName, configName));
    return row;
  }

  /** The queued Deployments, by the Config name of their Application. */
  async function queuedFor(): Promise<Record<string, string[]>> {
    const byName: Record<string, string[]> = {};
    for (const job of queue.jobs) {
      const data = job.data as { applicationId?: string; deploymentId: string };
      const [row] = await ctx.db
        .select({ configName: application.configName })
        .from(application)
        .where(eq(application.applicationId, data.applicationId ?? ''));
      (byName[row.configName] ??= []).push(data.deploymentId);
    }
    return byName;
  }

  /** Ends a queued Deployment as its worker would. */
  const finish = (deploymentId: string, status: 'done' | 'error') =>
    ctx.db
      .update(deployment)
      .set({ status, finishedAt: new Date().toISOString() })
      .where(eq(deployment.deploymentId, deploymentId));

  /** The Env an Application's container would be given by a deploy now. */
  async function envOf(configName: string): Promise<string[]> {
    const { applicationId, appName } = await applicationOf(configName);
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

  const until = (bucketId: string, status: string) =>
    waitFor(async () => (await read(bucketId)).keyRotation?.status === status);

  it('makes a new key, redeploys every Service linking it with that key, and removes the old key only once all succeeded', async () => {
    const bucketId = await applyStack();

    const started = await rotate(bucketId);
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({
      hasKey: true,
      keyRotation: { status: 'running', phase: 'redeploying' },
    });

    // A new key, read and write on this bucket only, never owner.
    expect(keyPrograms).toHaveLength(1);
    expect(keyPrograms[0]).toContain('garage key create');
    expect(keyPrograms[0]).toMatch(
      /garage bucket allow --read --write \S+ --key/,
    );
    expect(keyPrograms[0]).not.toContain('--owner');

    // One redeploy queued per Service linking the key; not reporter, which
    // links only the bucket's name.
    const queued = await queuedFor();
    expect(Object.keys(queued).sort()).toEqual(['thumbnailer', 'web']);

    // The redeploys are handed the new key, while the old stays stored.
    expect(await envOf('web')).toEqual(
      expect.arrayContaining([`S3_KEY=${NEW_ID}`, `S3_SECRET=${NEW_SECRET}`]),
    );
    const [during] = await ctx.db.select().from(bucket);
    expect(during.accessKeyId).toBe(OLD_ID);

    // The old key is not removed while one redeploy is still running.
    await finish(queued.web[0], 'done');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(keyPrograms.filter((one) => one.includes('key delete'))).toEqual([]);
    expect((await read(bucketId)).keyRotation?.status).toBe('running');

    await finish(queued.thumbnailer[0], 'done');
    await until(bucketId, 'done');

    const removals = keyPrograms.filter((one) => one.includes('key delete'));
    expect(removals).toHaveLength(1);
    expect(removals[0]).toContain(`garage key delete --yes ${OLD_ID}`);
    expect(removals[0]).not.toContain(NEW_ID);

    const [after] = await ctx.db.select().from(bucket);
    expect(after).toMatchObject({
      accessKeyId: NEW_ID,
      secretAccessKey: NEW_SECRET,
      rotationKeys: null,
    });
    expect(await envOf('thumbnailer')).toEqual(
      expect.arrayContaining([`KEY=${NEW_ID}`, `SECRET=${NEW_SECRET}`]),
    );

    // Still only "set" on the API.
    const body = await read(bucketId);
    expect(body).toMatchObject({
      hasKey: true,
      keyRotation: {
        status: 'done',
        failed: [],
        message:
          'thumbnailer and web run with the new key, and the old key was removed',
      },
    });
    for (const secret of [OLD_ID, OLD_SECRET, NEW_ID, NEW_SECRET]) {
      expect(JSON.stringify(body)).not.toContain(secret);
      expect(JSON.stringify(started.body)).not.toContain(secret);
    }
  });

  it('keeps the old key, puts the others back on it, removes the new key and names the Service whose redeploy failed', async () => {
    const bucketId = await applyStack();

    expect((await rotate(bucketId)).status).toBe(200);
    const queued = await queuedFor();
    await finish(queued.thumbnailer[0], 'done');
    await finish(queued.web[0], 'error');

    // thumbnailer already runs with the new key: it is deployed again with
    // the old one before the new key goes.
    await waitFor(async () => (await queuedFor()).thumbnailer?.length === 2);
    const putBack = (await queuedFor()).thumbnailer[1];
    expect((await read(bucketId)).keyRotation).toMatchObject({
      status: 'running',
      phase: 'putting-back',
      failed: ['web'],
    });
    expect(await envOf('thumbnailer')).toEqual(
      expect.arrayContaining([`KEY=${OLD_ID}`, `SECRET=${OLD_SECRET}`]),
    );
    expect(keyPrograms.filter((one) => one.includes('key delete'))).toEqual([]);

    await finish(putBack, 'done');
    await until(bucketId, 'failed');

    const removals = keyPrograms.filter((one) => one.includes('key delete'));
    expect(removals).toHaveLength(1);
    expect(removals[0]).toContain(`garage key delete --yes ${NEW_ID}`);
    expect(removals[0]).not.toContain(OLD_ID);

    const [after] = await ctx.db.select().from(bucket);
    expect(after).toMatchObject({
      accessKeyId: OLD_ID,
      secretAccessKey: OLD_SECRET,
      rotationKeys: null,
    });
    expect((await read(bucketId)).keyRotation).toMatchObject({
      status: 'failed',
      phase: null,
      failed: ['web'],
      message:
        'The redeploy of web failed, so the old key stays in use and the new key was removed — fix web, then rotate again',
    });
    expect(await envOf('web')).toEqual(
      expect.arrayContaining([`S3_KEY=${OLD_ID}`]),
    );
  });

  it('keeps the new key for a Service whose put-back failed too, and the next rotation that succeeds removes it', async () => {
    const bucketId = await applyStack();
    keys.push(['GK0c0c0c0c0c0c0c0c0c0c0c03', 'c3'.repeat(32)]);

    await rotate(bucketId);
    let queued = await queuedFor();
    await finish(queued.thumbnailer[0], 'done');
    await finish(queued.web[0], 'error');
    await waitFor(async () => (await queuedFor()).thumbnailer?.length === 2);
    await finish((await queuedFor()).thumbnailer[1], 'error');
    await until(bucketId, 'failed');

    expect(keyPrograms.filter((one) => one.includes('key delete'))).toEqual([]);
    expect((await read(bucketId)).keyRotation?.message).toBe(
      'The redeploy of web failed, so the old key stays in use; thumbnailer could not be put back on it, so the new key stays valid for it until the next rotation removes it',
    );
    const [kept] = await ctx.db.select().from(bucket);
    expect(kept.accessKeyId).toBe(OLD_ID);
    expect(kept.rotationKeys).toEqual({ newKey: null, strayKeyIds: [NEW_ID] });

    queue.jobs = [];
    keyPrograms = [];
    expect((await rotate(bucketId)).status).toBe(200);
    queued = await queuedFor();
    await finish(queued.web[0], 'done');
    await finish(queued.thumbnailer[0], 'done');
    await until(bucketId, 'done');

    const [removal] = keyPrograms.filter((one) => one.includes('key delete'));
    expect(removal).toContain(`garage key delete --yes ${OLD_ID}`);
    expect(removal).toContain(`garage key delete --yes ${NEW_ID}`);
    const [after] = await ctx.db.select().from(bucket);
    expect(after).toMatchObject({
      accessKeyId: 'GK0c0c0c0c0c0c0c0c0c0c0c03',
      rotationKeys: null,
    });
  });

  it('refuses a second rotation while one runs, and a bucket with no key yet', async () => {
    const bucketId = await applyStack();
    expect((await rotate(bucketId)).status).toBe(200);
    const again = await rotate(bucketId);
    expect(again.status).toBe(409);
    expect((again.body as { message: string }).message).toBe(
      "uploads's key is already being rotated; wait for that rotation to end",
    );

    await ctx.db
      .update(bucket)
      .set({ accessKeyId: null, secretAccessKey: null, keyRotation: null })
      .where(eq(bucket.bucketId, bucketId));
    const keyless = await rotate(bucketId);
    expect(keyless.status).toBe(409);
    expect((keyless.body as { message: string }).message).toBe(
      "uploads has no key to rotate: Garage makes it on the bucket's first deploy",
    );
  });

  it('asks only service update: a Member without it is refused, one with it needs no deployment statement', async () => {
    const bucketId = await applyStack();
    const ida = await signUpMember(http, cookie);
    await ctx.db.insert(licenseKey).values({
      organizationId,
      key: 'test-license-key',
      status: 'active',
      enableEnterpriseFeatures: true,
    });
    await ctx.db.insert(organizationRole).values([
      { organizationId, role: 'reader', permission: { service: ['read'] } },
      {
        organizationId,
        role: 'storage',
        permission: { service: ['read', 'update'] },
      },
    ]);
    const asRole = (role: string) =>
      ctx.db
        .update(member)
        .set({ role, accessedServices: [bucketId] })
        .where(
          and(
            eq(member.userId, ida.id),
            eq(member.organizationId, organizationId),
          ),
        );

    await asRole('reader');
    expect((await rotate(bucketId, ida.cookie)).status).toBe(403);
    expect(keyPrograms).toEqual([]);
    expect(queue.jobs).toEqual([]);

    await asRole('storage');
    expect((await rotate(bucketId, ida.cookie)).status).toBe(200);
    expect(Object.keys(await queuedFor()).sort()).toEqual([
      'thumbnailer',
      'web',
    ]);
  });
});
