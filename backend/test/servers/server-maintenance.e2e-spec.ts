import { createHmac } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { ApplicationsService } from '../../src/applications/applications.service';
import { bucket } from '../../src/buckets/bucket.schema';
import {
  application as applicationTable,
  compose as composeTable,
  deployment as deploymentTable,
  postgres as postgresTable,
  previewDeployment,
  rollback as rollbackTable,
  server as serverTable,
} from '../../src/db/schema';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import type { QueuePort } from '../../src/deployment-queue/queue.port';
import { DeploymentsService } from '../../src/deployments/deployments.service';
import { auditLog } from '../../src/enterprise/audit-logs/audit-log.schema';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { FETCH_CLIENT } from '../../src/git-providers/fetch.provider';
import { GithubService } from '../../src/git-providers/strategies/github/github.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { SERVER_IN_MAINTENANCE_CODE } from '../../src/servers/server-maintenance';
import { withArgvExec } from '../utils/exec-double';
import { seededConfigName } from '../utils/seeded-config-name';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { signUpMember } from '../utils/test-auth';
import { buildZip } from '../utils/zip-archive';

jest.setTimeout(120_000);

/** The words every refusal carries, for the Server named `web-1`. */
const REFUSAL = 'web-1 is in maintenance';

/** What `reached()` lists for a command run locally, on the platform host. */
const PLATFORM_HOST = 'platform host';

/**
 * A Server in maintenance (spec #1420, CONTEXT.md "Maintenance"): an Owner or
 * Admin starts and ends it, and while it holds, nothing new starts
 * containers on the Server — every entry that would is refused with 409
 * `SERVER_IN_MAINTENANCE` before any Deployment row or SSH, and a build
 * queued before it began ends `error` with the same words when picked up.
 *
 * Real here: the queue, its processor, the deployment engine and every
 * service. Faked: the shell, at `RemoteExecService`, the Docker API, and
 * outbound HTTP.
 */
