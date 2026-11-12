// A hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first load. The old deploy-worker settings are
// set too, to show they no longer send a build anywhere.
import { useHostedMode } from '../utils/hosted-mode';
useHostedMode();
process.env.DEPLOY_API_URL = 'https://deploy.cloudgate.test';
process.env.DEPLOY_API_KEY = 'e2e-deploy-key';

import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import {
  application as applicationTable,
  deployment as deploymentTable,
  server as serverTable,
} from '../../src/db/schema';
import { InMemoryQueue } from '../../src/deployment-queue/in-memory-queue';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import type { QueuePort } from '../../src/deployment-queue/queue.port';
import {
  BUILD_CUT_OFF_BY_RESTART,
  DeploymentsService,
} from '../../src/deployments/deployments.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { FETCH_CLIENT } from '../../src/git-providers/fetch.provider';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { MailService } from '../../src/mail/mail.service';
import { withArgvExec } from '../utils/exec-double';
import {
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../utils/hosted-sign-up';
import { freezeOrganization } from '../utils/frozen-organization';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * Builds on a hosted instance. Every instance, hosted or not, drives
 * its builds through the in-process queue and builds over SSH on the
 * Application's Server; nothing is posted to an outside deploy worker. A
 * restart treats a hosted instance's builds as any other's: one in flight
 * ends `error`, and one still waiting is queued again.
 *
 * Real here: the queue the container built, its processor, the deployment
 * engine and `DeploymentsService`. Faked: the shell, at `RemoteExecService`,
 * and outbound HTTP, which nothing should reach for a build.
 */
describe('Builds on a hosted instance (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let deployments: DeploymentsService;

  const ok = { stdout: '', stderr: '', exitCode: 0 };
  const execMock = withArgvExec({
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  });
  const fetchMock = jest.fn();
  const mail = new MailRecorder();
  // The Swarm the release reaches over the Docker API: no service yet, and
  // one task already running, so a build reaches `done`.
  const docker = {
    getService: jest.fn(() => ({
      inspect: jest.fn().mockRejectedValue(new Error('no such service')),
      update: jest.fn().mockResolvedValue(undefined),
    })),
    createService: jest.fn().mockResolvedValue(undefined),
    listTasks: jest
      .fn()
      .mockResolvedValue([
        { Status: { State: 'running', Timestamp: '2026-11-04T00:00:00Z' } },
      ]),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: FETCH_CLIENT, useValue: fetchMock },
        { provide: MailService, useValue: mail },
        {
          provide: RemoteDockerFactory,
          useValue: { getRemoteDocker: () => Promise.resolve(docker) },
        },
      ],
    });
    httpServer = ctx.app.getHttpServer() as App;
    deployments = ctx.app.get(DeploymentsService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    execMock.execAsync.mockReset().mockResolvedValue(ok);
    execMock.execAsyncRemote.mockReset().mockResolvedValue(ok);
    fetchMock.mockReset().mockRejectedValue(new Error('no outbound HTTP'));
  });

  // A finished job frees its slot and the queue drains its partition again,
  // which reads the database: let that read land before the next reset or the
  // teardown ends the pool under it.
  afterEach(async () => {
    const queue = ctx.app.get<QueuePort>(DEPLOYMENT_QUEUE);
    await until(async () => (await queue.getJobs()).length === 0);
    await new Promise((resolve) => setTimeout(resolve, 250));
  });

  async function until(check: () => Promise<boolean>, ms = 30_000) {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out waiting');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  const rowOf = async (deploymentId: string) => {
    const [row] = await ctx.db
      .select()
      .from(deploymentTable)
      .where(eq(deploymentTable.deploymentId, deploymentId));
    return row;
  };

  const finished = (deploymentId: string) => async () =>
    ['done', 'error'].includes((await rowOf(deploymentId)).status);

  /** The Servers the shell was reached on over SSH. */
  const sshTargets = () =>
    execMock.execAsyncRemote.mock.calls.map((call: unknown[]) => call[0]);

  /** An owner with an Application on a Server of its Organization. */
  async function setUpApplicationOnServer() {
    // A customer of the Hosted instance: sign-up opens once the Instance
    // organization exists, and signs in once confirmed.
    await openHostedSignUp(ctx.db);
    const {
      id: userId,
      organizationId,
      cookie,
    } = await signUpHostedCustomer(httpServer, mail, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
    const ownerCtx = {
      user: { id: userId },
      session: { activeOrganizationId: organizationId },
    };

    // Inserted directly: on a hosted instance ServersService.create meters
    // the Organization against its plan, which is not what this is about.
    const [row] = await ctx.db
      .insert(serverTable)
      .values({
        name: 'eu-west-1',
        ipAddress: '203.0.113.10',
        port: 22,
        organizationId,
      })
      .returning();

    const project = await ctx.app
      .get(ProjectsService)
      .create(ownerCtx, { name: 'cloudgate' });
    const environment = await ctx.app
      .get(EnvironmentsService)
      .create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
        // The customer's Server: the platform host only manages on the Hosted
        // instance, and a deploy to it is refused.
        deployTarget: { kind: 'server', serverId: row.serverId },
      });
    const application = await ctx.app
      .get(ApplicationsService)
      .create(ownerCtx, {
        name: 'Web App',
        appName: 'web-app',
        environmentId: environment.environmentId,
        serverId: row.serverId,
      });
    // A source, so the deploy is not refused as having none.
    await ctx.db
      .update(applicationTable)
      .set({ sourceType: 'docker', dockerImage: 'nginx:1.27' })
      .where(eq(applicationTable.applicationId, application.applicationId));
    return {
      ownerCtx,
      cookie,
      organizationId,
      applicationId: application.applicationId,
      serverId: row.serverId,
    };
  }

  it('runs the in-process queue', () => {
    expect(ctx.app.get(DEPLOYMENT_QUEUE)).toBeInstanceOf(InMemoryQueue);
  });

  it('builds a deploy over SSH on the Application’s Server, posting it nowhere', async () => {
    const { ownerCtx, applicationId, serverId } =
      await setUpApplicationOnServer();

    const record = await deployments.deploy(ownerCtx, applicationId, {
      title: 'Manual deployment',
      description: 'from the dashboard',
    });
    await until(finished(record.deploymentId));

    expect(sshTargets()).toContain(serverId);
    expect(sshTargets().every((target) => target === serverId)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('settles a build a restart cut off as error, and queues a waiting one again, which builds over SSH', async () => {
    const { applicationId, serverId } = await setUpApplicationOnServer();
    const insert = async (status: 'pending' | 'running', at: number) => {
      const [row] = await ctx.db
        .insert(deploymentTable)
        .values({
          applicationId,
          queuedAs: { applicationType: 'application', type: 'deploy' },
          title: 'Manual deployment',
          status,
          logPath: `/tmp/hosted-builds-${at}.log`,
          createdAt: new Date(Date.UTC(2026, 10, 4, 0, 0, at)).toISOString(),
        })
        .returning();
      return row.deploymentId;
    };
    const cutOff = await insert('running', 1);
    const waiting = await insert('pending', 2);

    await deployments.settleBuildsAtStartUp();

    expect(await rowOf(cutOff)).toMatchObject({
      status: 'error',
      description: BUILD_CUT_OFF_BY_RESTART,
    });
    await until(finished(waiting));
    expect(sshTargets()).toContain(serverId);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('of a Frozen Organization', () => {
    afterEach(() => jest.restoreAllMocks());

    it('refuses a deploy asked for by hand, and builds nothing', async () => {
      const { cookie, organizationId, applicationId } =
        await setUpApplicationOnServer();
      await freezeOrganization(ctx, organizationId);
      execMock.execAsyncRemote.mockClear();

      const res = await request(httpServer)
        .post(`/applications/${applicationId}/deployments`)
        .set('Cookie', cookie)
        .send({});

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        code: 'ORGANIZATION_FROZEN',
        message: 'Pay to continue',
      });
      expect(
        await ctx.db
          .select()
          .from(deploymentTable)
          .where(eq(deploymentTable.applicationId, applicationId)),
      ).toEqual([]);
      expect(sshTargets()).toEqual([]);
    });

    it('ends a build still waiting in the queue with the refusal when it is picked up, building nothing', async () => {
      const { organizationId, applicationId } =
        await setUpApplicationOnServer();
      const [waiting] = await ctx.db
        .insert(deploymentTable)
        .values({
          applicationId,
          queuedAs: { applicationType: 'application', type: 'deploy' },
          title: 'Manual deployment',
          status: 'pending',
          logPath: '/tmp/hosted-builds-frozen.log',
        })
        .returning();
      await freezeOrganization(ctx, organizationId);
      execMock.execAsyncRemote.mockClear();

      // Queued again as a restart queues it: the queue picks it up.
      await deployments.settleBuildsAtStartUp();
      await until(finished(waiting.deploymentId));

      expect(await rowOf(waiting.deploymentId)).toMatchObject({
        status: 'error',
        description: 'Pay to continue',
      });
      expect(sshTargets()).toEqual([]);
    });

    it('lets a build already running when the freeze lands finish', async () => {
      const { ownerCtx, organizationId, applicationId, serverId } =
        await setUpApplicationOnServer();
      // Every command of the build, once the engine has claimed its row,
      // waits until the freeze has landed.
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let held = 0;
      execMock.execAsyncRemote.mockImplementation(async () => {
        const running = await ctx.db
          .select()
          .from(deploymentTable)
          .where(
            and(
              eq(deploymentTable.applicationId, applicationId),
              eq(deploymentTable.status, 'running'),
            ),
          );
        if (running.length > 0) {
          held += 1;
          await released;
        }
        return ok;
      });

      const record = await deployments.deploy(ownerCtx, applicationId, {
        title: 'Manual deployment',
        description: 'before the lapse',
      });
      await until(() => Promise.resolve(held > 0));
      await freezeOrganization(ctx, organizationId);
      release();
      await until(finished(record.deploymentId));

      expect((await rowOf(record.deploymentId)).status).toBe('done');
      expect(sshTargets()).toContain(serverId);
    });
  });
});
