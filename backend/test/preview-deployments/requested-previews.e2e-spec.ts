import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { application } from '../../src/applications/application.schema';
import { ApplicationsService } from '../../src/applications/applications.service';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { deployment } from '../../src/deployments/deployment.schema';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { auditLog } from '../../src/enterprise/audit-logs/audit-log.schema';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { OCTOKIT_FACTORY } from '../../src/git-providers/strategies/github/octokit.provider';
import { GithubService } from '../../src/git-providers/strategies/github/github.service';
import { NotificationDispatcherService } from '../../src/notifications/dispatcher.service';
import { member } from '../../src/organizations/organizations.schema';
import { previewDeployment } from '../../src/preview-deployments/preview-deployment.schema';
import { PreviewDeploymentsService } from '../../src/preview-deployments/preview-deployments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { server as serverTable } from '../../src/servers/server.schema';
import { webServerSettings } from '../../src/settings/settings.schema';
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

const prOpened = {
  action: 'opened' as const,
  pullRequestId: '990001',
  pullRequestNumber: '42',
  pullRequestTitle: 'Add health endpoint',
  pullRequestURL: 'https://github.com/example-org/shop/pull/42',
  headBranch: 'feature/health',
  baseBranch: 'main',
  repository: 'cloudgate',
  owner: 'octabyte-io',
  prAuthor: 'octocat',
};

/** Written out, as the ticket asks: the switch's refusal. */
const SWITCH_REFUSAL = 'Requested previews are not allowed on this Application';

const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

const MINUTE = 60_000;