describe('Server maintenance (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let deployments: DeploymentsService;

  const ok = { stdout: '', stderr: '', exitCode: 0 };
  const execMock = withArgvExec({
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  });
  const fetchMock = jest.fn();
  // The Swarm the release reaches: no service yet, one task running, so a
  // build reaches `done`.
  const docker = {
    getService: jest.fn(() => ({
      inspect: jest.fn().mockRejectedValue(new Error('no such service')),
      update: jest.fn().mockResolvedValue(undefined),
    })),
    createService: jest.fn().mockResolvedValue(undefined),
    listTasks: jest
      .fn()
      .mockResolvedValue([
        { Status: { State: 'running', Timestamp: '2026-11-12T00:00:00Z' } },
      ]),
  };
  const getRemoteDocker = jest.fn(() => Promise.resolve(docker));

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: FETCH_CLIENT, useValue: fetchMock },
        { provide: RemoteDockerFactory, useValue: { getRemoteDocker } },
      ],
    });
    http = ctx.app.getHttpServer() as App;
    deployments = ctx.app.get(DeploymentsService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    execMock.execAsync.mockReset().mockResolvedValue(ok);
    execMock.execAsyncRemote.mockReset().mockResolvedValue(ok);
    getRemoteDocker.mockClear();
    fetchMock.mockReset().mockRejectedValue(new Error('no outbound HTTP'));
  });

  // A finished job frees its slot and the queue drains again, which reads the
  // database: let that land before the next reset.
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
  const allDeployments = () => ctx.db.select().from(deploymentTable);

  /**
   * Everywhere Cloudgate reached: each Server it ran a command on over SSH
   * or asked through its Docker API, and `PLATFORM_HOST` for each command it
   * ran locally (a build's clone, a log written beside the backend), so a
   * refusal that comes after any local work fails too.
   */
  const reached = () => [
    ...execMock.execAsync.mock.calls.map(() => PLATFORM_HOST),
    ...execMock.execAsyncRemote.mock.calls.map((call: unknown[]) => call[0]),
    ...getRemoteDocker.mock.calls.map((call: unknown[]) => call[0]),
  ];
  const forgetReached = () => {
    execMock.execAsync.mockClear();
    execMock.execAsyncRemote.mockClear();
    getRemoteDocker.mockClear();
  };

  /**
   * An owner with two Servers, `web-1` and `web-2`, and an Environment that
   * deploys to `web-1`, with a docker-image Application on each.
   */
  async function setUp() {
    const signUp = await request(http).post('/api/auth/sign-up/email').send({
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
    });
    expect(signUp.status).toBe(200);
    const cookie = signUp.headers['set-cookie'];
    const userId = (signUp.body as { user: { id: string } }).user.id;
    const orgs = await request(http)
      .get('/organizations')
      .set('Cookie', cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = {
      user: { id: userId },
      session: { activeOrganizationId: organizationId },
    };

    const serverNamed = async (name: string, ipAddress: string) => {
      const [row] = await ctx.db
        .insert(serverTable)
        .values({ name, ipAddress, port: 22, organizationId })
        .returning();
      return row.serverId;
    };
    const serverId = await serverNamed('web-1', '203.0.113.10');
    const otherServerId = await serverNamed('web-2', '203.0.113.11');

    const project = await ctx.app
      .get(ProjectsService)
      .create(ownerCtx, { name: 'shop' });
    const environment = await ctx.app
      .get(EnvironmentsService)
      .create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
        deployTarget: { kind: 'server', serverId },
      });
    const { environmentId } = environment;

    const applicationOn = async (
      appName: string,
      on: string,
      extra: Partial<typeof applicationTable.$inferInsert> = {},
    ) => {
      const created = await ctx.app.get(ApplicationsService).create(ownerCtx, {
        name: appName,
        appName,
        environmentId,
        serverId: on,
      });
      await ctx.db
        .update(applicationTable)
        .set({ sourceType: 'docker', dockerImage: 'nginx:1.27', ...extra })
        .where(eq(applicationTable.applicationId, created.applicationId));
      return created.applicationId;
    };
    const applicationId = await applicationOn('web', serverId);

    return {
      cookie,
      userId,
      organizationId,
      ownerCtx,
      serverId,
      otherServerId,
      projectId: project.projectId,
      environmentId,
      applicationId,
      applicationOn,
    };
  }

  type SetUp = Awaited<ReturnType<typeof setUp>>;

  const startMaintenance = (cookie: string, serverId: string) =>
    request(http)
      .post(`/servers/${serverId}/start-maintenance`)
      .set('Cookie', cookie);
  const endMaintenance = (cookie: string, serverId: string) =>
    request(http)
      .post(`/servers/${serverId}/end-maintenance`)
      .set('Cookie', cookie);

  /** `setUp`, with `web-1` in maintenance and nothing reached yet. */
  async function inMaintenance(): Promise<SetUp> {
    const given = await setUp();
    expect((await startMaintenance(given.cookie, given.serverId)).status).toBe(
      200,
    );
    forgetReached();
    return given;
  }

  /** The refusal every entry answers, and that nothing was recorded or reached. */
  async function expectRefused(
    res: request.Response,
    before: unknown[] = [],
  ): Promise<void> {
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: SERVER_IN_MAINTENANCE_CODE,
      message: REFUSAL,
    });
    expect(await allDeployments()).toEqual(before);
    expect(reached()).toEqual([]);
  }

  const WEBHOOK_SECRET = 'wh-secret';

  /** A GitHub connection whose deliveries are signed with `WEBHOOK_SECRET`. */
  const connectGithub = (ownerCtx: SetUp['ownerCtx']) =>
    ctx.app.get(GithubService).create(ownerCtx, {
      name: 'Team GitHub',
      appName: 'cloudgate-app',
      appId: 12345,
      clientId: 'Iv1.abc123',
      clientSecret: 'github-client-secret',
      installationId: '99887766',
      privateKey:
        '-----BEGIN RSA PRIVATE KEY-----\nMIIEfake\n-----END RSA PRIVATE KEY-----',
      webhookSecret: WEBHOOK_SECRET,
    });

  /** The source of an Application built from octabyte-io/cloudgate's main. */
  const githubSource = (githubId: string) => ({
    sourceType: 'github' as const,
    githubId,
    owner: 'octabyte-io',
    repository: 'cloudgate',
    branch: 'main',
  });

  /**
   * A signed `push` of main to octabyte-io/cloudgate, as GitHub delivers it,
   * naming the files its commit touched.
   */
  function pushToMain(
    sha = '9f1c2e4b7a3d5f60182736455463728190abcdef',
    modified: string[] = ['src/server.ts'],
  ) {
    const payload = {
      ref: 'refs/heads/main',
      before: '1111111111111111111111111111111111111111',
      after: sha,
      deleted: false,
      installation: { id: 99887766 },
      repository: {
        name: 'cloudgate',
        full_name: 'octabyte-io/cloudgate',
        owner: { name: 'octabyte-io', login: 'octabyte-io' },
      },
      pusher: { name: 'grace' },
      head_commit: { id: sha, message: 'fix: a thing' },
      commits: [
        { id: sha, message: 'fix: a thing', added: [], modified, removed: [] },
      ],
    };
    return request(http)
      .post('/github/webhook')
      .set('x-github-event', 'push')
      .set(
        'x-hub-signature-256',
        `sha256=${createHmac('sha256', WEBHOOK_SECRET)
          .update(JSON.stringify(payload))
          .digest('hex')}`,
      )
      .send(payload);
  }

  /**
   * Refuses a preview redeploy and a Requested preview of the Application,
   * and writes no preview.
   */
  async function expectPreviewsRefused(cookie: string, applicationId: string) {
    await ctx.db
      .update(applicationTable)
      .set({ requestedPreviewsAllowed: true })
      .where(eq(applicationTable.applicationId, applicationId));
    const [preview] = await ctx.db
      .insert(previewDeployment)
      .values({
        appName: 'preview-web-pr1',
        applicationId,
        branch: 'feature/x',
        pullRequestId: '1',
        pullRequestNumber: '1',
        pullRequestTitle: 'Add a thing',
        pullRequestURL: 'https://example.com/pr/1',
        domain: 'preview-web-pr1.example.com',
      })
      .returning();

    await expectRefused(
      await request(http)
        .post(`/preview-deployments/${preview.previewDeploymentId}/redeploy`)
        .set('Cookie', cookie)
        .send({}),
    );
    await expectRefused(
      await request(http)
        .post(`/applications/${applicationId}/preview-deployments`)
        .set('Cookie', cookie)
        .send({ branch: 'feature/y' }),
    );
    // The Requested preview was never written.
    expect(
      await ctx.db
        .select()
        .from(previewDeployment)
        .where(eq(previewDeployment.applicationId, applicationId)),
    ).toHaveLength(1);
  }

  /** A CLI drop upload to the Application. */
  const dropTo = (cookie: string, applicationId: string) =>
    request(http)
      .post(`/applications/${applicationId}/drop`)
      .set('Cookie', cookie)
      .attach('zip', buildZip([{ name: 'index.js', content: 'x\n' }]), 'b.zip');

  /**
   * A build of the Application queued before `web-1` went into maintenance,
   * picked up afterwards as a restart picks it up; answers its row once it
   * has ended.
   */
  async function claimedAfterMaintenanceBegan(
    given: SetUp,
    applicationId: string,
  ) {
    const [waiting] = await ctx.db
      .insert(deploymentTable)
      .values({
        applicationId,
        queuedAs: { applicationType: 'application', type: 'deploy' },
        title: 'Manual deployment',
        status: 'pending',
        logPath: '/tmp/server-maintenance-queued.log',
      })
      .returning();
    expect((await startMaintenance(given.cookie, given.serverId)).status).toBe(
      200,
    );
    forgetReached();

    // Queued again as a restart queues it: the queue picks it up.
    await deployments.settleBuildsAtStartUp();
    await until(finished(waiting.deploymentId));
    return rowOf(waiting.deploymentId);
  }

  describe('starting and ending it', () => {
    it('is not in maintenance when the Server is new', async () => {
      const { cookie, serverId } = await setUp();

      const read = await request(http)
        .get(`/servers/${serverId}`)
        .set('Cookie', cookie);

      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({
        maintenanceSince: null,
        maintenanceStartedBy: null,
      });
    });

    it('starts maintenance, which the Server reports with when it began and who started it', async () => {
      const { cookie, userId, serverId } = await setUp();
      const before = Date.now();

      const started = await startMaintenance(cookie, serverId);

      expect(started.status).toBe(200);
      const read = await request(http)
        .get(`/servers/${serverId}`)
        .set('Cookie', cookie);
      const body = read.body as {
        maintenanceSince: string;
        maintenanceStartedBy: string;
      };
      expect(Date.parse(body.maintenanceSince)).toBeGreaterThanOrEqual(
        before - 1000,
      );
      expect(body.maintenanceStartedBy).toBe(userId);
      const list = await request(http).get('/servers').set('Cookie', cookie);
      expect(list.body).toContainEqual(
        expect.objectContaining({
          serverId,
          maintenanceSince: body.maintenanceSince,
        }),
      );
    });

    it('refuses a second Start maintenance with 409 and keeps when it began', async () => {
      const { cookie, serverId } = await setUp();
      const first = await startMaintenance(cookie, serverId);
      const since = (first.body as { maintenanceSince: string })
        .maintenanceSince;

      const again = await startMaintenance(cookie, serverId);

      expect(again.status).toBe(409);
      expect((again.body as { message: string }).message).toBe(
        'web-1 is already in maintenance',
      );
      const [row] = await ctx.db
        .select()
        .from(serverTable)
        .where(eq(serverTable.serverId, serverId));
      expect(row.maintenanceSince).toBe(since);
    });

    it('ends maintenance, after which the Server reports none', async () => {
      const { cookie, serverId } = await setUp();
      await startMaintenance(cookie, serverId);

      const ended = await endMaintenance(cookie, serverId);

      expect(ended.status).toBe(200);
      expect(ended.body).toMatchObject({
        maintenanceSince: null,
        maintenanceStartedBy: null,
      });
    });

    it('refuses End maintenance with 409 on a Server not in maintenance', async () => {
      const { cookie, serverId } = await setUp();

      const ended = await endMaintenance(cookie, serverId);

      expect(ended.status).toBe(409);
      expect((ended.body as { message: string }).message).toBe(
        'web-1 is not in maintenance',
      );
    });

    it('records each start and end in the audit trail as a change to the Server', async () => {
      const { cookie, serverId } = await setUp();

      await startMaintenance(cookie, serverId);
      await endMaintenance(cookie, serverId);

      const rows = async () =>
        ctx.db
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.resourceType, 'server'),
              eq(auditLog.resourceId, serverId),
            ),
          );
      await until(async () => (await rows()).length === 2);
      const written = await rows();
      expect(written.map((row) => row.action)).toEqual(['update', 'update']);
      expect(written.map((row) => row.metadata).join(' ')).toContain(
        'start-maintenance',
      );
      expect(written.map((row) => row.metadata).join(' ')).toContain(
        'end-maintenance',
      );
    });

    it('refuses Start and End maintenance to a Member without the Server grant', async () => {
      const { cookie, serverId } = await setUp();
      const member = await signUpMember(http, cookie);

      const started = await startMaintenance(member.cookie, serverId);
      await startMaintenance(cookie, serverId);
      const ended = await endMaintenance(member.cookie, serverId);

      expect(started.status).toBe(403);
      expect(ended.status).toBe(403);
      const [row] = await ctx.db
        .select()
        .from(serverTable)
        .where(eq(serverTable.serverId, serverId));
      expect(row.maintenanceSince).not.toBeNull();
    });
  });

  describe('refusing new work on it', () => {
    it('refuses an Application deploy', async () => {
      const { cookie, applicationId } = await inMaintenance();

      await expectRefused(
        await request(http)
          .post(`/applications/${applicationId}/deployments`)
          .set('Cookie', cookie)
          .send({}),
      );
    });

    it('refuses an Application redeploy', async () => {
      const { cookie, applicationId } = await inMaintenance();

      await expectRefused(
        await request(http)
          .post(`/applications/${applicationId}/redeploy`)
          .set('Cookie', cookie)
          .send({}),
      );
    });

    it('refuses an Application Start', async () => {
      const { cookie, applicationId } = await inMaintenance();

      await expectRefused(
        await request(http)
          .post(`/applications/${applicationId}/start`)
          .set('Cookie', cookie),
      );
    });

    it('refuses a deploy whose build Server is in maintenance', async () => {
      const { cookie, applicationOn, otherServerId, serverId } =
        await inMaintenance();
      const builtThere = await applicationOn('api', otherServerId, {
        buildServerId: serverId,
      });

      await expectRefused(
        await request(http)
          .post(`/applications/${builtThere}/deployments`)
          .set('Cookie', cookie)
          .send({}),
      );
    });

    it('refuses a CLI drop upload, before the archive reaches the Server', async () => {
      const { cookie, applicationId } = await inMaintenance();

      await expectRefused(await dropTo(cookie, applicationId));
    });

    it('refuses a CLI drop upload whose build Server is in maintenance', async () => {
      const { cookie, applicationOn, otherServerId, serverId } =
        await inMaintenance();
      const builtThere = await applicationOn('api', otherServerId, {
        buildServerId: serverId,
      });

      await expectRefused(await dropTo(cookie, builtThere));
    });

    it('refuses a Compose deploy and Start', async () => {
      const { cookie, environmentId, serverId } = await inMaintenance();
      const [stack] = await ctx.db
        .insert(composeTable)
        .values({
          name: 'stack',
          appName: 'stack',
          environmentId,
          configName: seededConfigName(),
          serverId,
          sourceType: 'raw',
          composeFile: 'services:\n  web:\n    image: nginx:1.27\n',
        })
        .returning();

      await expectRefused(
        await request(http)
          .post(`/compose/${stack.composeId}/deployments`)
          .set('Cookie', cookie)
          .send({}),
      );
      await expectRefused(
        await request(http)
          .post(`/compose/${stack.composeId}/start`)
          .set('Cookie', cookie),
      );
    });

    it('refuses a preview redeploy and a Requested preview', async () => {
      const { cookie, applicationId } = await inMaintenance();

      await expectPreviewsRefused(cookie, applicationId);
    });

    it('refuses a preview redeploy and a Requested preview whose build Server is in maintenance', async () => {
      const { cookie, applicationOn, otherServerId, serverId } =
        await inMaintenance();
      const builtThere = await applicationOn('api', otherServerId, {
        buildServerId: serverId,
      });

      await expectPreviewsRefused(cookie, builtThere);
    });

    it('refuses a git push before anything is recorded', async () => {
      const { ownerCtx, applicationOn, serverId } = await inMaintenance();
      const connected = await connectGithub(ownerCtx);
      await applicationOn('pushed', serverId, githubSource(connected.githubId));

      await expectRefused(await pushToMain());
    });

    it('refuses a git push whose build Server is in maintenance', async () => {
      const { ownerCtx, applicationOn, otherServerId, serverId } =
        await inMaintenance();
      const connected = await connectGithub(ownerCtx);
      await applicationOn('pushed', otherServerId, {
        ...githubSource(connected.githubId),
        buildServerId: serverId,
      });

      await expectRefused(await pushToMain());
    });

    it('refuses a git push whose build its push plan would hold, recording no held build', async () => {
      const given = await setUp();
      const { cookie, ownerCtx, projectId, environmentId, applicationOn } =
        given;
      const connected = await connectGithub(ownerCtx);
      await applicationOn('shop', given.serverId, {
        ...githubSource(connected.githubId),
        buildType: 'dockerfile',
        port: 8080,
      });
      // `web` stays the console's, so the push plan changes shop alone.
      const shopConfig = (port: number) =>
        `version: 1\nservices:\n  web:\n    kind: web\n    managed: console\n  shop:\n    kind: web\n    port: ${port}\n    source:\n      github: octabyte-io/cloudgate\n    build:\n      type: dockerfile\n`;
      // The config moves into the repository describing what is saved.
      ctx.configReader.commit('octabyte-io/cloudgate', shopConfig(8080));
      const to = {
        kind: 'repository',
        gitProviderId: connected.gitProvider.gitProviderId,
        repository: 'octabyte-io/cloudgate',
      };
      const previewed = await request(http)
        .post(`/projects/${projectId}/config/move/preview`)
        .set('Cookie', cookie)
        .send({ to });
      expect(previewed.status).toBe(200);
      const moved = await request(http)
        .post(`/projects/${projectId}/config/move`)
        .set('Cookie', cookie)
        .send({ to, reads: (previewed.body as { reads: unknown }).reads });
      expect(moved.status).toBe(200);
      expect((await startMaintenance(cookie, given.serverId)).status).toBe(200);
      forgetReached();

      // The same push changes shop's code and its own config entry.
      const sha = ctx.configReader.commit(
        'octabyte-io/cloudgate',
        shopConfig(9090),
      );
      await expectRefused(
        await pushToMain(sha, ['cloudgate.yaml', 'src/server.ts']),
      );

      // The push plan its build would have been held for was prepared.
      const plan = await request(http)
        .get(`/environments/${environmentId}/plan`)
        .set('Cookie', cookie);
      expect(plan.body).toMatchObject({
        plan: {
          source: 'push',
          commitSha: sha,
          steps: [expect.objectContaining({ configName: 'shop' })],
        },
      });
    });

    it('refuses a Database deploy, Start and rebuild, before the running service is removed', async () => {
      const { cookie, environmentId, serverId } = await inMaintenance();
      const [database] = await ctx.db
        .insert(postgresTable)
        .values({
          name: 'DB',
          appName: 'db',
          environmentId,
          configName: seededConfigName(),
          dockerImage: 'postgres:16',
          databaseName: 'shop',
          databaseUser: 'shop',
          databasePassword: 'super-secret-database-password',
          serverId,
        })
        .returning();

      for (const action of ['deploy', 'start', 'rebuild']) {
        await expectRefused(
          await request(http)
            .post(`/postgres/${database.postgresId}/${action}`)
            .set('Cookie', cookie),
        );
      }
    });

    it("refuses a bucket's deploy once its plan is applied, starting no Garage", async () => {
      const { cookie, projectId, environmentId } = await inMaintenance();
      // The Apply answers before the bucket's deploy runs, and a refused
      // deploy is the plan applier's warning, never the caller's response.
      const warned = jest.spyOn(Logger.prototype, 'warn');
      try {
        const saved = await request(http)
          .post(`/projects/${projectId}/config/plans`)
          .set('Cookie', cookie)
          .send({
            // `web` stays the console's, so the plan destroys nothing.
            text: 'version: 1\nservices:\n  web:\n    kind: web\n    managed: console\n  uploads:\n    kind: bucket\n',
          });
        expect(saved.status).toBe(201);
        const open = (
          saved.body as { plans: { planId: string; environmentId: string }[] }
        ).plans.find((one) => one.environmentId === environmentId);
        const applied = await request(http)
          .post(`/environments/${environmentId}/plan/apply`)
          .set('Cookie', cookie)
          .send({ planId: open?.planId, confirmDestroy: [] });
        expect(applied.status).toBe(200);

        await until(() =>
          Promise.resolve(
            warned.mock.calls.some(([line]) => String(line).includes(REFUSAL)),
          ),
        );
      } finally {
        warned.mockRestore();
      }

      const [made] = await ctx.db.select().from(bucket);
      expect(made.applicationStatus).toBe('idle');
      expect(docker.createService).not.toHaveBeenCalled();
      expect(await allDeployments()).toEqual([]);
      // The Apply wrote the bucket's Domain route, which starts nothing;
      // nothing else reached the Server, its Docker API or the platform host.
      expect(
        execMock.execAsyncRemote.mock.calls.map((call: unknown[]) => call[1]),
      ).toEqual([
        expect.stringContaining('/etc/cloudgate/traefik/dynamic/') as string,
      ]);
      expect(getRemoteDocker).not.toHaveBeenCalled();
      expect(execMock.execAsync).not.toHaveBeenCalled();
    });

    it('refuses a Rollback', async () => {
      const { cookie, applicationId } = await inMaintenance();
      const [done] = await ctx.db
        .insert(deploymentTable)
        .values({
          applicationId,
          title: 'Manual deployment',
          status: 'done',
          logPath: '/tmp/server-maintenance-rollback.log',
        })
        .returning();
      const [point] = await ctx.db
        .insert(rollbackTable)
        .values({
          deploymentId: done.deploymentId,
          image: 'web:v1',
          fullContext: {} as never,
        })
        .returning();

      await expectRefused(
        await request(http)
          .post(`/rollbacks/${point.rollbackId}/rollback`)
          .set('Cookie', cookie),
        [done],
      );
    });

    it('refuses a Compose restart', async () => {
      const { cookie, environmentId, serverId } = await inMaintenance();
      const [stack] = await ctx.db
        .insert(composeTable)
        .values({
          name: 'stack',
          appName: 'stack',
          environmentId,
          configName: seededConfigName(),
          serverId,
          sourceType: 'raw',
          composeType: 'docker-compose',
          composeFile: 'services:\n  web:\n    image: nginx:1.27\n',
        })
        .returning();

      await expectRefused(
        await request(http)
          .post(`/compose/${stack.composeId}/restart`)
          .set('Cookie', cookie),
      );
    });

    it('refuses an Application reload', async () => {
      const { cookie, applicationId } = await inMaintenance();

      await expectRefused(
        await request(http)
          .post(`/applications/${applicationId}/reload`)
          .set('Cookie', cookie),
      );
    });

    it('refuses a container start and restart on the Server', async () => {
      const { cookie, serverId } = await inMaintenance();

      for (const action of ['start', 'restart']) {
        await expectRefused(
          await request(http)
            .post(`/docker/containers/a1b2c3d4e5f6/${action}`)
            .set('Cookie', cookie)
            .send({ serverId }),
        );
      }
    });

    it("refuses a Cron service's Run now", async () => {
      const { cookie, applicationOn, serverId } = await inMaintenance();
      const nightly = await applicationOn('nightly', serverId, {
        configKind: 'cron',
        cronSchedule: '0 3 * * *',
        cronTimezone: 'UTC',
        cronTimeoutSeconds: 3600,
      });
      // The build a run would start from.
      const [built] = await ctx.db
        .insert(deploymentTable)
        .values({
          applicationId: nightly,
          title: 'Manual deployment',
          status: 'done',
          logPath: '/tmp/server-maintenance-cron-build.log',
          finishedAt: '2026-11-12T00:00:00.000Z',
        })
        .returning();

      await expectRefused(
        await request(http)
          .post(`/applications/${nightly}/run`)
          .set('Cookie', cookie),
        [built],
      );
    });
  });

  describe('builds already on their way', () => {
    it('ends a build queued before maintenance began as error with the refusal, building nothing', async () => {
      const given = await setUp();

      expect(
        await claimedAfterMaintenanceBegan(given, given.applicationId),
      ).toMatchObject({ status: 'error', description: REFUSAL });
      expect(reached()).toEqual([]);
    });

    it('ends a queued build whose build Server went into maintenance as error with the refusal', async () => {
      const given = await setUp();
      const builtThere = await given.applicationOn('api', given.otherServerId, {
        buildServerId: given.serverId,
      });

      expect(
        await claimedAfterMaintenanceBegan(given, builtThere),
      ).toMatchObject({ status: 'error', description: REFUSAL });
      expect(reached()).toEqual([]);
    });

    it('lets a build already running when maintenance begins finish', async () => {
      const { cookie, ownerCtx, serverId, applicationId } = await setUp();
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
        description: 'before maintenance',
      });
      await until(() => Promise.resolve(held > 0));
      expect((await startMaintenance(cookie, serverId)).status).toBe(200);
      release();
      await until(finished(record.deploymentId));

      expect((await rowOf(record.deploymentId)).status).toBe('done');
    });
  });

  describe('everything else', () => {
    it('deploys an Application on another Server while one is in maintenance', async () => {
      const { ownerCtx, applicationOn, otherServerId } = await inMaintenance();
      const elsewhere = await applicationOn('api', otherServerId);

      const record = await deployments.deploy(ownerCtx, elsewhere, {});
      await until(finished(record.deploymentId));

      expect((await rowOf(record.deploymentId)).status).toBe('done');
      expect(reached()).toContain(otherServerId);
    });

    it('deploys to the Server again once maintenance has ended', async () => {
      const { cookie, ownerCtx, serverId, applicationId } =
        await inMaintenance();
      expect((await endMaintenance(cookie, serverId)).status).toBe(200);

      const record = await deployments.deploy(ownerCtx, applicationId, {});
      await until(finished(record.deploymentId));

      expect((await rowOf(record.deploymentId)).status).toBe('done');
      expect(reached()).toContain(serverId);
    });

    it("runs the Server's setup while it is in maintenance, as its operator's own tool", async () => {
      const { cookie, serverId } = await inMaintenance();

      const ran = await request(http)
        .post(`/servers/${serverId}/setup`)
        .set('Cookie', cookie);

      expect(ran.status).toBe(200);
      expect(ran.body).toEqual({ status: 'ok' });
      expect(reached()).toContain(serverId);
    });
  });
});
