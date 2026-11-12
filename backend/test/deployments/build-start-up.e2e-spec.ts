import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { ComposeService } from '../../src/compose/compose.service';
import {
  application as applicationTable,
  compose as composeTable,
  deployment as deploymentTable,
  previewDeployment,
} from '../../src/db/schema';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import {
  BUILD_CUT_OFF_BY_RESTART,
  DeploymentsService,
  NOT_STARTED_BEFORE_RESTART,
  PREVIEW_BUILD_NOT_REQUEUED,
} from '../../src/deployments/deployments.service';
import type { QueuedAs } from '../../src/deployments/deployment.schema';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import type { QueuePort } from '../../src/deployment-queue/queue.port';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { PreviewDeploymentsService } from '../../src/preview-deployments/preview-deployments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(60_000);

/**
 * A Docker build across a backend restart (after Cloud runs):
 * the build queue is in memory, so the rows are what survive, and start-up
 * settles them — a build still `pending` is queued again in `createdAt`
 * order as exactly the job it was queued as, one still `running` ends `error`
 * cut off and is never run again by itself, and a `held` one is left for its
 * plan. A `pending` row that cannot prove what it was queued as — a deleted
 * preview's build above all — ends `error` and is never built as a guess.
 *
 * Real here: `DeploymentsService`, the in-memory queue and its one build at a
 * time on a Server without a license, the processor and its loaders, and the
 * cancel route. Faked: the engine, at its boundary, as the deploy-trigger
 * suite fakes it, and the shell. A restart is the start-up hook called on a
 * database holding the rows a cut-off process left.
 */