describe('Requested previews (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let githubService: GithubService;
  let previews: PreviewDeploymentsService;
  let dispatcher: NotificationDispatcherService;

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

  /**
   * A writable platform root, as `preview-deployments.e2e-spec.ts` makes one:
   * a converged preview's host is routed by writing its Traefik file there.
   */
  const configuredRoot = fs.realpathSync(
    fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-requested-root-')),
  );
  const originalRoot = process.env.CLOUDGATE_DIRECTORY;

  beforeAll(async () => {
    // Before `createTestApp`: `validateEnv` reads it once at boot.
    process.env.CLOUDGATE_DIRECTORY = configuredRoot;
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: RemoteDockerFactory, useValue: dockerFactoryMock },
        { provide: DEPLOYMENT_QUEUE, useValue: queueMock },
        { provide: OCTOKIT_FACTORY, useValue: () => octokitMock },
      ],
    });
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    applications = ctx.app.get(ApplicationsService);
    githubService = ctx.app.get(GithubService);
    previews = ctx.app.get(PreviewDeploymentsService);
    dispatcher = ctx.app.get(NotificationDispatcherService);
  });

  afterAll(async () => {
    await ctx.teardown();
    if (originalRoot === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = originalRoot;
    fs.rmSync(configuredRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await ctx.resetDb();
    for (const fn of Object.values(execMock)) {
      fn.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
    }
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

  /**
   * An owner and a GitHub-sourced Application with pull-request previews on.
   * `allowed` is the requested-preview switch, which is off unless asked.
   */
  async function setUp({ allowed = true }: { allowed?: boolean } = {}) {
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
        isPreviewDeploymentsActive: true,
        previewWildcard: '*.preview.example.com',
        requestedPreviewsAllowed: allowed,
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

  /** A Member invited and accepted, granted `services` row by row. */
  async function invitedMember(t: SetUp, services: string[]) {
    const invite = await request(server)
      .post('/organizations/invitations')
      .set('Cookie', t.ownerCookie)
      .send({ email: 'ida@example.com', role: 'member' });
    const inviteId = (invite.body as { id: string }).id;
    const su = await request(server)
      .post('/api/auth/sign-up/email')
      .set('x-cloudgate-token', inviteId)
      .send({
        name: 'Ida Rhodes',
        email: 'ida@example.com',
        password: 'super-secret-password',
      });
    const cookie = su.headers['set-cookie'];
    const id = (su.body as { user: { id: string } }).user.id;
    const accept = await request(server)
      .post(`/organizations/invitations/${inviteId}/accept`)
      .set('Cookie', cookie);
    expect(accept.status).toBe(201);
    await ctx.db
      .update(member)
      .set({
        accessedProjects: [t.project.projectId],
        accessedEnvironments: [t.environment.environmentId],
        accessedServices: services,
      })
      .where(eq(member.userId, id));
    return { id, cookie, ctx: permissionCtx(id, t.organizationId) };
  }

  /** An Agent on `role`, granted the Application. */
  async function agent(t: SetUp, role: 'agentOperator' | 'agentReader') {
    const res = await request(server)
      .post('/agents')
      .set('Cookie', t.ownerCookie)
      .send({
        name: `${role}-bot`,
        role,
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

  const ask = (cookie: string, applicationId: string, body: object) =>
    request(server)
      .post(`/applications/${applicationId}/preview-deployments`)
      .set('Cookie', cookie)
      .send(body);

  const setAllowed = (t: SetUp, requestedPreviewsAllowed: boolean) =>
    applications.update(t.ownerCtx, t.application.applicationId, {
      requestedPreviewsAllowed,
    });

  /** An error body without the instant it was rendered at. */
  const refusal = (body: unknown) => {
    const rest: Record<string, unknown> = { ...(body as object) };
    delete rest.timestamp;
    return rest;
  };

  describe('the trigger check constraint', () => {
    it('refuses a requested row with pull-request fields and a pull-request row without them', async () => {
      const t = await setUp();
      const base = {
        applicationId: t.application.applicationId,
        branch: 'feature/x',
        domain: 'x.preview.example.com',
      };
      const pullRequest = {
        pullRequestId: '1',
        pullRequestNumber: '1',
        pullRequestTitle: 'One',
        pullRequestURL: 'https://github.com/example-org/shop/pull/1',
      };
      const expiresAt = new Date(Date.now() + 60 * MINUTE).toISOString();

      await expect(
        ctx.db.insert(previewDeployment).values({
          ...base,
          ...pullRequest,
          appName: 'requested-with-pr',
          trigger: 'requested',
          expiresAt,
        }),
      ).rejects.toThrow();
      await expect(
        ctx.db.insert(previewDeployment).values({
          ...base,
          appName: 'pr-without-pr',
          trigger: 'pullRequest',
        }),
      ).rejects.toThrow();
      // Nor is a requested preview without an expiry, or a pull request's with one.
      await expect(
        ctx.db.insert(previewDeployment).values({
          ...base,
          appName: 'requested-without-expiry',
          trigger: 'requested',
        }),
      ).rejects.toThrow();
      await expect(
        ctx.db.insert(previewDeployment).values({
          ...base,
          ...pullRequest,
          appName: 'pr-with-expiry',
          expiresAt,
        }),
      ).rejects.toThrow();

      // Each shape as the trigger says it.
      await expect(
        ctx.db.insert(previewDeployment).values({
          ...base,
          ...pullRequest,
          appName: 'pr-as-it-should',
        }),
      ).resolves.toBeDefined();
      await expect(
        ctx.db.insert(previewDeployment).values({
          ...base,
          appName: 'requested-as-it-should',
          trigger: 'requested',
          expiresAt,
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('the switch', () => {
    it('reads not allowed on an Application created today', async () => {
      const t = await setUp({ allowed: false });
      const created = await applications.create(t.ownerCtx, {
        name: 'Fresh',
        appName: 'fresh',
        environmentId: t.environment.environmentId,
      });

      const read = await request(server)
        .get(`/applications/${created.applicationId}`)
        .set('Cookie', t.ownerCookie);

      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ requestedPreviewsAllowed: false });
    });

    it('refuses a granted caller with the 409 sentence', async () => {
      const t = await setUp({ allowed: false });

      const res = await ask(t.ownerCookie, t.application.applicationId, {
        branch: 'feature/x',
      });

      expect(res.status).toBe(409);
      expect((res.body as { message: string }).message).toBe(
        'Requested previews are not allowed on this Application',
      );
    });

    it('is refused to an Agent writing it, since neither agent role holds service update', async () => {
      const t = await setUp({ allowed: false });
      const operator = await agent(t, 'agentOperator');

      await expect(
        applications.update(operator.ctx, t.application.applicationId, {
          requestedPreviewsAllowed: true,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('turned off refuses create, extend and redeploy, and removes nothing', async () => {
      const t = await setUp();
      const created = await previews.createRequested(
        t.ownerCtx,
        t.application.applicationId,
        { branch: 'feature/x' },
      );
      await setAllowed(t, false);
      queueMock.add.mockClear();
      execMock.execAsync.mockClear();
      execMock.execFileAsync.mockClear();

      const create = await ask(t.ownerCookie, t.application.applicationId, {
        branch: 'feature/y',
      });
      const extend = await request(server)
        .post(`/preview-deployments/${created.previewDeploymentId}/extend`)
        .set('Cookie', t.ownerCookie)
        .send({});
      const redeploy = await request(server)
        .post(`/preview-deployments/${created.previewDeploymentId}/redeploy`)
        .set('Cookie', t.ownerCookie)
        .send({});

      for (const res of [create, extend, redeploy]) {
        expect(res.status).toBe(409);
        expect((res.body as { message: string }).message).toBe(SWITCH_REFUSAL);
      }
      // The live preview is still there and still listed, unchanged, and
      // nothing was queued or torn down.
      const rows = await ctx.db.select().from(previewDeployment);
      expect(rows).toEqual([
        expect.objectContaining({
          previewDeploymentId: created.previewDeploymentId,
          expiresAt: created.expiresAt,
        }),
      ]);
      expect(queueMock.add).not.toHaveBeenCalled();
      expect(execMock.execAsync).not.toHaveBeenCalled();
      expect(execMock.execFileAsync).not.toHaveBeenCalled();
    });

    it('never governs a pull-request preview, whose redeploy is not its setting', async () => {
      const t = await setUp({ allowed: false });
      await previews.handlePullRequestEvent(t.connection.githubId, prOpened);
      const [pr] = await previews.findAllByApplicationId(
        t.ownerCtx,
        t.application.applicationId,
      );

      const redeploy = await request(server)
        .post(`/preview-deployments/${pr.previewDeploymentId}/redeploy`)
        .set('Cookie', t.ownerCookie)
        .send({});

      expect(redeploy.status).toBe(201);
    });
  });

  describe('who may ask', () => {
    it('a Member holding the grant creates one', async () => {
      const t = await setUp();
      const ida = await invitedMember(t, [t.application.applicationId]);

      const res = await ask(ida.cookie, t.application.applicationId, {
        branch: 'feature/x',
      });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        trigger: 'requested',
        requesterId: ida.id,
        branch: 'feature/x',
      });
    });

    it('an agentOperator creates one and an agentReader is refused', async () => {
      const t = await setUp();
      const operator = await agent(t, 'agentOperator');
      const reader = await agent(t, 'agentReader');

      const created = await previews.createRequested(
        operator.ctx,
        t.application.applicationId,
        { branch: 'feature/x' },
      );
      expect(created).toMatchObject({
        trigger: 'requested',
        requesterId: operator.id,
      });

      await expect(
        previews.createRequested(reader.ctx, t.application.applicationId, {
          branch: 'feature/x',
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(await ctx.db.select().from(previewDeployment)).toHaveLength(1);
    });
  });

  /**
   * The refusal chain, step by step, each caller one step further along it
   * than the last (ADR-0026's pin): permission, grant, switch, validation.
   * The cap is appended after the last.
   */
  describe('the refusal chain', () => {
    it('refuses in order: permission, then grant, then switch, then validation', async () => {
      const t = await setUp({ allowed: false });
      // A source with no branch, so every request below is also invalid: each
      // step has to answer before the validation that would refuse it too.
      await applications.update(t.ownerCtx, t.application.applicationId, {
        sourceType: 'docker',
      });
      const reader = await agent(t, 'agentReader');
      const ungranted = await invitedMember(t, []);
      const input = { branch: 'feature/x', ttlMinutes: 100_000 };
      const id = t.application.applicationId;

      // 3. The permission: an agentReader holds no deployment create.
      const permission = await previews
        .createRequested(reader.ctx, id, input)
        .catch((error: unknown) => error);
      expect(permission).toBeInstanceOf(ForbiddenException);
      expect((permission as Error).message).not.toBe(SWITCH_REFUSAL);

      // 4. The grant: a Member with the permission and no row on the parent.
      const grant = await ask(ungranted.cookie, id, input);
      expect(grant.status).toBe(403);

      // 5. The switch: the owner holds both, and the Application says no.
      const toSwitch = await ask(t.ownerCookie, id, input);
      expect(toSwitch.status).toBe(409);
      expect((toSwitch.body as { message: string }).message).toBe(
        SWITCH_REFUSAL,
      );

      // 6. Validation, once the switch is on.
      await setAllowed(t, true);
      const validation = await ask(t.ownerCookie, id, input);
      expect(validation.status).toBe(400);
      expect((validation.body as { message: string }).message).toBe(
        `A requested preview builds a branch, and this Application's source type "docker" has none`,
      );
      expect(await ctx.db.select().from(previewDeployment)).toEqual([]);
    });

    it('gives an ungranted caller the byte-identical answer whether the switch is on or off', async () => {
      const t = await setUp({ allowed: false });
      const ungranted = await invitedMember(t, []);

      const whileOff = await ask(
        ungranted.cookie,
        t.application.applicationId,
        {
          branch: 'feature/x',
        },
      );
      await setAllowed(t, true);
      const whileOn = await ask(ungranted.cookie, t.application.applicationId, {
        branch: 'feature/x',
      });

      expect(whileOff.status).toBe(403);
      expect(whileOn.status).toBe(whileOff.status);
      expect(refusal(whileOn.body)).toEqual(refusal(whileOff.body));
      expect(JSON.stringify(refusal(whileOff.body))).not.toContain(
        'Requested previews',
      );
    });

    it('refuses a TTL over the maximum rather than clamping it, naming the maximum', async () => {
      const t = await setUp();
      const lowered = await request(server)
        .post('/settings/requested-preview-max-ttl')
        .set('Cookie', t.ownerCookie)
        .send({ requestedPreviewMaxTtlMinutes: 120 });
      expect(lowered.status).toBe(200);

      const over = await ask(t.ownerCookie, t.application.applicationId, {
        branch: 'feature/x',
        ttlMinutes: 121,
      });
      expect(over.status).toBe(400);
      expect((over.body as { message: string }).message).toBe(
        "ttlMinutes is 121, over this instance's maximum of 120 minutes",
      );
      const within = await ask(t.ownerCookie, t.application.applicationId, {
        branch: 'feature/x',
        ttlMinutes: 120,
      });
      expect(within.status).toBe(201);
    });

    it('refuses a branch git could never check out before reading anything stored', async () => {
      const t = await setUp();

      for (const branch of ['', ' ', '-x', 'a..b', 'a b']) {
        const res = await ask(t.ownerCookie, t.application.applicationId, {
          branch,
        });
        expect(res.status).toBe(400);
      }
      expect(await ctx.db.select().from(previewDeployment)).toEqual([]);
    });
  });

  describe('create', () => {
    it('answers the preview, its printed link and the queued Deployment, described by its branch', async () => {
      const t = await setUp();
      const before = Date.now();

      const res = await ask(t.ownerCookie, t.application.applicationId, {
        branch: 'feature/health',
      });

      expect(res.status).toBe(201);
      const body = res.body as {
        previewDeploymentId: string;
        deploymentId: string;
        domain: string;
        expiresAt: string;
        url: string;
        urlNote?: string;
      };
      expect(body).toMatchObject({
        trigger: 'requested',
        branch: 'feature/health',
        pullRequestNumber: null,
        url: `http://${body.domain}`,
      });
      expect(body.urlNote).toEqual(expect.any(String));
      // The default TTL, 60 minutes from the ask.
      const expires = Date.parse(body.expiresAt);
      expect(expires).toBeGreaterThanOrEqual(before + 60 * MINUTE);
      expect(expires).toBeLessThanOrEqual(Date.now() + 60 * MINUTE);

      const [queued] = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.deploymentId, body.deploymentId));
      expect(queued).toMatchObject({
        applicationId: t.application.applicationId,
        previewDeploymentId: body.previewDeploymentId,
        status: 'pending',
        description: 'Requested preview of feature/health',
      });
      expect(queueMock.add).toHaveBeenCalledWith(
        expect.objectContaining({
          applicationType: 'application-preview',
          previewDeploymentId: body.previewDeploymentId,
          deploymentId: body.deploymentId,
          type: 'deploy',
        }),
      );
    });

    it('never coalesces: two asks for one branch are two previews', async () => {
      const t = await setUp();

      const first = await ask(t.ownerCookie, t.application.applicationId, {
        branch: 'feature/x',
      });
      const second = await ask(t.ownerCookie, t.application.applicationId, {
        branch: 'feature/x',
      });

      const [a, b] = [first.body, second.body] as {
        previewDeploymentId: string;
        deploymentId: string;
        appName: string;
      }[];
      expect(a.previewDeploymentId).not.toBe(b.previewDeploymentId);
      expect(a.deploymentId).not.toBe(b.deploymentId);
      expect(a.appName).not.toBe(b.appName);
      expect(queueMock.add).toHaveBeenCalledTimes(2);
    });

    it('builds the asked-for branch of a plain git Application, from the column its clone reads', async () => {
      const t = await setUp();
      await applications.update(t.ownerCtx, t.application.applicationId, {
        sourceType: 'git',
        customGitUrl: 'https://example.com/octabyte/cloudgate.git',
        customGitBranch: 'main',
      });
      const created = await previews.createRequested(
        t.ownerCtx,
        t.application.applicationId,
        { branch: 'feature/asked' },
      );

      await previews.deployPreview(created.previewDeploymentId, {
        deploymentId: created.deploymentId,
      });

      const commands = execMock.execAsync.mock.calls
        .map(([command]: [string]) => command)
        .join('\n');
      expect(commands).toContain('--branch feature/asked');
      expect(commands).not.toContain('--branch main');
    });
  });

  /**
   * With no preview wildcard a preview's host used to be
   * `<appName>.sslip.io`, which sslip.io answers nothing for. It now carries
   * the address of the machine the preview runs on, and a machine with none
   * is refused before any row is written.
   */
  describe('the host with no preview wildcard', () => {
    /** The parent with its wildcard cleared, and optionally a run Server. */
    async function unwildcarded(t: SetUp, serverIp?: string) {
      let serverId: string | null = null;
      if (serverIp !== undefined) {
        const [row] = await ctx.db
          .insert(serverTable)
          .values({
            name: 'runner',
            ipAddress: serverIp,
            port: 22,
            organizationId: t.organizationId,
          })
          .returning();
        serverId = row.serverId;
      }
      await ctx.db
        .update(application)
        .set({ previewWildcard: null, serverId })
        .where(eq(application.applicationId, t.application.applicationId));
    }

    const created = async (t: SetUp) => {
      const res = await ask(t.ownerCookie, t.application.applicationId, {
        branch: 'feature/x',
      });
      expect(res.status).toBe(201);
      return res.body as { domain: string; appName: string; urlNote: string };
    };

    it("carries the run Server's address", async () => {
      const t = await setUp();
      await unwildcarded(t, '203.0.113.10');

      const body = await created(t);

      expect(body.domain).toBe(`${body.appName}-203-0-113-10.sslip.io`);
      expect(body.urlNote).toContain('no preview wildcard');
    });

    it("carries the platform host's address when there is no Server", async () => {
      const t = await setUp();
      await unwildcarded(t);
      await ctx.db
        .insert(webServerSettings)
        .values({ serverIp: '198.51.100.7' });

      expect((await created(t)).domain).toMatch(/-198-51-100-7\.sslip\.io$/);
    });

    it('dashes an IPv6 address and keeps every label within 63', async () => {
      const t = await setUp();
      await unwildcarded(t, '2001:0db8:85a3:0000:0000:8a2e:0370:7334');

      const { domain } = await created(t);

      expect(domain).toMatch(
        /-2001-0db8-85a3-0000-0000-8a2e-0370-7334\.sslip\.io$/,
      );
      for (const label of domain.split('.')) {
        expect(label.length).toBeLessThanOrEqual(63);
      }
    });

    it.each([
      ['no settings row', null],
      ['an empty address', ''],
      ['a hostname', 'console.example.com'],
    ])(
      'refuses a 400 and writes nothing when the platform host has %s',
      async (_what, serverIp) => {
        const t = await setUp();
        await unwildcarded(t);
        if (serverIp !== null) {
          await ctx.db.insert(webServerSettings).values({ serverIp });
        }

        const res = await ask(t.ownerCookie, t.application.applicationId, {
          branch: 'feature/x',
        });

        expect(res.status).toBe(400);
        expect((res.body as { message: string }).message).toBe(
          'A preview host carries an IP in its name when its Application sets no preview wildcard, and no IP is recorded for this Cloudgate host: set its public address in Settings → Instance, or set a preview wildcard on the Application, then ask again',
        );
        expect(await ctx.db.select().from(previewDeployment)).toEqual([]);
        expect(queueMock.add).not.toHaveBeenCalled();
      },
    );

    it('refuses a Server that records a hostname, naming the Server', async () => {
      const t = await setUp();
      await unwildcarded(t, 'runner.example.com');

      const res = await ask(t.ownerCookie, t.application.applicationId, {
        branch: 'feature/x',
      });

      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toContain(
        "set the Server's IP address",
      );
      expect(await ctx.db.select().from(previewDeployment)).toEqual([]);
    });

    it('leaves a wildcard host as it was', async () => {
      const t = await setUp();

      const body = await created(t);

      expect(body.domain).toBe(`${body.appName}.preview.example.com`);
    });
  });

  describe('extend and redeploy', () => {
    it('extend sets the expiry to now plus the TTL, not added to what was left', async () => {
      const t = await setUp();
      const created = await previews.createRequested(
        t.ownerCtx,
        t.application.applicationId,
        { branch: 'feature/x', ttlMinutes: 600 },
      );
      const before = Date.now();

      const res = await request(server)
        .post(`/preview-deployments/${created.previewDeploymentId}/extend`)
        .set('Cookie', t.ownerCookie)
        .send({ ttlMinutes: 90 });

      expect(res.status).toBe(200);
      const expires = Date.parse((res.body as { expiresAt: string }).expiresAt);
      expect(expires).toBeGreaterThanOrEqual(before + 90 * MINUTE);
      expect(expires).toBeLessThanOrEqual(Date.now() + 90 * MINUTE);
      expect(res.body).toMatchObject({ url: expect.any(String) as string });
    });

    it('extend is refused over the maximum and on a pull-request preview', async () => {
      const t = await setUp();
      const created = await previews.createRequested(
        t.ownerCtx,
        t.application.applicationId,
        { branch: 'feature/x' },
      );
      await previews.handlePullRequestEvent(t.connection.githubId, prOpened);
      const pr = (
        await previews.findAllByApplicationId(
          t.ownerCtx,
          t.application.applicationId,
        )
      ).find((row) => row.trigger === 'pullRequest')!;

      const over = await request(server)
        .post(`/preview-deployments/${created.previewDeploymentId}/extend`)
        .set('Cookie', t.ownerCookie)
        .send({ ttlMinutes: 1441 });
      expect(over.status).toBe(400);
      expect((over.body as { message: string }).message).toBe(
        "ttlMinutes is 1441, over this instance's maximum of 1440 minutes",
      );

      await expect(
        previews.extend(t.ownerCtx, pr.previewDeploymentId, {}),
      ).rejects.toThrow(ConflictException);
    });

    it('a redeploy answers 201 with the queued Deployment and leaves the expiry where it was', async () => {
      const t = await setUp();
      const created = await previews.createRequested(
        t.ownerCtx,
        t.application.applicationId,
        { branch: 'feature/x' },
      );

      const res = await request(server)
        .post(`/preview-deployments/${created.previewDeploymentId}/redeploy`)
        .set('Cookie', t.ownerCookie)
        .send({});

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        previewDeploymentId: created.previewDeploymentId,
        status: 'pending',
        description: 'Requested preview of feature/x',
      });
      const [row] = await ctx.db
        .select()
        .from(previewDeployment)
        .where(
          eq(
            previewDeployment.previewDeploymentId,
            created.previewDeploymentId,
          ),
        );
      expect(row.expiresAt).toBe(created.expiresAt);
    });
  });

  describe('build notifications', () => {
    /** The deploy and build-error events dispatched, by type. */
    function buildEvents() {
      return jest.spyOn(dispatcher, 'dispatch').mockResolvedValue(undefined);
    }
    const typesOf = (spy: ReturnType<typeof buildEvents>) =>
      spy.mock.calls
        .map(([, event]) => (event as { type: string }).type)
        .filter((type) => type === 'app-deploy' || type === 'app-build-error');

    it('a requested preview dispatches neither the deploy nor the build-error event', async () => {
      const t = await setUp();
      const spy = buildEvents();
      try {
        const ok = await previews.createRequested(
          t.ownerCtx,
          t.application.applicationId,
          { branch: 'feature/ok' },
        );
        await previews.deployPreview(ok.previewDeploymentId, {
          deploymentId: ok.deploymentId,
        });
        const failing = await previews.createRequested(
          t.ownerCtx,
          t.application.applicationId,
          { branch: 'feature/broken' },
        );
        docker.createService.mockRejectedValueOnce(new Error('no space left'));
        await expect(
          previews.deployPreview(failing.previewDeploymentId, {
            deploymentId: failing.deploymentId,
          }),
        ).rejects.toThrow();

        expect(typesOf(spy)).toEqual([]);
        // Nor is a pull request told about a preview no pull request made.
        expect(octokitMock.rest.issues.createComment).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('a pull-request preview build still dispatches both', async () => {
      const t = await setUp();
      await previews.handlePullRequestEvent(t.connection.githubId, prOpened);
      const [pr] = await previews.findAllByApplicationId(
        t.ownerCtx,
        t.application.applicationId,
      );
      const spy = buildEvents();
      try {
        await previews.deployPreview(pr.previewDeploymentId, {});
        docker.createService.mockRejectedValueOnce(new Error('no space left'));
        await expect(
          previews.deployPreview(pr.previewDeploymentId, {}),
        ).rejects.toThrow();

        expect(typesOf(spy)).toEqual(['app-deploy', 'app-build-error']);
      } finally {
        spy.mockRestore();
      }
    });
  });

  /**
   * A preview build is a Deployment of its parent, and the engine used
   * to write its outcome onto that parent's `applicationStatus` too: an
   * Agent's failed requested preview left production reading `error`, and a
   * preview that built would have written `done` over a real production error.
   * The preview's own status is the only one a preview build moves.
   */
  describe("the parent's status", () => {
    async function parentStatus(applicationId: string) {
      const [row] = await ctx.db
        .select({ status: application.applicationStatus })
        .from(application)
        .where(eq(application.applicationId, applicationId));
      return row.status;
    }
    async function setParentStatus(
      applicationId: string,
      status: 'done' | 'error',
    ) {
      await ctx.db
        .update(application)
        .set({ applicationStatus: status })
        .where(eq(application.applicationId, applicationId));
    }

    it('a requested preview build, failing or succeeding, leaves its parent as it was', async () => {
      const t = await setUp();
      const parentId = t.application.applicationId;
      await setParentStatus(parentId, 'done');

      const failing = await previews.createRequested(t.ownerCtx, parentId, {
        branch: 'feature/broken',
      });
      docker.createService.mockRejectedValueOnce(new Error('no space left'));
      await expect(
        previews.deployPreview(failing.previewDeploymentId, {
          deploymentId: failing.deploymentId,
        }),
      ).rejects.toThrow();
      expect(await parentStatus(parentId)).toBe('done');

      await setParentStatus(parentId, 'error');
      const ok = await previews.createRequested(t.ownerCtx, parentId, {
        branch: 'feature/ok',
      });
      await previews.deployPreview(ok.previewDeploymentId, {
        deploymentId: ok.deploymentId,
      });
      // Production's real error is still production's.
      expect(await parentStatus(parentId)).toBe('error');

      const statuses = await ctx.db
        .select({
          id: previewDeployment.previewDeploymentId,
          status: previewDeployment.previewStatus,
        })
        .from(previewDeployment)
        .where(eq(previewDeployment.applicationId, parentId));
      expect(Object.fromEntries(statuses.map((r) => [r.id, r.status]))).toEqual(
        {
          [failing.previewDeploymentId]: 'error',
          [ok.previewDeploymentId]: 'done',
        },
      );
    });

    it('a pull-request preview build leaves its parent as it was too', async () => {
      const t = await setUp();
      const parentId = t.application.applicationId;
      await previews.handlePullRequestEvent(t.connection.githubId, prOpened);
      const [pr] = await previews.findAllByApplicationId(t.ownerCtx, parentId);

      await setParentStatus(parentId, 'done');
      docker.createService.mockRejectedValueOnce(new Error('no space left'));
      await expect(
        previews.deployPreview(pr.previewDeploymentId, {}),
      ).rejects.toThrow();
      expect(await parentStatus(parentId)).toBe('done');

      await setParentStatus(parentId, 'error');
      await previews.deployPreview(pr.previewDeploymentId, {});
      expect(await parentStatus(parentId)).toBe('error');
    });
  });

  describe('audit', () => {
    it('create and extend each write a row naming the caller, the branch and the expiry', async () => {
      const t = await setUp();
      const operator = await agent(t, 'agentOperator');

      const created = await previews.createRequested(
        operator.ctx,
        t.application.applicationId,
        { branch: 'feature/x' },
      );
      const extended = await previews.extend(
        operator.ctx,
        created.previewDeploymentId,
        { ttlMinutes: 30 },
      );

      const rows = await ctx.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.resourceType, 'previewDeployment'),
            eq(auditLog.resourceId, created.previewDeploymentId),
          ),
        );
      const byAction = Object.fromEntries(
        rows.map((row) => [
          row.action,
          {
            ...row,
            metadata: JSON.parse(row.metadata ?? '{}') as Record<
              string,
              unknown
            >,
          },
        ]),
      );
      expect(rows).toHaveLength(2);
      expect(byAction.create).toMatchObject({
        userId: operator.id,
        userRole: 'agentOperator',
        outcome: 'succeeded',
        metadata: {
          trigger: 'requested',
          branch: 'feature/x',
          expiresAt: created.expiresAt,
          deploymentId: created.deploymentId,
        },
      });
      expect(byAction.update).toMatchObject({
        userId: operator.id,
        metadata: {
          type: 'extend',
          branch: 'feature/x',
          ttlMinutes: 30,
          expiresAt: extended.expiresAt,
        },
      });
    });

    it('the create route writes its row once, not a second one as an Application update', async () => {
      const t = await setUp();

      const res = await ask(t.ownerCookie, t.application.applicationId, {
        branch: 'feature/x',
      });
      expect(res.status).toBe(201);

      const rows = await ctx.db
        .select({
          action: auditLog.action,
          resourceType: auditLog.resourceType,
        })
        .from(auditLog)
        .where(eq(auditLog.userId, t.ownerId));
      expect(
        rows.filter(
          (row) =>
            row.resourceType === 'previewDeployment' ||
            (row.resourceType === 'application' && row.action === 'update'),
        ),
      ).toEqual([
        // The setUp's own writes go through the service, not the route.
        { action: 'create', resourceType: 'previewDeployment' },
      ]);
    });
  });

  /**
   * The cap: `requestedPreviewLimit` counts requested previews only,
   * `previewLimit` pull-request previews only, and the cap is the last step
   * of create's refusal chain.
   */
  describe('the cap', () => {
    /** A requested row written straight in, as a live or expired preview. */
    const heldPreview = (t: SetUp, name: string, expiresAt: string) =>
      ctx.db.insert(previewDeployment).values({
        applicationId: t.application.applicationId,
        trigger: 'requested',
        branch: `feature/${name}`,
        appName: `preview-${name}`,
        domain: `preview-${name}.preview.example.com`,
        expiresAt,
      });

    const setLimits = (
      t: SetUp,
      limits: { previewLimit?: number; requestedPreviewLimit?: number },
    ) => applications.update(t.ownerCtx, t.application.applicationId, limits);

    it('a full requested cap still admits a pull request its preview', async () => {
      const t = await setUp();
      await setLimits(t, { previewLimit: 1, requestedPreviewLimit: 1 });
      await previews.createRequested(t.ownerCtx, t.application.applicationId, {
        branch: 'feature/x',
      });

      await previews.handlePullRequestEvent(t.connection.githubId, prOpened);

      const rows = await ctx.db.select().from(previewDeployment);
      expect(rows.map((row) => row.trigger).sort()).toEqual([
        'pullRequest',
        'requested',
      ]);
    });

    it('a full pull-request cap still admits a requested preview', async () => {
      const t = await setUp();
      await setLimits(t, { previewLimit: 1, requestedPreviewLimit: 1 });
      await previews.handlePullRequestEvent(t.connection.githubId, prOpened);

      const res = await ask(t.ownerCookie, t.application.applicationId, {
        branch: 'feature/x',
      });

      expect(res.status).toBe(201);
      // And the pull-request cap is still full for the next pull request.
      await previews.handlePullRequestEvent(t.connection.githubId, {
        ...prOpened,
        pullRequestId: '990002',
        pullRequestNumber: '43',
        pullRequestURL: 'https://github.com/example-org/shop/pull/43',
      });
      const pullRequests = await ctx.db
        .select()
        .from(previewDeployment)
        .where(eq(previewDeployment.trigger, 'pullRequest'));
      expect(pullRequests).toHaveLength(1);
    });

    it('is refused with a 409 naming the limit and the soonest expiry, with no finality sentence', async () => {
      const t = await setUp();
      await heldPreview(t, 'a', '2099-01-03T00:00:00.000Z');
      await heldPreview(t, 'b', '2099-01-01T00:00:00.000Z');
      await heldPreview(t, 'c', '2099-01-02T00:00:00.000Z');

      const res = await ask(t.ownerCookie, t.application.applicationId, {
        branch: 'feature/x',
      });

      expect(res.status).toBe(409);
      const message = (res.body as { message: string }).message;
      expect(message).toBe(
        "This Application holds at most 3 requested previews at once, and already holds 3. Deleting one expires it now, and its slot frees once its teardown finishes; the soonest expires at 2099-01-01T00:00:00.000Z. This Application's operator sets the limit",
      );
      expect(message).not.toContain('This is an access decision');
      expect(await ctx.db.select().from(previewDeployment)).toHaveLength(3);
      expect(queueMock.add).not.toHaveBeenCalled();
    });

    it('names the soonest live expiry past a sibling just deleted', async () => {
      const t = await setUp();
      await heldPreview(t, 'a', '2099-01-03T00:00:00.000Z');
      await heldPreview(t, 'b', '2099-01-02T00:00:00.000Z');
      const [deleted] = await ctx.db
        .select()
        .from(previewDeployment)
        .where(eq(previewDeployment.branch, 'feature/a'));
      // Deleting one expires it now, which gives it the soonest expiry of all.
      await previews.remove(t.ownerCtx, deleted.previewDeploymentId);
      await heldPreview(t, 'c', '2099-01-04T00:00:00.000Z');

      const res = await ask(t.ownerCookie, t.application.applicationId, {
        branch: 'feature/x',
      });

      expect(res.status).toBe(409);
      expect((res.body as { message: string }).message).toContain(
        '; the soonest expires at 2099-01-02T00:00:00.000Z.',
      );
    });

    it('counts an expired preview whose teardown is still pending', async () => {
      // The sweep marks a row expired; until then an expiry in the past is the
      // teardown-pending row the sweep has not yet removed.
      const t = await setUp();
      await setLimits(t, { requestedPreviewLimit: 1 });
      await heldPreview(t, 'gone', '2026-01-01T00:00:00.000Z');

      const res = await ask(t.ownerCookie, t.application.applicationId, {
        branch: 'feature/x',
      });

      expect(res.status).toBe(409);
      expect((res.body as { message: string }).message).toBe(
        "This Application holds at most 1 requested preview at once, and already holds 1. Deleting one expires it now, and its slot frees once its teardown finishes; the soonest already expired at 2026-01-01T00:00:00.000Z and is being torn down. This Application's operator sets the limit",
      );
    });

    it('refuses a request both invalid and over the cap for being invalid', async () => {
      const t = await setUp();
      await setLimits(t, { requestedPreviewLimit: 1 });
      await heldPreview(t, 'a', '2099-01-01T00:00:00.000Z');

      const res = await ask(t.ownerCookie, t.application.applicationId, {
        branch: 'feature/x',
        ttlMinutes: 1441,
      });

      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toBe(
        "ttlMinutes is 1441, over this instance's maximum of 1440 minutes",
      );
    });

    it('writes a failed audit row with its fixed reason, and notifies nobody', async () => {
      const t = await setUp();
      const operator = await agent(t, 'agentOperator');
      await setLimits(t, { requestedPreviewLimit: 1 });
      await heldPreview(t, 'a', '2099-01-01T00:00:00.000Z');
      const dispatch = jest
        .spyOn(dispatcher, 'dispatch')
        .mockResolvedValue(undefined);
      try {
        await expect(
          previews.createRequested(operator.ctx, t.application.applicationId, {
            branch: 'feature/x',
          }),
        ).rejects.toThrow(ConflictException);

        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        dispatch.mockRestore();
      }
      const rows = await ctx.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.resourceType, 'previewDeployment'),
            eq(auditLog.userId, operator.id),
          ),
        );
      expect(rows).toHaveLength(1);
      expect({
        ...rows[0],
        metadata: JSON.parse(rows[0].metadata ?? '{}') as unknown,
      }).toMatchObject({
        action: 'create',
        outcome: 'failed',
        userRole: 'agentOperator',
        resourceId: null,
        metadata: {
          reason: 'preview-limit',
          trigger: 'requested',
          applicationId: t.application.applicationId,
          branch: 'feature/x',
          requestedPreviewLimit: 1,
        },
      });
    });

    it('extend and redeploy succeed at a full cap', async () => {
      const t = await setUp();
      await setLimits(t, { requestedPreviewLimit: 1 });
      const created = await previews.createRequested(
        t.ownerCtx,
        t.application.applicationId,
        { branch: 'feature/x' },
      );

      const extend = await request(server)
        .post(`/preview-deployments/${created.previewDeploymentId}/extend`)
        .set('Cookie', t.ownerCookie)
        .send({ ttlMinutes: 30 });
      const redeploy = await request(server)
        .post(`/preview-deployments/${created.previewDeploymentId}/redeploy`)
        .set('Cookie', t.ownerCookie)
        .send({});

      expect(extend.status).toBe(200);
      expect(redeploy.status).toBe(201);
    });

    it('requestedPreviewLimit defaults to 3, refuses 0, and is refused without service update', async () => {
      const t = await setUp();
      const operator = await agent(t, 'agentOperator');

      const read = await request(server)
        .get(`/applications/${t.application.applicationId}`)
        .set('Cookie', t.ownerCookie);
      expect(read.body).toMatchObject({ requestedPreviewLimit: 3 });

      const zero = await request(server)
        .patch(`/applications/${t.application.applicationId}`)
        .set('Cookie', t.ownerCookie)
        .send({ requestedPreviewLimit: 0 });
      expect(zero.status).toBe(400);

      await expect(
        applications.update(operator.ctx, t.application.applicationId, {
          requestedPreviewLimit: 5,
        }),
      ).rejects.toThrow(ForbiddenException);

      const one = await request(server)
        .patch(`/applications/${t.application.applicationId}`)
        .set('Cookie', t.ownerCookie)
        .send({ requestedPreviewLimit: 1 });
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({ requestedPreviewLimit: 1 });
    });
  });

  describe('existing reads', () => {
    it('list and get return both triggers, each carrying its trigger', async () => {
      const t = await setUp();
      await previews.handlePullRequestEvent(t.connection.githubId, prOpened);
      const created = await previews.createRequested(
        t.ownerCtx,
        t.application.applicationId,
        { branch: 'feature/x' },
      );

      const list = await request(server)
        .get(`/applications/${t.application.applicationId}/preview-deployments`)
        .set('Cookie', t.ownerCookie);
      expect(list.status).toBe(200);
      expect(
        (list.body as { trigger: string }[]).map((row) => row.trigger).sort(),
      ).toEqual(['pullRequest', 'requested']);

      const one = await request(server)
        .get(`/preview-deployments/${created.previewDeploymentId}`)
        .set('Cookie', t.ownerCookie);
      expect(one.body).toMatchObject({
        trigger: 'requested',
        expiresAt: created.expiresAt,
        pullRequestNumber: null,
      });
    });
  });

  /**
   * The Previews row names who asked, from the create audit row so a
   * removed requester is still named, tags where they stand now, and links the
   * newest build.
   */
  describe('the row facts', () => {
    type Listed = {
      previewDeploymentId: string;
      trigger: string;
      requestedBy: {
        id: string | null;
        name: string | null;
        standing: string;
      } | null;
      latestDeploymentId: string | null;
    };
    const listed = async (t: SetUp) => {
      const res = await request(server)
        .get(`/applications/${t.application.applicationId}/preview-deployments`)
        .set('Cookie', t.ownerCookie);
      expect(res.status).toBe(200);
      return res.body as Listed[];
    };
    const rowOf = async (t: SetUp, id: string) =>
      (await listed(t)).find((row) => row.previewDeploymentId === id);

    it('names the requester and links the newest build on list and get; a pull-request preview has no requester', async () => {
      const t = await setUp();
      await previews.handlePullRequestEvent(t.connection.githubId, prOpened);
      const created = await previews.createRequested(
        t.ownerCtx,
        t.application.applicationId,
        { branch: 'feature/x' },
      );

      const rows = await listed(t);
      const requested = rows.find((row) => row.trigger === 'requested');
      expect(requested).toMatchObject({
        requestedBy: { id: t.ownerId, name: owner.name, standing: 'member' },
        latestDeploymentId: created.deploymentId,
      });
      const pullRequest = rows.find((row) => row.trigger === 'pullRequest');
      expect(pullRequest?.requestedBy).toBeNull();

      // Settled first: a redeploy while the first build is still pending
      // joins it rather than writing a second row.
      await ctx.db
        .update(deployment)
        .set({ status: 'done' })
        .where(eq(deployment.deploymentId, created.deploymentId));
      const rebuilt = await previews.redeploy(
        t.ownerCtx,
        created.previewDeploymentId,
      );
      expect(rebuilt.deploymentId).not.toBe(created.deploymentId);
      const one = await request(server)
        .get(`/preview-deployments/${created.previewDeploymentId}`)
        .set('Cookie', t.ownerCookie);
      expect((one.body as Listed).latestDeploymentId).toBe(
        rebuilt.deploymentId,
      );
      expect((one.body as Listed).requestedBy?.name).toBe(owner.name);
    });

    it('still names a requester removed from the Organization, tagged removed', async () => {
      const t = await setUp();
      const ida = await invitedMember(t, [t.application.applicationId]);
      const created = await previews.createRequested(
        ida.ctx,
        t.application.applicationId,
        { branch: 'feature/x' },
      );

      await ctx.db.delete(member).where(eq(member.userId, ida.id));

      expect(
        (await rowOf(t, created.previewDeploymentId))?.requestedBy,
      ).toEqual({ id: ida.id, name: 'Ida Rhodes', standing: 'removed' });
    });

    it('tags a suspended Agent suspended, and a deleted one removed with its name kept', async () => {
      const t = await setUp();
      const bot = await agent(t, 'agentOperator');
      const created = await previews.createRequested(
        bot.ctx,
        t.application.applicationId,
        { branch: 'feature/x' },
      );

      const suspend = await request(server)
        .post(`/agents/${bot.id}/suspend`)
        .set('Cookie', t.ownerCookie);
      expect(suspend.status).toBeLessThan(300);
      expect(
        (await rowOf(t, created.previewDeploymentId))?.requestedBy,
      ).toEqual({
        id: bot.id,
        name: 'agentOperator-bot',
        standing: 'suspended',
      });

      const removed = await request(server)
        .delete(`/agents/${bot.id}`)
        .set('Cookie', t.ownerCookie);
      expect(removed.status).toBeLessThan(300);
      expect(
        (await rowOf(t, created.previewDeploymentId))?.requestedBy,
      ).toMatchObject({ name: 'agentOperator-bot', standing: 'removed' });
    });
  });

  describe('the instance maximum TTL', () => {
    it('is refused to a caller without instance authority', async () => {
      const t = await setUp();
      const ida = await invitedMember(t, [t.application.applicationId]);

      const res = await request(server)
        .post('/settings/requested-preview-max-ttl')
        .set('Cookie', ida.cookie)
        .send({ requestedPreviewMaxTtlMinutes: 60 });

      expect(res.status).toBe(403);
    });
  });
});
