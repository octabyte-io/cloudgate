import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { ApplicationsService } from '../../src/applications/applications.service';
import { BOUGHT_SERVER_NOT_READY_CODE } from '../../src/bought-servers/server-readiness';
import type { BoughtServerStage } from '../../src/bought-servers/bought-server.schema';
import {
  application as applicationTable,
  boughtServer,
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
import { EnvironmentsService } from '../../src/environments/environments.service';
import { FETCH_CLIENT } from '../../src/git-providers/fetch.provider';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { seededConfigName } from '../utils/seeded-config-name';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { buildZip } from '../utils/zip-archive';

jest.setTimeout(120_000);

/** What `reached()` lists for a command run locally, on the platform host. */
const PLATFORM_HOST = 'platform host';

/** The refusal's words for `web-1`, ending in what the caller asked to do. */
const refusal = (action: string) =>
  `web-1 is powered off by an operator: ${action} once it is powered back on`;

/**
 * A Bought Server an Operator powered off (#1401) is refused, with a 409
 * naming it, by every action that starts or runs something on it, as a
 * deploy to it is (#115): a rollback, a Start or restart of a Compose stack,
 * an Application, a database or a container, a Cron service's Run now, a
 * CLI drop upload and a preview. Each is an action a Server in maintenance
 * refuses (`server-maintenance.e2e-spec.ts`); before, each reached the
 * powered-off machine over SSH and failed there with a 500.
 *
 * Only power-off: a Bought Server being changed is not held back by these
 * actions, which never waited for Ready.
 *
 * The power-off is the Operator's (`operator-abuse.e2e-spec.ts` drives it
 * through the provider); here it is the row it leaves, `poweredOffAt` set.
 * Real here: every service and the queue. Faked: the shell, at
 * `RemoteExecService`, which cannot connect to a powered-off machine, as
 * SSH cannot; the Docker API; and outbound HTTP.
 */
describe('A powered-off Bought Server (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;

  const ok = { stdout: '', stderr: '', exitCode: 0 };
  /** The Servers whose machines are off: SSH and Docker cannot reach them. */
  const off = new Set<string>();
  const unreachable = (serverId: string | null) =>
    serverId !== null && off.has(serverId)
      ? Promise.reject(new Error('connect ECONNREFUSED 203.0.113.10:22'))
      : null;
  const execMock = withArgvExec({
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  });
  const fetchMock = jest.fn();
  const docker = {
    getService: jest.fn(() => ({
      inspect: jest.fn().mockRejectedValue(new Error('no such service')),
      update: jest.fn().mockResolvedValue(undefined),
    })),
    createService: jest.fn().mockResolvedValue(undefined),
    listTasks: jest.fn().mockResolvedValue([]),
  };
  const getRemoteDocker = jest.fn(
    (serverId: string | null) =>
      unreachable(serverId) ?? Promise.resolve(docker),
  );

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: FETCH_CLIENT, useValue: fetchMock },
        { provide: RemoteDockerFactory, useValue: { getRemoteDocker } },
      ],
    });
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    off.clear();
    execMock.execAsync.mockReset().mockResolvedValue(ok);
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation(
        (serverId: string | null) =>
          unreachable(serverId) ?? Promise.resolve(ok),
      );
    getRemoteDocker.mockClear();
    fetchMock.mockReset().mockRejectedValue(new Error('no outbound HTTP'));
  });

  // A finished job frees its slot and the queue drains again, which reads the
  // database: let that land before the next reset.
  afterEach(async () => {
    const queue = ctx.app.get<QueuePort>(DEPLOYMENT_QUEUE);
    const deadline = Date.now() + 30_000;
    while ((await queue.getJobs()).length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  });

  /**
   * Every Server Cloudgate reached, over SSH or its Docker API, and
   * `PLATFORM_HOST` for each command it ran locally.
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
  const allDeployments = () => ctx.db.select().from(deploymentTable);

  /**
   * An owner with a Bought Server `web-1`, Ready, and a Server of their own
   * `web-2`, an Environment that deploys to `web-1`, and a docker-image
   * Application on it.
   */
  async function setUp(stage: BoughtServerStage = 'ready') {
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
    await ctx.db.insert(boughtServer).values({
      id: serverId,
      organizationId,
      serverId,
      name: 'web-1',
      stage,
      serverType: 'cpx22',
      location: 'hel1',
      termsAcceptedBy: userId,
      termsAcceptedAt: new Date(),
    });

    const project = await ctx.app
      .get(ProjectsService)
      .create(ownerCtx, { name: 'shop' });
    const { environmentId } = await ctx.app
      .get(EnvironmentsService)
      .create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
        deployTarget: { kind: 'server', serverId },
      });

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

    /** A docker-compose stack on `web-1`. */
    const stackOn = async () => {
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
      return stack.composeId;
    };

    return {
      cookie,
      serverId,
      otherServerId,
      environmentId,
      applicationId,
      applicationOn,
      stackOn,
    };
  }

  type SetUp = Awaited<ReturnType<typeof setUp>>;

  /** `web-1` powered off by an Operator, as the abuse action leaves it. */
  async function powerOff(serverId: string) {
    await ctx.db
      .update(boughtServer)
      .set({ poweredOffAt: new Date(), poweredOffReason: 'Port scan' })
      .where(eq(boughtServer.serverId, serverId));
    off.add(serverId);
  }

  /** `setUp`, with `web-1` powered off and nothing reached yet. */
  async function poweredOff(): Promise<SetUp> {
    const given = await setUp();
    await powerOff(given.serverId);
    forgetReached();
    return given;
  }

  /** The 409 naming `web-1`, and that nothing was recorded or reached. */
  async function expectRefused(
    res: request.Response,
    action: string,
    before: unknown[] = [],
  ): Promise<void> {
    expect({ status: res.status, body: res.body as unknown }).toEqual({
      status: 409,
      body: expect.objectContaining({
        code: BOUGHT_SERVER_NOT_READY_CODE,
        message: refusal(action),
      }) as unknown,
    });
    expect(await allDeployments()).toEqual(before);
    expect(reached()).toEqual([]);
  }

  /** A CLI drop upload to the Application. */
  const dropTo = (cookie: string, applicationId: string) =>
    request(http)
      .post(`/applications/${applicationId}/drop`)
      .set('Cookie', cookie)
      .attach('zip', buildZip([{ name: 'index.js', content: 'x\n' }]), 'b.zip');

  /** A finished build of the Application, which a rollback or run starts from. */
  async function builtOnce(applicationId: string) {
    const [done] = await ctx.db
      .insert(deploymentTable)
      .values({
        applicationId,
        title: 'Manual deployment',
        status: 'done',
        logPath: '/tmp/powered-off-build.log',
        finishedAt: '2026-11-12T00:00:00.000Z',
      })
      .returning();
    return done;
  }

  describe('refusing what would run on it', () => {
    it('refuses a Rollback', async () => {
      const { cookie, applicationId } = await poweredOff();
      const done = await builtOnce(applicationId);
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
        'roll back',
        [done],
      );
    });

    it('refuses a Compose Start and restart', async () => {
      const { cookie, stackOn } = await poweredOff();
      const composeId = await stackOn();

      await expectRefused(
        await request(http)
          .post(`/compose/${composeId}/start`)
          .set('Cookie', cookie),
        'start the stack',
      );
      await expectRefused(
        await request(http)
          .post(`/compose/${composeId}/restart`)
          .set('Cookie', cookie),
        'restart the stack',
      );
    });

    it('refuses an Application Start and reload', async () => {
      const { cookie, applicationId } = await poweredOff();

      await expectRefused(
        await request(http)
          .post(`/applications/${applicationId}/start`)
          .set('Cookie', cookie),
        'start the Service',
      );
      await expectRefused(
        await request(http)
          .post(`/applications/${applicationId}/reload`)
          .set('Cookie', cookie),
        'reload the Service',
      );
    });

    it('refuses a Database Start and rebuild, before the running service is removed', async () => {
      const { cookie, environmentId, serverId } = await poweredOff();
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

      await expectRefused(
        await request(http)
          .post(`/postgres/${database.postgresId}/start`)
          .set('Cookie', cookie),
        'start the database',
      );
      await expectRefused(
        await request(http)
          .post(`/postgres/${database.postgresId}/rebuild`)
          .set('Cookie', cookie),
        'rebuild the database',
      );
    });

    it('refuses a container start and restart on it', async () => {
      const { cookie, serverId } = await poweredOff();

      for (const action of ['start', 'restart']) {
        await expectRefused(
          await request(http)
            .post(`/docker/containers/a1b2c3d4e5f6/${action}`)
            .set('Cookie', cookie)
            .send({ serverId }),
          `${action} the container`,
        );
      }
    });

    it("refuses a Cron service's Run now", async () => {
      const { cookie, applicationOn, serverId } = await poweredOff();
      const nightly = await applicationOn('nightly', serverId, {
        configKind: 'cron',
        cronSchedule: '0 3 * * *',
        cronTimezone: 'UTC',
        cronTimeoutSeconds: 3600,
      });
      const built = await builtOnce(nightly);

      await expectRefused(
        await request(http)
          .post(`/applications/${nightly}/run`)
          .set('Cookie', cookie),
        'run it',
        [built],
      );
    });

    it('refuses a CLI drop upload, run or build Server, before the archive reaches it', async () => {
      const { cookie, applicationId, applicationOn, otherServerId, serverId } =
        await poweredOff();
      const builtThere = await applicationOn('api', otherServerId, {
        buildServerId: serverId,
      });

      await expectRefused(await dropTo(cookie, applicationId), 'upload');
      await expectRefused(await dropTo(cookie, builtThere), 'upload');
    });

    it('refuses a preview redeploy and a Requested preview', async () => {
      const { cookie, applicationId } = await poweredOff();
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
        'deploy a preview',
      );
      await expectRefused(
        await request(http)
          .post(`/applications/${applicationId}/preview-deployments`)
          .set('Cookie', cookie)
          .send({ branch: 'feature/y' }),
        'deploy a preview',
      );
      expect(
        await ctx.db
          .select()
          .from(previewDeployment)
          .where(eq(previewDeployment.applicationId, applicationId)),
      ).toHaveLength(1);
    });
  });

  describe('everything else', () => {
    it('restarts a Compose stack on it once it is powered back on', async () => {
      const { cookie, serverId, stackOn } = await poweredOff();
      const composeId = await stackOn();
      await ctx.db
        .update(boughtServer)
        .set({ poweredOffAt: null, poweredOffReason: null })
        .where(eq(boughtServer.serverId, serverId));
      off.delete(serverId);

      const restarted = await request(http)
        .post(`/compose/${composeId}/restart`)
        .set('Cookie', cookie);

      expect(restarted.status).toBe(200);
      expect(reached()).toContain(serverId);
    });

    it('restarts a Compose stack on a Bought Server being changed, which only a deploy waits out', async () => {
      const { cookie, serverId, stackOn } = await setUp('changing');
      const composeId = await stackOn();
      forgetReached();

      const restarted = await request(http)
        .post(`/compose/${composeId}/restart`)
        .set('Cookie', cookie);

      expect(restarted.status).toBe(200);
      expect(reached()).toContain(serverId);
    });
  });
});