describe('Docker builds at start-up (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let deployments: DeploymentsService;

  const ok = { stdout: '', stderr: '', exitCode: 0 };
  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  };
  type Meta = { deploymentId?: string };
  const engineMock = {
    deploy: jest.fn<Promise<void>, [{ applicationId: string }, Meta]>(),
    deployCompose: jest.fn<Promise<void>, [{ composeId: string }, Meta]>(),
  };
  /** The Deployments the engine was asked to build, in the order it was. */
  let built: string[] = [];
  /** Held open until released, so the next build waits behind it. */
  let hold: Promise<void> = Promise.resolve();
  const claim = (_: unknown, meta: Meta) => {
    if (meta.deploymentId) built.push(meta.deploymentId);
    return hold;
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: DeploymentEngineService, useValue: engineMock },
      ],
    });
    server = ctx.app.getHttpServer() as App;
    deployments = ctx.app.get(DeploymentsService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    execMock.execAsync.mockReset().mockResolvedValue(ok);
    execMock.execAsyncRemote.mockReset().mockResolvedValue(ok);
    built = [];
    hold = Promise.resolve();
    engineMock.deploy.mockReset().mockImplementation(claim);
    engineMock.deployCompose.mockReset().mockImplementation(claim);
  });

  async function until(check: () => boolean | Promise<boolean>, ms = 10_000) {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out waiting');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const statusOf = async (deploymentId: string) => {
    const [row] = await ctx.db
      .select()
      .from(deploymentTable)
      .where(eq(deploymentTable.deploymentId, deploymentId));
    return row;
  };

  /** An owner, two Applications and a Compose stack, all on the platform host. */
  async function setUp() {
    const signUp = await request(server).post('/api/auth/sign-up/email').send({
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
    });
    expect(signUp.status).toBe(200);
    const cookie = signUp.headers['set-cookie'];
    const userId = (signUp.body as { user: { id: string } }).user.id;
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = {
      user: { id: userId },
      session: { activeOrganizationId: organizationId },
    };
    const project = await ctx.app
      .get(ProjectsService)
      .create(ownerCtx, { name: 'cloudgate' });
    const environment = await ctx.app
      .get(EnvironmentsService)
      .create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
      });
    const applications = ctx.app.get(ApplicationsService);
    const make = async (appName: string) =>
      (
        await applications.create(ownerCtx, {
          name: appName,
          appName,
          environmentId: environment.environmentId,
        })
      ).applicationId;
    const stack = await ctx.app.get(ComposeService).create(ownerCtx, {
      name: 'Stack',
      appName: 'stack',
      environmentId: environment.environmentId,
    });
    return {
      cookie,
      ownerCtx,
      web: await make('web'),
      api: await make('api'),
      composeId: stack.composeId,
    };
  }

  /**
   * A build's row as a cut-off process left it, `at` seconds into the day,
   * marked as its trigger marks it unless `queuedAs` says otherwise.
   */
  async function row(
    parent:
      | { applicationId: string; previewDeploymentId?: string | null }
      | { composeId: string },
    status: 'pending' | 'running' | 'held',
    at: number,
    {
      title = 'Manual deployment',
      queuedAs = {
        applicationType:
          'composeId' in parent
            ? 'compose'
            : parent.previewDeploymentId
              ? 'application-preview'
              : 'application',
        type: 'deploy',
      },
    }: {
      title?: string;
      queuedAs?: QueuedAs | null;
    } = {},
  ) {
    const [inserted] = await ctx.db
      .insert(deploymentTable)
      .values({
        ...parent,
        queuedAs,
        title,
        status,
        logPath: `/tmp/build-start-up-${at}.log`,
        createdAt: new Date(Date.UTC(2026, 9, 22, 0, 0, at)).toISOString(),
      })
      .returning();
    return inserted.deploymentId;
  }

  it('queues the builds still pending again, oldest first, and they run', async () => {
    const { web, api, composeId } = await setUp();
    const second = await row({ applicationId: api }, 'pending', 2);
    const first = await row({ applicationId: web }, 'pending', 1);
    const third = await row({ composeId }, 'pending', 3);

    await deployments.settleBuildsAtStartUp();

    await until(() => built.length === 3);
    expect(built).toEqual([first, second, third]);
    // The engine claims the row its job names, and no other.
    expect(engineMock.deploy.mock.calls[0][0]).toMatchObject({
      applicationId: web,
    });
    expect(engineMock.deployCompose.mock.calls[0][0]).toMatchObject({
      composeId,
    });
  });

  it('queues the rest when one row cannot be queued again, and settles that one', async () => {
    const { web, api } = await setUp();
    const refused = await row({ applicationId: web }, 'pending', 1);
    const next = await row({ applicationId: api }, 'pending', 2);
    const queue = ctx.app.get<QueuePort>(DEPLOYMENT_QUEUE);
    const add = jest
      .spyOn(queue, 'add')
      .mockRejectedValueOnce(new Error('the queue refused it'));

    await deployments.settleBuildsAtStartUp();
    add.mockRestore();

    await until(() => built.length === 1);
    expect(built).toEqual([next]);
    const settled = await statusOf(refused);
    expect(settled.status).toBe('error');
    expect(settled.description).toBe(NOT_STARTED_BEFORE_RESTART);
    expect(settled.finishedAt).not.toBeNull();
  });

  it('queues a pending redeploy again as a redeploy whatever its title', async () => {
    const { ownerCtx, web, api } = await setUp();
    await ctx.db
      .update(applicationTable)
      .set({ sourceType: 'docker', dockerImage: 'nginx:1.27' })
      .where(eq(applicationTable.applicationId, api));
    let release!: () => void;
    hold = new Promise<void>((resolve) => (release = resolve));
    const blocking = await row({ applicationId: web }, 'pending', 1);
    await deployments.settleBuildsAtStartUp();
    await until(() => built.length === 1);

    const redeploy = await deployments.redeploy(ownerCtx, api, {
      title: 'Retry after the fix',
    });
    // The restart: the in-memory queue loses the waiting job, the row stays.
    const queue = ctx.app.get<QueuePort>(DEPLOYMENT_QUEUE);
    await queue.clearWaiting();
    await ctx.db
      .update(deploymentTable)
      .set({ status: 'done' })
      .where(eq(deploymentTable.deploymentId, blocking));

    await deployments.settleBuildsAtStartUp();

    const waiting = await queue.getJobs(['waiting']);
    release();
    await until(() => built.length === 2);
    expect(waiting.map((job) => job.data)).toEqual([
      expect.objectContaining({
        deploymentId: redeploy.deploymentId,
        title: 'Retry after the fix',
        type: 'redeploy',
      }),
    ]);
  });

  it('settles a build still running as cut off by the restart, and never runs it again', async () => {
    const { web } = await setUp();
    const cutOff = await row({ applicationId: web }, 'running', 1);

    await deployments.settleBuildsAtStartUp();

    const settled = await statusOf(cutOff);
    expect(settled.status).toBe('error');
    expect(settled.description).toBe(BUILD_CUT_OFF_BY_RESTART);
    expect(settled.finishedAt).not.toBeNull();
    // The same sentence is the log's last line, written where the build logs.
    await until(() =>
      execMock.execAsync.mock.calls.some(
        ([command]) =>
          typeof command === 'string' &&
          command.includes('Cut off by a Cloudgate restart') &&
          command.includes('/tmp/build-start-up-1.log'),
      ),
    );

    // A second start-up finds nothing left of it to settle or to run.
    await deployments.settleBuildsAtStartUp();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(built).toEqual([]);
    expect((await statusOf(cutOff)).status).toBe('error');
  });

  it('leaves a held build for its plan, and a Cloud run for the Cloud run pool', async () => {
    const { web, api } = await setUp();
    const held = await row({ applicationId: web }, 'held', 1);
    const cloud = await row({ applicationId: api }, 'running', 2);
    await ctx.db
      .update(deploymentTable)
      .set({
        cloudRun: {
          kind: 'deploy',
          stateKey: `application:${api}`,
          environmentId: 'unused by a build',
          touchesNetwork: false,
        },
      })
      .where(eq(deploymentTable.deploymentId, cloud));

    await deployments.settleBuildsAtStartUp();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect((await statusOf(held)).status).toBe('held');
    expect((await statusOf(cloud)).status).toBe('running');
    expect(built).toEqual([]);
  });

  it('cancels a build queued again at start-up while it waits', async () => {
    const { cookie, web, api } = await setUp();
    let release!: () => void;
    hold = new Promise<void>((resolve) => (release = resolve));
    const blocking = await row({ applicationId: web }, 'pending', 1);
    const waiting = await row({ applicationId: api }, 'pending', 2);

    await deployments.settleBuildsAtStartUp();
    // One build at a time without a license: the second waits behind it.
    await until(() => built.length === 1);
    expect(built).toEqual([blocking]);

    const res = await request(server)
      .post(`/deployments/${waiting}/cancel`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      deploymentId: waiting,
      status: 'cancelled',
    });

    release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(built).toEqual([blocking]);
  });

  /** A Preview deployment of `applicationId`, as a pull request opens one. */
  async function addPreview(applicationId: string, appName: string) {
    const [preview] = await ctx.db
      .insert(previewDeployment)
      .values({
        applicationId,
        appName,
        branch: 'feature/thing',
        pullRequestId: `pr-${appName}`,
        pullRequestNumber: '7',
        pullRequestTitle: 'A thing',
        pullRequestURL: 'https://git.example.com/acme/web/pull/7',
        domain: `${appName}.sslip.io`,
      })
      .returning();
    return preview.previewDeploymentId;
  }

  it('queues a pending preview build again as that preview, never as its parent', async () => {
    const { web } = await setUp();
    const deployPreview = jest
      .spyOn(ctx.app.get(PreviewDeploymentsService), 'deployPreview')
      .mockResolvedValue(undefined);
    const preview = await addPreview(web, 'web-preview-7');
    const pending = await row(
      { applicationId: web, previewDeploymentId: preview },
      'pending',
      1,
      { title: 'Preview Deployment' },
    );

    await deployments.settleBuildsAtStartUp();

    await until(() => deployPreview.mock.calls.length === 1);
    expect(deployPreview).toHaveBeenCalledWith(
      preview,
      expect.objectContaining({ deploymentId: pending }),
    );
    expect(built).toEqual([]);
    deployPreview.mockRestore();
  });

  it('settles a pending build of a deleted preview as not built, and never deploys its parent', async () => {
    const { web } = await setUp();
    const preview = await addPreview(web, 'web-preview-8');
    const orphaned = await row(
      { applicationId: web, previewDeploymentId: preview },
      'pending',
      1,
      { title: 'Preview Deployment' },
    );
    // The preview goes while its build waits; its link is `set null`,
    // which leaves the row looking like a production build of `web`.
    await ctx.db
      .delete(previewDeployment)
      .where(eq(previewDeployment.previewDeploymentId, preview));
    expect((await statusOf(orphaned)).previewDeploymentId).toBeNull();

    await deployments.settleBuildsAtStartUp();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(built).toEqual([]);
    const settled = await statusOf(orphaned);
    expect(settled.status).toBe('error');
    expect(settled.description).toBe(PREVIEW_BUILD_NOT_REQUEUED);
    expect(settled.finishedAt).not.toBeNull();
  });

  it('settles a pending row that says nothing of what it was queued as, rather than building a guess', async () => {
    const { web } = await setUp();
    // A build recorded before the column, or a cloud row recorded `pending`
    // under its Service a moment before its `cloud_run` was set.
    const unmarked = await row({ applicationId: web }, 'pending', 1, {
      title: 'Delete',
      queuedAs: null,
    });

    await deployments.settleBuildsAtStartUp();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(built).toEqual([]);
    const settled = await statusOf(unmarked);
    expect(settled.status).toBe('error');
    // True of a build from before the column and of a cloud Delete alike.
    expect(settled.description).toBe(NOT_STARTED_BEFORE_RESTART);
    expect(settled.description).not.toMatch(/preview|Deploy again/);
  });

  it('marks every build its trigger records with the job it queued', async () => {
    const { ownerCtx, web, composeId } = await setUp();
    const deployPreview = jest
      .spyOn(ctx.app.get(PreviewDeploymentsService), 'deployPreview')
      .mockResolvedValue(undefined);
    await ctx.db
      .update(applicationTable)
      .set({ sourceType: 'docker', dockerImage: 'nginx:1.27' })
      .where(eq(applicationTable.applicationId, web));
    await ctx.db
      .update(composeTable)
      .set({ sourceType: 'raw' })
      .where(eq(composeTable.composeId, composeId));
    const preview = await addPreview(web, 'web-preview-9');

    const production = await deployments.deploy(ownerCtx, web);
    const stack = await deployments.deployCompose(ownerCtx, composeId);
    const previewBuild = await deployments.queuePreviewBuild(
      { previewDeploymentId: preview, applicationId: web },
      'deploy',
      { title: 'Preview Deployment', description: '' },
    );

    expect((await statusOf(production.deploymentId)).queuedAs).toEqual({
      applicationType: 'application',
      type: 'deploy',
    });
    expect((await statusOf(stack.deploymentId)).queuedAs).toEqual({
      applicationType: 'compose',
      type: 'deploy',
    });
    expect((await statusOf(previewBuild.deploymentId)).queuedAs).toEqual({
      applicationType: 'application-preview',
      type: 'deploy',
    });
    // Nothing this test queued may outlive it.
    const queue = ctx.app.get<QueuePort>(DEPLOYMENT_QUEUE);
    await until(async () => (await queue.getJobs()).length === 0);
    expect(built).toHaveLength(2);
    expect(deployPreview).toHaveBeenCalledTimes(1);
    deployPreview.mockRestore();
  });
});
