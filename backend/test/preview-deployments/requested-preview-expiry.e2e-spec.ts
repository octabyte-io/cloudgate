import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { SchedulingService } from '../../src/scheduling/scheduling.service';
import { and, asc, eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { application as applicationTable } from '../../src/applications/application.schema';
import { ApplicationsService } from '../../src/applications/applications.service';
import type { DeploymentJob } from '../../src/deployment-queue/job-types';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import type { QueuedJob } from '../../src/deployment-queue/queue.port';
import { deployment } from '../../src/deployments/deployment.schema';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { auditLog } from '../../src/enterprise/audit-logs/audit-log.schema';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { FETCH_CLIENT } from '../../src/git-providers/fetch.provider';
import { OCTOKIT_FACTORY } from '../../src/git-providers/strategies/github/octokit.provider';
import { GithubService } from '../../src/git-providers/strategies/github/github.service';
import { NotificationDispatcherService } from '../../src/notifications/dispatcher.service';
import { member } from '../../src/organizations/organizations.schema';
import { previewDeployment } from '../../src/preview-deployments/preview-deployment.schema';
import { PreviewDeploymentsService } from '../../src/preview-deployments/preview-deployments.service';
import {
  PREVIEW_EXPIRY_CRON,
  PreviewExpiryService,
} from '../../src/preview-deployments/preview-expiry.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { server as serverTable } from '../../src/servers/server.schema';
import { dynamicTraefikConfigPath } from '../../src/traefik/traefik-writer.service';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const appCredentials = {
  name: 'Team GitHub',
  appName: 'cloudgate-app',
  appId: 12345,
  clientId: 'Iv1.abc123',
  clientSecret: 'github-client-secret',
  installationId: '99887766',
  privateKey:
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEfake\n-----END RSA PRIVATE KEY-----',
  webhookSecret: 'wh-secret',
};

/** Written out rather than imported: what an expired preview's caller reads. */
const EXPIRED_REFUSAL =
  'This preview has expired and is being torn down; ask for a new one';

const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

const MINUTE = 60_000;

/**
 * A Requested preview goes at its expiry, and by the same path when someone
 * deletes it (, ADR-0026).
 *
 * The pass is driven directly, with its own now, through
 * `PreviewExpiryService.sweep` — ADR-0026's direct-call seam — so nothing here
 * waits on the minute cron. The exec layer, the Docker daemon, the build queue
 * and GitHub are the only doubles, all boundaries (§1.7). A preview's machine
 * steps all go to the platform host here, so "which machine" is
 * `preview-deployments.e2e-spec.ts`' question; this file's is *when*, and what
 * is left behind in the trail.
 */
describe('Requested preview expiry (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let githubService: GithubService;
  let previews: PreviewDeploymentsService;
  let expiry: PreviewExpiryService;
  let scheduling: SchedulingService;
  let dispatcher: NotificationDispatcherService;

  /** Every channel's HTTP API: a boundary, answered as a webhook that took it. */
  const fetchMock = jest.fn();

  /** App names whose every command fails as an unreachable Server's would. */
  const unreachable = new Set<string>();

  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
    execFileAsync: jest.fn(),
    execRemote: jest.fn(),
  };
  const dockerService = { inspect: jest.fn(), update: jest.fn() };
  const docker = {
    getService: jest.fn(() => dockerService),
    createService: jest.fn(),
    listTasks: jest.fn(),
  };
  const convergedTasks = [1, 2, 3].map((n) => ({
    Status: { State: 'running', Timestamp: `2026-08-24T00:00:0${n}Z` },
  }));
  const dockerFactoryMock = {
    getRemoteDocker: jest.fn().mockResolvedValue(docker),
  };
  const queueMock = { add: jest.fn(), getJobs: jest.fn(), cancel: jest.fn() };
  const octokitMock = {
    rest: {
      issues: { createComment: jest.fn() },
      repos: { getCollaboratorPermissionLevel: jest.fn() },
    },
    auth: jest.fn(),
  };

  const configuredRoot = fs.realpathSync(
    fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-expiry-root-')),
  );
  const originalRoot = process.env.CLOUDGATE_DIRECTORY;

  beforeAll(async () => {
    process.env.CLOUDGATE_DIRECTORY = configuredRoot;
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: RemoteDockerFactory, useValue: dockerFactoryMock },
        { provide: DEPLOYMENT_QUEUE, useValue: queueMock },
        { provide: OCTOKIT_FACTORY, useValue: () => octokitMock },
        { provide: FETCH_CLIENT, useValue: fetchMock },
      ],
    });
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    applications = ctx.app.get(ApplicationsService);
    githubService = ctx.app.get(GithubService);
    previews = ctx.app.get(PreviewDeploymentsService);
    expiry = ctx.app.get(PreviewExpiryService);
    scheduling = ctx.app.get(SchedulingService);
    dispatcher = ctx.app.get(NotificationDispatcherService);
  });

  afterAll(async () => {
    await ctx.teardown();
    if (originalRoot === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = originalRoot;
    fs.rmSync(configuredRoot, { recursive: true, force: true });
  });

  /**
   * The exec double: the presence probe answers `absent` (the service is
   * gone), everything else succeeds, and anything naming an app in
   * {@link unreachable} rejects as an SSH connect timeout does.
   */
  const answer = (words: string) => {
    for (const name of unreachable) {
      if (words.includes(name)) {
        return Promise.reject(new Error('connect ETIMEDOUT'));
      }
    }
    return Promise.resolve({
      stdout: words.includes('docker service inspect') ? 'absent\n' : '',
      stderr: '',
    });
  };

  beforeEach(async () => {
    await ctx.resetDb();
    unreachable.clear();
    fetchMock.mockReset().mockResolvedValue({ ok: true, statusText: 'OK' });
    execMock.execAsync
      .mockReset()
      .mockImplementation((cmd: string) => answer(cmd));
    execMock.execFileAsync
      .mockReset()
      .mockImplementation((program: string, args: string[]) =>
        answer([program, ...args].join(' ')),
      );
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_: string, cmd: string) => answer(cmd));
    execMock.execRemote
      .mockReset()
      .mockImplementation((_: string, argv: string[]) =>
        answer(argv.join(' ')),
      );
    dockerService.inspect
      .mockReset()
      .mockRejectedValue(new Error('no such service'));
    dockerService.update.mockReset().mockResolvedValue(undefined);
    docker.createService.mockReset().mockResolvedValue(undefined);
    docker.listTasks.mockReset().mockResolvedValue(convergedTasks);
    queueMock.add.mockReset().mockResolvedValue({ id: 'job-1' });
    queueMock.getJobs.mockReset().mockResolvedValue([]);
    queueMock.cancel.mockReset().mockResolvedValue(false);
    octokitMock.rest.issues.createComment
      .mockReset()
      .mockResolvedValue({ data: { id: 777 } });
    octokitMock.rest.repos.getCollaboratorPermissionLevel
      .mockReset()
      .mockResolvedValue({ data: { permission: 'admin' } });
    octokitMock.auth.mockReset().mockResolvedValue({ token: 'ghs_stub' });
  });

  /** An owner and a GitHub-sourced Application that allows requested previews. */
  async function setUp() {
    const signUp = await request(server)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(signUp.status).toBe(200);
    const ownerCookie = signUp.headers['set-cookie'];
    const ownerId = (signUp.body as { user: { id: string } }).user.id;
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', ownerCookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = permissionCtx(ownerId, organizationId);

    const connection = await githubService.create(ownerCtx, appCredentials);
    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
    });
    const created = await applications.create(ownerCtx, {
      name: 'Web App',
      appName: 'web-app',
      environmentId: environment.environmentId,
    });
    const application = await applications.update(
      ownerCtx,
      created.applicationId,
      {
        sourceType: 'github',
        repository: 'cloudgate',
        owner: 'octabyte-io',
        branch: 'main',
        githubId: connection.githubId,
        previewWildcard: '*.preview.example.com',
        requestedPreviewsAllowed: true,
      },
    );
    return {
      ownerCookie,
      ownerId,
      organizationId,
      ownerCtx,
      connection,
      project,
      environment,
      application,
    };
  }

  type SetUp = Awaited<ReturnType<typeof setUp>>;

  /** An `agentOperator` Agent granted the Application. */
  async function agent(t: SetUp) {
    const res = await request(server)
      .post('/agents')
      .set('Cookie', t.ownerCookie)
      .send({
        name: 'preview-bot',
        role: 'agentOperator',
        grant: {
          accessedProjects: [t.project.projectId],
          accessedEnvironments: [t.environment.environmentId],
          accessedServices: [t.application.applicationId],
        },
      });
    expect(res.status).toBe(201);
    const id = (res.body as { agent: { id: string } }).agent.id;
    return { id, ctx: permissionCtx(id, t.organizationId) };
  }

  /**
   * The queue as a model rather than a stub, `preview-deployments.e2e-spec.ts`'
   * shape: a queued job waits and can be cancelled, a started one is active
   * and cannot, and a finished one is gone.
   */
  function modelQueue() {
    const jobs: QueuedJob[] = [];
    queueMock.add.mockImplementation((data: DeploymentJob) => {
      const job: QueuedJob = {
        id: `job-${queueMock.add.mock.calls.length}`,
        state: 'waiting',
        data,
      };
      jobs.push(job);
      return Promise.resolve({ ...job });
    });
    queueMock.getJobs.mockImplementation((states?: QueuedJob['state'][]) =>
      Promise.resolve(
        jobs
          .filter((job) => !states || states.includes(job.state))
          .map((job) => ({ ...job })),
      ),
    );
    queueMock.cancel.mockImplementation((id: string) => {
      const index = jobs.findIndex(
        (job) => job.id === id && job.state === 'waiting',
      );
      if (index === -1) return Promise.resolve(false);
      jobs.splice(index, 1);
      return Promise.resolve(true);
    });
    return {
      jobs,
      start(job: QueuedJob) {
        job.state = 'active';
      },
      finish(job: QueuedJob) {
        jobs.splice(jobs.indexOf(job), 1);
      },
    };
  }

  const later = (minutes: number) => new Date(Date.now() + minutes * MINUTE);

  /** Drops what creating a preview sent (its build log's `mkdir`). */
  const forgetExecCalls = () => {
    for (const fn of Object.values(execMock)) fn.mockClear();
  };

  const previewRow = async (previewDeploymentId: string) => {
    const [row] = await ctx.db
      .select()
      .from(previewDeployment)
      .where(eq(previewDeployment.previewDeploymentId, previewDeploymentId));
    return row;
  };

  const deploymentRow = async (deploymentId: string) => {
    const [row] = await ctx.db
      .select()
      .from(deployment)
      .where(eq(deployment.deploymentId, deploymentId));
    return row;
  };

  /** Every preview audit row about one preview, oldest first, metadata parsed. */
  const trailOf = async (previewDeploymentId: string) =>
    (
      await ctx.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.resourceType, 'previewDeployment'),
            eq(auditLog.resourceId, previewDeploymentId),
          ),
        )
        .orderBy(asc(auditLog.createdAt))
    ).map((row) => ({
      ...row,
      metadata: JSON.parse(row.metadata ?? '{}') as Record<string, unknown>,
    }));

  /** Every argv or shell program the exec double was sent, as one line each. */
  const sentCommands = () => [
    ...execMock.execFileAsync.mock.calls.map(
      ([program, args]: [string, string[]]) => [program, ...args].join(' '),
    ),
    ...execMock.execAsync.mock.calls.map(([cmd]: [string]) => cmd),
  ];

  const serviceRemovals = (appName: string) =>
    sentCommands().filter((line) => line === `docker service rm ${appName}`);

  describe('the sweep', () => {
    it('is armed at boot, every minute', () => {
      expect(scheduling.has('requested-preview-expiry')).toBe(true);
      expect(PREVIEW_EXPIRY_CRON).toBe('* * * * *');
    });

    it('a pass at an injected now expires exactly the previews past their expiry', async () => {
      const t = await setUp();
      const short = await previews.createRequested(
        t.ownerCtx,
        t.application.applicationId,
        { branch: 'feature/short', ttlMinutes: 10 },
      );
      const long = await previews.createRequested(
        t.ownerCtx,
        t.application.applicationId,
        { branch: 'feature/long', ttlMinutes: 60 },
      );

      forgetExecCalls();
      // Before either expiry, nothing happens at all.
      await expiry.sweep(later(5));
      expect(await previewRow(short.previewDeploymentId)).toMatchObject({
        expiredAt: null,
      });
      expect(sentCommands()).toEqual([]);

      await expiry.sweep(later(30));

      expect(await previewRow(short.previewDeploymentId)).toBeUndefined();
      expect(await previewRow(long.previewDeploymentId)).toMatchObject({
        expiredAt: null,
        expiryCause: null,
      });
      expect(serviceRemovals(short.appName)).toHaveLength(1);
      expect(serviceRemovals(long.appName)).toEqual([]);
    });

    it('after teardown the Swarm service, the router, the source tree and the image are gone, and the preview answers not-found', async () => {
      const t = await setUp();
      const created = await previews.createRequested(
        t.ownerCtx,
        t.application.applicationId,
        { branch: 'feature/x', ttlMinutes: 10 },
      );
      await previews.deployPreview(created.previewDeploymentId, {
        deploymentId: created.deploymentId,
      });
      const router = dynamicTraefikConfigPath(created.appName, null);
      expect(fs.existsSync(router)).toBe(true);

      await expiry.sweep(later(11));

      expect(fs.existsSync(router)).toBe(false);
      const sent = sentCommands();
      expect(sent).toContain(`docker service rm ${created.appName}`);
      expect(sent).toContain(
        `rm -rf ${nodePath.posix.join(configuredRoot, 'applications', created.appName)}`,
      );
      expect(
        sent.some(
          (line) =>
            line.startsWith('docker image rm') &&
            line.includes(`${created.appName}:latest`),
        ),
      ).toBe(true);
      const res = await request(server)
        .get(`/preview-deployments/${created.previewDeploymentId}`)
        .set('Cookie', t.ownerCookie);
      expect(res.status).toBe(404);
    });

    it('skips a tick while the previous one is still running', async () => {
      const t = await setUp();
      const created = await previews.createRequested(
        t.ownerCtx,
        t.application.applicationId,
        { branch: 'feature/x', ttlMinutes: 1 },
      );
      // Already marked, as a delete leaves it: two overlapping passes would
      // each tear it down, since neither has a mark to lose to the other.
      await request(server)
        .delete(`/preview-deployments/${created.previewDeploymentId}`)
        .set('Cookie', t.ownerCookie)
        .expect(200);

      await Promise.all([expiry.tick(), expiry.tick()]);

      expect(serviceRemovals(created.appName)).toHaveLength(1);
    });
  });

  describe('builds at expiry', () => {
    it('cancels a pending build with a description saying the preview expired, then tears down', async () => {
      const t = await setUp();
      const queue = modelQueue();
      const created = await previews.createRequested(
        t.ownerCtx,
        t.application.applicationId,
        { branch: 'feature/x', ttlMinutes: 10 },
      );
      expect(queue.jobs).toHaveLength(1);

      await expiry.sweep(later(11));

      expect(queue.jobs).toEqual([]);
      expect(await deploymentRow(created.deploymentId)).toMatchObject({
        status: 'cancelled',
        description:
          'Requested preview of feature/x, cancelled: the preview expired',
        previewDeploymentId: null,
      });
      expect(await previewRow(created.previewDeploymentId)).toBeUndefined();
      const [, removed] = await trailOf(created.previewDeploymentId);
      expect(removed.metadata.cancelledDeploymentIds).toEqual([
        created.deploymentId,
      ]);
    });

    it('leaves a build past its cancel window to finish, and tears down on the first pass after it ends', async () => {
      const t = await setUp();
      const queue = modelQueue();
      const created = await previews.createRequested(
        t.ownerCtx,
        t.application.applicationId,
        { branch: 'feature/x', ttlMinutes: 10 },
      );
      // A worker took it and it is releasing: its row is running, no cancel
      // window is open, and its job is active.
      queue.start(queue.jobs[0]);
      await ctx.db
        .update(deployment)
        .set({ status: 'running' })
        .where(eq(deployment.deploymentId, created.deploymentId));

      await expiry.sweep(later(11));
      await expiry.sweep(later(12));

      expect(serviceRemovals(created.appName)).toEqual([]);
      expect(await previewRow(created.previewDeploymentId)).toMatchObject({
        expiryCause: 'expiry',
      });
      expect(await deploymentRow(created.deploymentId)).toMatchObject({
        status: 'running',
      });

      await ctx.db
        .update(deployment)
        .set({ status: 'done' })
        .where(eq(deployment.deploymentId, created.deploymentId));
      queue.finish(queue.jobs[0]);
      await expiry.sweep(later(13));

      expect(serviceRemovals(created.appName)).toHaveLength(1);
      expect(await previewRow(created.previewDeploymentId)).toBeUndefined();
      expect(await deploymentRow(created.deploymentId)).toMatchObject({
        status: 'done',
      });
    });
  });

  describe('an unreachable Server', () => {
    it('keeps the preview expired, teardown pending, across passes while others expire, and drops it once it answers absent', async () => {
      const t = await setUp();
      const stuck = await previews.createRequested(
        t.ownerCtx,
        t.application.applicationId,
        { branch: 'feature/stuck', ttlMinutes: 10 },
      );
      const fine = await previews.createRequested(
        t.ownerCtx,
        t.application.applicationId,
        { branch: 'feature/fine', ttlMinutes: 10 },
      );
      unreachable.add(stuck.appName);

      await expiry.sweep(later(11));
      await expiry.sweep(later(12));

      const pending = await previewRow(stuck.previewDeploymentId);
      expect(pending).toMatchObject({ expiryCause: 'expiry' });
      expect(pending.expiredAt).not.toBeNull();
      expect(await previewRow(fine.previewDeploymentId)).toBeUndefined();
      // The expired row still reads as itself, with its status.
      const read = await request(server)
        .get(`/preview-deployments/${stuck.previewDeploymentId}`)
        .set('Cookie', t.ownerCookie);
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({
        previewDeploymentId: stuck.previewDeploymentId,
        expiredAt: pending.expiredAt,
        previewStatus: 'idle',
      });
      // Nothing written for the mark, nor for either failed teardown.
      expect(
        (await trailOf(stuck.previewDeploymentId)).map((row) => row.action),
      ).toEqual(['create']);

      unreachable.clear();
      await expiry.sweep(later(13));

      expect(await previewRow(stuck.previewDeploymentId)).toBeUndefined();
      const [, removed] = await trailOf(stuck.previewDeploymentId);
      // The instant it was first marked, not the pass that saw it gone.
      expect(removed.metadata.expiredAt).toBe(pending.expiredAt);
    });
  });

  /**
   * The one Notification the sweep raises: a Server
   * whose pending teardowns have been retried for fifteen minutes, told once
   * per episode to the Server's own Organization. The episode clock is unit
   * pinned in `teardown-stuck-episodes.spec.ts`; this is the wiring, through
   * the real dispatcher to a Slack webhook, with the pass's injected now.
   */
  describe('the stuck-teardown Notification', () => {
    /** Another GitHub-sourced Application in the same Environment. */
    async function anotherApplication(t: SetUp, name: string, appName: string) {
      const created = await applications.create(t.ownerCtx, {
        name,
        appName,
        environmentId: t.environment.environmentId,
      });
      return applications.update(t.ownerCtx, created.applicationId, {
        sourceType: 'github',
        repository: 'cloudgate',
        owner: 'octabyte-io',
        branch: 'main',
        githubId: t.connection.githubId,
        previewWildcard: '*.preview.example.com',
        requestedPreviewsAllowed: true,
      });
    }

    async function slackChannel(
      t: SetUp,
      hook: string,
      flags: Record<string, boolean>,
    ) {
      const res = await request(server)
        .post('/notifications/slack')
        .set('Cookie', t.ownerCookie)
        .send({
          name: hook,
          webhookUrl: `https://hooks.slack.com/services/T/B/${hook}`,
          channel: '#ops',
          ...flags,
        });
      expect(res.status).toBe(201);
      return res.body as { previewTeardownStuck: boolean };
    }

    /**
     * The bodies posted to one webhook. The sweep does not wait on the
     * notifier, so give the fan-out its turn first.
     */
    async function postedTo(hook: string, settle = 500): Promise<string[]> {
      await new Promise((resolve) => setTimeout(resolve, settle));
      return fetchMock.mock.calls
        .filter(([url]) => String(url).endsWith(`/${hook}`))
        .map(([, init]) => String((init as { body: string }).body));
    }

    it('is off on a channel created without it', async () => {
      const t = await setUp();

      const created = await slackChannel(t, 'DEFAULT', { appDeploy: true });

      expect(created.previewTeardownStuck).toBe(false);
    });

    it("tells each Server's Organization once, at fifteen minutes, naming every Application holding a slot there", async () => {
      const t = await setUp();
      await slackChannel(t, 'OPTED', { previewTeardownStuck: true });
      await slackChannel(t, 'DEFAULT', { appDeploy: true, licenseLapse: true });
      const api = await anotherApplication(t, 'Billing API', 'billing-api');
      const shop = await anotherApplication(t, 'Shop', 'shop');

      const ask = (applicationId: string, branch: string) =>
        previews.createRequested(t.ownerCtx, applicationId, {
          branch,
          ttlMinutes: 10,
        });
      const onEdge = [
        await ask(t.application.applicationId, 'feature/a'),
        await ask(t.application.applicationId, 'feature/b'),
        await ask(api.applicationId, 'feature/c'),
      ];
      const onHost = await ask(shop.applicationId, 'feature/d');

      // Web App and Billing API run on a Server of the Organization's own;
      // Shop stays on the platform host.
      const [edge] = await ctx.db
        .insert(serverTable)
        .values({
          name: 'edge-1',
          ipAddress: '203.0.113.7',
          port: 22,
          organizationId: t.organizationId,
        })
        .returning();
      await ctx.db
        .update(applicationTable)
        .set({ serverId: edge.serverId })
        .where(
          inArray(applicationTable.applicationId, [
            t.application.applicationId,
            api.applicationId,
          ]),
        );
      for (const preview of [...onEdge, onHost])
        unreachable.add(preview.appName);

      // Stuck from the first pass; fourteen minutes of retries tell nobody.
      await expiry.sweep(later(11));
      await expiry.sweep(later(18));
      await expiry.sweep(later(25));
      expect(await postedTo('OPTED')).toEqual([]);

      await expiry.sweep(later(26.1));
      const told = await postedTo('OPTED');

      expect(told).toHaveLength(2);
      const onEdgeBody = told.find((body) => body.includes('edge-1'))!;
      const onHostBody = told.find((body) =>
        body.includes('the platform host'),
      )!;
      expect(onEdgeBody).toContain('3 requested previews');
      expect(onEdgeBody).toContain('Web App (2)');
      expect(onEdgeBody).toContain('Billing API');
      expect(onEdgeBody).not.toContain('Shop');
      expect(onEdgeBody).toContain(
        'slots stay taken until the copies are gone',
      );
      expect(onHostBody).toContain('1 requested preview');
      expect(onHostBody).toContain('Shop');
      expect(onHostBody).not.toContain('Billing API');

      // Silent within the episode, however long it lasts.
      await expiry.sweep(later(40));
      await expiry.sweep(later(90));
      expect(await postedTo('OPTED')).toHaveLength(2);
      expect(await postedTo('DEFAULT', 0)).toEqual([]);

      // The rows are still expired, teardown pending: the Notification
      // changed nothing about them.
      for (const preview of [...onEdge, onHost]) {
        expect(await previewRow(preview.previewDeploymentId)).toMatchObject({
          expiryCause: 'expiry',
        });
      }
    });

    it('dispatches nothing for an expiry or a cap refusal', async () => {
      const t = await setUp();
      const dispatch = jest.spyOn(dispatcher, 'dispatch');
      try {
        for (const branch of ['feature/a', 'feature/b', 'feature/c']) {
          await previews.createRequested(
            t.ownerCtx,
            t.application.applicationId,
            { branch, ttlMinutes: 10 },
          );
        }
        // The default cap is 3.
        await expect(
          previews.createRequested(t.ownerCtx, t.application.applicationId, {
            branch: 'feature/d',
            ttlMinutes: 10,
          }),
        ).rejects.toMatchObject({ status: 409 });

        await expiry.sweep(later(11));

        expect(await ctx.db.select().from(previewDeployment)).toEqual([]);
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        dispatch.mockRestore();
      }
    });
  });

  describe('delete is expiring it now', () => {
    it('answers at once with no Server round trip, is harmless twice, refuses extend and redeploy, and leaves two rows once the sweep sees it gone', async () => {
      const t = await setUp();
      const created = await previews.createRequested(
        t.ownerCtx,
        t.application.applicationId,
        { branch: 'feature/x', ttlMinutes: 60 },
      );
      forgetExecCalls();

      const first = await request(server)
        .delete(`/preview-deployments/${created.previewDeploymentId}`)
        .set('Cookie', t.ownerCookie);
      expect(first.status).toBe(200);
      const expiredAt = (first.body as { expiredAt: string }).expiredAt;
      expect(first.body).toMatchObject({
        previewDeploymentId: created.previewDeploymentId,
        expiryCause: 'delete',
        expiresAt: expiredAt,
      });
      expect(sentCommands()).toEqual([]);
      expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
      expect(execMock.execRemote).not.toHaveBeenCalled();

      const second = await request(server)
        .delete(`/preview-deployments/${created.previewDeploymentId}`)
        .set('Cookie', t.ownerCookie);
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ expiredAt, expiryCause: 'delete' });

      const extend = await request(server)
        .post(`/preview-deployments/${created.previewDeploymentId}/extend`)
        .set('Cookie', t.ownerCookie)
        .send({ ttlMinutes: 30 });
      expect(extend.status).toBe(409);
      expect((extend.body as { message: string }).message).toBe(
        EXPIRED_REFUSAL,
      );
      const redeploy = await request(server)
        .post(`/preview-deployments/${created.previewDeploymentId}/redeploy`)
        .set('Cookie', t.ownerCookie)
        .send({});
      expect(redeploy.status).toBe(409);
      expect((redeploy.body as { message: string }).message).toBe(
        EXPIRED_REFUSAL,
      );
      expect(queueMock.add).toHaveBeenCalledTimes(1);

      // Now, not an hour on: the delete set the expiry to its own now.
      await expiry.sweep();

      const gone = await request(server)
        .get(`/preview-deployments/${created.previewDeploymentId}`)
        .set('Cookie', t.ownerCookie);
      expect(gone.status).toBe(404);
      const deletes = (await trailOf(created.previewDeploymentId)).filter(
        (row) => row.action === 'delete',
      );
      // The caller's row each time they asked, then the platform's once.
      const asked = expect.objectContaining({
        userId: t.ownerId,
        userRole: 'owner',
      }) as unknown;
      expect(deletes).toEqual([
        asked,
        asked,
        expect.objectContaining({
          userId: null,
          userRole: 'system',
          metadata: expect.objectContaining({ cause: 'delete' }) as unknown,
        }),
      ]);
    });

    it('keeps inline teardown for a pull-request preview', async () => {
      const t = await setUp();
      const [pr] = await ctx.db
        .insert(previewDeployment)
        .values({
          applicationId: t.application.applicationId,
          branch: 'feature/pr',
          pullRequestId: '1',
          pullRequestNumber: '1',
          pullRequestTitle: 'One',
          pullRequestURL: 'https://github.com/example-org/shop/pull/1',
          appName: 'preview-web-app-pr',
          domain: 'preview-web-app-pr.preview.example.com',
        })
        .returning();

      const res = await request(server)
        .delete(`/preview-deployments/${pr.previewDeploymentId}`)
        .set('Cookie', t.ownerCookie);

      expect(res.status).toBe(200);
      expect(serviceRemovals(pr.appName)).toHaveLength(1);
      expect(await previewRow(pr.previewDeploymentId)).toBeUndefined();
    });
  });

  describe('the platform actor', () => {
    it('writes one delete as the platform, naming the requester, even after the requesting Agent is deleted', async () => {
      const t = await setUp();
      const queue = modelQueue();
      const bot = await agent(t);
      const created = await previews.createRequested(
        bot.ctx,
        t.application.applicationId,
        { branch: 'feature/agent', ttlMinutes: 10 },
      );
      expect(queue.jobs).toHaveLength(1);
      const removedAgent = await request(server)
        .delete(`/agents/${bot.id}`)
        .set('Cookie', t.ownerCookie);
      expect(removedAgent.status).toBe(200);

      await expiry.sweep(later(11));

      const trail = await trailOf(created.previewDeploymentId);
      expect(trail.map((row) => row.action)).toEqual(['create', 'delete']);
      const [, removed] = trail;
      expect(removed).toMatchObject({
        organizationId: t.organizationId,
        userId: null,
        userEmail: null,
        userRole: 'system',
        userName: 'Cloudgate',
        action: 'delete',
        outcome: 'succeeded',
        resourceType: 'previewDeployment',
        resourceId: created.previewDeploymentId,
        resourceName: created.appName,
        ip: null,
      });
      const marked = removed.metadata.expiredAt as string;
      expect(removed.metadata).toEqual({
        cause: 'expiry',
        requesterId: bot.id,
        requesterName: 'preview-bot',
        applicationId: t.application.applicationId,
        branch: 'feature/agent',
        expiredAt: marked,
        cancelledDeploymentIds: [created.deploymentId],
      });
      expect(new Date(marked).getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('no Member holds the platform role', () => {
    it('refuses a member row on system, alone or in a role list, whoever writes it', async () => {
      const t = await setUp();
      const [row] = await ctx.db
        .select()
        .from(member)
        .where(eq(member.userId, t.ownerId));

      for (const role of ['system', 'member,system', 'member, system']) {
        await expect(
          ctx.db.update(member).set({ role }).where(eq(member.id, row.id)),
        ).rejects.toThrow();
      }
    });

    it('refuses an invitation to system', async () => {
      const t = await setUp();
      const res = await request(server)
        .post('/organizations/invitations')
        .set('Cookie', t.ownerCookie)
        .send({ email: 'ida@example.com', role: 'system' });
      expect(res.status).toBe(403);
      expect((res.body as { message: string }).message).toBe(
        "The system role is the platform's own and no Member can hold it",
      );
    });
  });
});
