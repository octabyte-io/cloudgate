// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first load.
import { useHostedMode } from '../utils/hosted-mode';
useHostedMode();

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  application,
  environment,
  server,
  webServerSettings,
} from '../../src/db/schema';
import type { DeploymentJob } from '../../src/deployment-queue/job-types';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import type {
  QueuedJob,
  QueuePort,
} from '../../src/deployment-queue/queue.port';
import { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import {
  PLATFORM_HOST_REFUSALS,
  PLATFORM_HOST_REFUSED_CODE,
} from '../../src/instance-mode/platform-host-refusal';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { HOSTED_STAFF, openHostedSignUp } from '../utils/hosted-sign-up';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { secondOrganizationOwner } from '../utils/test-auth';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(180_000);

const PLATFORM_HOST = { kind: 'platform-host' };
const onServer = (serverId: string) => ({ kind: 'server', serverId });

/** The 400 every platform-host refusal of a Service or an Environment says. */
const REFUSED = {
  statusCode: 400,
  code: PLATFORM_HOST_REFUSED_CODE,
  message: PLATFORM_HOST_REFUSALS.services,
};

const WORKER = `version: 1
services:
  report:
    kind: worker
    command: node dist/report.js
    source:
      git: https://git.example.com/acme/report.git
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
 * On the Hosted instance an Environment never points at the platform host
 * and nothing defaults to it (ADR-0053 seams 1 and 2): a create or a
 * retarget naming it, or naming nothing, is refused with
 * `PLATFORM_HOST_REFUSED`, so an Organization with no Server and no Cloud
 * account has no Environment (but may have a Project); a console create in a
 * platform-host or cloud Environment with no Server named is refused rather
 * than put on the box; and a Project config Apply onto a platform-host
 * Environment from before is refused. The Instance organization is refused
 * the same, and keeps managing the box.
 *
 * Each case has a Self-hosted counterpart at the end, with `isHosted` turned
 * off on the same app, as `billing.e2e-spec.ts`'s `givenSelfHostedInstance`
 * does.
 */
describe('Platform-host refusal on the Hosted instance (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
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

    // The first account is the Instance organization's owner (ADR-0013). On
    // the Hosted instance it is made by `create-instance-organization`, not by
    // a web sign-up, and signs in with the password it was given.
    await openHostedSignUp(ctx.db);
    const res = await request(http)
      .post('/api/auth/sign-in/email')
      .send({ email: HOSTED_STAFF.email, password: HOSTED_STAFF.password });
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

  /** An Environment written straight to its row, as one from before hosted mode. */
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

  const createEnvironment = (body: Record<string, unknown>) =>
    request(http)
      .post('/environments')
      .set('Cookie', cookie)
      .send({ projectId, ...body });

  const environments = async () =>
    (
      await request(http)
        .get('/environments')
        .query({ projectId })
        .set('Cookie', cookie)
    ).body as unknown[];

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

  const apply = (environmentId: string, planId: string) =>
    request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId });

  describe('an Environment', () => {
    it('is refused the platform host as its Deploy target, and nothing is created', async () => {
      const refused = await createEnvironment({
        name: 'production',
        deployTarget: PLATFORM_HOST,
      });

      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject(REFUSED);
      expect(await environments()).toEqual([]);
    });

    it('with no Deploy target is refused rather than given the platform host, Server or no Server', async () => {
      const bare = await createEnvironment({ name: 'production' });
      await addServer('worker-1');
      const withServer = await createEnvironment({ name: 'production' });

      expect(bare.status).toBe(400);
      expect(bare.body).toMatchObject(REFUSED);
      expect(withServer.status).toBe(400);
      expect(withServer.body).toMatchObject(REFUSED);
      expect(await environments()).toEqual([]);
    });

    it('takes a Server of its own, and cannot be retargeted to the platform host', async () => {
      const worker = await addServer('worker-1');
      const created = await createEnvironment({
        name: 'production',
        deployTarget: onServer(worker),
      });
      expect(created.status).toBe(201);
      const environmentId = (created.body as { environmentId: string })
        .environmentId;

      const retargeted = await request(http)
        .patch(`/environments/${environmentId}`)
        .set('Cookie', cookie)
        .send({ deployTarget: PLATFORM_HOST });

      expect(retargeted.status).toBe(400);
      expect(retargeted.body).toMatchObject(REFUSED);
      const [row] = await ctx.db
        .select({ deployTarget: environment.deployTarget })
        .from(environment)
        .where(eq(environment.environmentId, environmentId));
      expect(row.deployTarget).toEqual(onServer(worker));
    });
  });

  it('lets an Organization with no Server and no Cloud account make a Project but no Environment', async () => {
    // The Project made in beforeEach is this Organization's, which has neither.
    const another = await request(http)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'blog' });
    expect(another.status).toBe(201);

    for (const deployTarget of [undefined, PLATFORM_HOST]) {
      const refused = await createEnvironment({
        name: 'production',
        ...(deployTarget ? { deployTarget } : {}),
      });
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject(REFUSED);
    }
    expect(await environments()).toEqual([]);
  });

  it('refuses a console Application with no Server in a platform-host or cloud Environment', async () => {
    const onHost = await environmentRow('legacy', PLATFORM_HOST);
    const inCloud = await environmentRow('cloud', {
      kind: 'cloud',
      cloudAccountId: 'ca_unlisted',
      region: 'eu-west-1',
    });

    for (const environmentId of [onHost, inCloud]) {
      const refused = await request(http)
        .post('/applications')
        .set('Cookie', cookie)
        .send({ name: 'web', environmentId });
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject(REFUSED);
    }
    expect(await ctx.db.select().from(application)).toEqual([]);
  });

  it('refuses a Project config Apply onto a platform-host Environment, and creates nothing', async () => {
    await ctx.db.insert(webServerSettings).values({ serverIp: '198.51.100.7' });
    const environmentId = await environmentRow('legacy', PLATFORM_HOST);
    const planId = await planFor(environmentId, WORKER);

    const refused = await apply(environmentId, planId);

    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject(REFUSED);
    expect(await ctx.db.select().from(application)).toEqual([]);
    expect(queue.jobs).toEqual([]);
  });

  it('keeps the Instance organization managing the box: swarm and Docker cleanup on the host', async () => {
    execMock.execAsync.mockResolvedValue({
      stdout: '{"ID":"node1"}',
      stderr: '',
      exitCode: 0,
    });
    const nodes = await request(http).get('/swarm/nodes').set('Cookie', cookie);
    expect(nodes.status).toBe(200);
    expect(nodes.body).toEqual([{ ID: 'node1' }]);

    const cleaned = await request(http)
      .post('/settings/cleanup/images')
      .set('Cookie', cookie)
      .send({});
    expect(cleaned.status).toBe(200);
    expect(execMock.execAsync).toHaveBeenCalledWith(
      expect.stringContaining('docker image prune'),
    );

    // And it is instance authority, not any owner's: another Organization's
    // owner is refused the same host routes.
    const mallory = await secondOrganizationOwner(http, ctx.db, cookie);
    const theirs = await request(http)
      .post('/settings/cleanup/images')
      .set('Cookie', mallory.cookie)
      .send({});
    expect(theirs.status).toBe(403);
  });

  describe('on a Self-hosted instance (counterpart)', () => {
    it('takes the platform host as asked, and as the default with no Server', async () => {
      givenSelfHostedInstance();

      const asked = await createEnvironment({
        name: 'staging',
        deployTarget: PLATFORM_HOST,
      });
      const defaulted = await createEnvironment({ name: 'production' });

      expect(asked.status).toBe(201);
      expect(asked.body).toMatchObject({ deployTarget: PLATFORM_HOST });
      expect(defaulted.status).toBe(201);
      expect(defaulted.body).toMatchObject({ deployTarget: PLATFORM_HOST });
    });

    it('retargets an Environment to the platform host', async () => {
      givenSelfHostedInstance();
      const worker = await addServer('worker-1');
      const created = await createEnvironment({
        name: 'production',
        deployTarget: onServer(worker),
      });

      const retargeted = await request(http)
        .patch(
          `/environments/${(created.body as { environmentId: string }).environmentId}`,
        )
        .set('Cookie', cookie)
        .send({ deployTarget: PLATFORM_HOST });

      expect(retargeted.status).toBe(200);
      expect(retargeted.body).toMatchObject({ deployTarget: PLATFORM_HOST });
    });

    it('puts a console Application with no Server in a platform-host Environment on the host', async () => {
      givenSelfHostedInstance();
      const onHost = await environmentRow('legacy', PLATFORM_HOST);

      const created = await request(http)
        .post('/applications')
        .set('Cookie', cookie)
        .send({ name: 'web', environmentId: onHost });

      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ serverId: null });
    });

    it('applies a Project config onto a platform-host Environment', async () => {
      givenSelfHostedInstance();
      await ctx.db
        .insert(webServerSettings)
        .values({ serverIp: '198.51.100.7' });
      const environmentId = await environmentRow('legacy', PLATFORM_HOST);
      const planId = await planFor(environmentId, WORKER);

      const applied = await apply(environmentId, planId);

      expect(applied.status).toBe(200);
      const rows = await ctx.db
        .select({ serverId: application.serverId })
        .from(application);
      expect(rows).toEqual([{ serverId: null }]);
    });
  });
});
