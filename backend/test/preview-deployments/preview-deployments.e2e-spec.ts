import { createHmac } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { parse } from 'yaml';
import { application as applicationTable } from '../../src/applications/application.schema';
import { ApplicationsService } from '../../src/applications/applications.service';
import { auditLog, certificate } from '../../src/db/schema';
import type { DeploymentJob } from '../../src/deployment-queue/job-types';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import type { QueuedJob } from '../../src/deployment-queue/queue.port';
import { deployment } from '../../src/deployments/deployment.schema';
import { DeploymentsService } from '../../src/deployments/deployments.service';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { SecurityService } from '../../src/networking/security/security.service';
import { GithubService } from '../../src/git-providers/strategies/github/github.service';
import { OCTOKIT_FACTORY } from '../../src/git-providers/strategies/github/octokit.provider';
import { previewDeployment } from '../../src/preview-deployments/preview-deployment.schema';
import { PreviewDeploymentsService } from '../../src/preview-deployments/preview-deployments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { server as serverTable } from '../../src/servers/server.schema';
import { webServerSettings } from '../../src/settings/settings.schema';
import type { FileConfig } from '../../src/traefik/config/file-types';
import { dynamicTraefikConfigPath } from '../../src/traefik/traefik-writer.service';
import { freezeOrganization } from '../utils/frozen-organization';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { WILDCARD_PREVIEW_EXAMPLE_COM_PEM } from './fixtures/preview-certificates';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(120_000);

/**
 * A preview's `dynamic/{appName}.yml` on the default `previewPort`, as
 * `traefik/config/preview.ts` wrote it on `fcbd0b83`, before the fix — `APP` and
 * `HOST` stand in for the preview's appName and host.
 */
const PINNED_PREVIEW_CONFIG = `http:
  routers:
    APP-router-1:
      rule: Host(\`HOST\`)
      service: APP-service-1
      middlewares: []
      entryPoints:
        - web
    APP-router-websecure-1:
      rule: Host(\`HOST\`)
      service: APP-service-1
      middlewares: []
      entryPoints:
        - websecure
      tls: {}
  services:
    APP-service-1:
      loadBalancer:
        servers:
          - url: http://APP:3000
        passHostHeader: true
`;

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

// A fully-configured GitHub App connection (the preview source).
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

/** A pull request opened against the tracked production branch. */
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

async function signUp(
  server: App,
  body: { name: string; email: string; password: string },
): Promise<{ cookie: string; id: string }> {
  const res = await request(server).post('/api/auth/sign-up/email').send(body);
  expect(res.status).toBe(200);
  const { user } = res.body as { user: { id: string } };
  return { cookie: res.headers['set-cookie'], id: user.id };
}

const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

/** Invites a user into the owner's organization and accepts as them. */
async function inviteUser(
  server: App,
  ownerCookie: string,
  email: string,
  role: 'admin' | 'member',
): Promise<{ cookie: string; id: string }> {
  const invite = await request(server)
    .post('/organizations/invitations')
    .set('Cookie', ownerCookie)
    .send({ email, role });
  const inviteId = (invite.body as { id: string }).id;

  const su = await request(server)
    .post('/api/auth/sign-up/email')
    .set('x-cloudgate-token', inviteId)
    .send({ name: 'Ida Rhodes', email, password: 'super-secret-password' });
  const cookie = su.headers['set-cookie'];
  const id = (su.body as { user: { id: string } }).user.id;

  const accept = await request(server)
    .post(`/organizations/invitations/${inviteId}/accept`)
    .set('Cookie', cookie);
  expect(accept.status).toBe(201);

  return { cookie, id };
}

describe('Preview deployments (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let githubService: GithubService;
  let previews: PreviewDeploymentsService;
  let deployments: DeploymentsService;
  let basicAuth: SecurityService;

  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
    // Teardown removes the Swarm service and the cloned code as argv rather
    // than as a shell string (H-34), so the double has to carry both
    // halves of `execOnServer`'s fork.
    execFileAsync: jest.fn(),
    execRemote: jest.fn(),
  };

  /** A Swarm with no existing service: the engine converges by creating. */
  const dockerService = {
    inspect: jest.fn(),
    update: jest.fn(),
  };
  const docker = {
    getService: jest.fn(() => dockerService),
    createService: jest.fn(),
    listTasks: jest.fn(),
  };

  /** A release is now followed by a convergence poll that counts the
   * Service's running tasks. Three already running satisfies every replica
   * count these tests deploy, so the poll answers on its first read and
   * nothing here waits out a budget. */
  const convergedTasks = [1, 2, 3].map((n) => ({
    Status: { State: 'running', Timestamp: `2026-08-24T00:00:0${n}Z` },
  }));
  const dockerFactoryMock = {
    getRemoteDocker: jest.fn().mockResolvedValue(docker),
  };

  const queueMock = {
    add: jest.fn(),
    getJobs: jest.fn(),
    cancel: jest.fn(),
  };

  // The GitHub API boundary: comments, collaborator lookups and installation
  // tokens are stubbed.
  const octokitMock = {
    rest: {
      issues: {
        createComment: jest.fn(),
      },
      repos: {
        getCollaboratorPermissionLevel: jest.fn(),
      },
    },
    auth: jest.fn(),
  };

  /**
   * A real, writable platform root. A preview's host is routed by
   * writing `dynamic/{appName}.yml` on the machine that serves it, and these
   * previews run on the platform host — so the assertion that routing exists
   * and is then gone is a file on disk and then not, written and removed by
   * the real `TraefikWriterService`. The default test root is one nothing can
   * write to (`test/utils/platform-root.ts`); `source-tree-roots.e2e-spec.ts`
   * is the precedent for making one that can be.
   */
  const configuredRoot = fs.realpathSync(
    fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-preview-root-')),
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
    deployments = ctx.app.get(DeploymentsService);
    basicAuth = ctx.app.get(SecurityService);
  });

  afterAll(async () => {
    await ctx.teardown();
    if (originalRoot === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = originalRoot;
    fs.rmSync(configuredRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await ctx.resetDb();
    execMock.execAsync
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '' });
    execMock.execAsyncRemote
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '' });
    execMock.execFileAsync
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '' });
    execMock.execRemote
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '' });
    dockerService.inspect
      .mockReset()
      .mockRejectedValue(new Error('no such service'));
    dockerService.update.mockReset().mockResolvedValue(undefined);
    docker.getService.mockClear();
    docker.createService.mockReset().mockResolvedValue(undefined);
    docker.listTasks.mockReset().mockResolvedValue(convergedTasks);
    dockerFactoryMock.getRemoteDocker.mockClear();
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

  /** An owner ctx plus a GitHub-sourced application with previews enabled. */
  async function setUpApplication() {
    const ownerSession = await signUp(server, owner);
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', ownerSession.cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = permissionCtx(ownerSession.id, organizationId);

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
      },
    );
    return { organizationId, ownerSession, ownerCtx, application, connection };
  }

  describe('pull request opened', () => {
    it('creates a preview deployment with an isolated appName and domain', async () => {
      const { ownerCtx, application, connection } = await setUpApplication();

      await previews.handlePullRequestEvent(connection.githubId, prOpened);

      const rows = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        applicationId: application.applicationId,
        branch: 'feature/health',
        pullRequestId: '990001',
        pullRequestNumber: '42',
        pullRequestTitle: 'Add health endpoint',
        pullRequestURL: 'https://github.com/example-org/shop/pull/42',
        previewStatus: 'idle',
      });
      // The preview runs beside production, so it gets its own service name…
      expect(rows[0].appName).toMatch(/^preview-web-app-[a-z1-9]{6}$/);
      // …and its own host carved out of the application's preview wildcard.
      expect(rows[0].domain).toBe(`${rows[0].appName}.preview.example.com`);
    });

    it('enqueues a preview deploy for the created preview', async () => {
      const { ownerCtx, application, connection } = await setUpApplication();

      await previews.handlePullRequestEvent(connection.githubId, prOpened);

      const [preview] = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(queueMock.add).toHaveBeenCalledTimes(1);
      expect(queueMock.add).toHaveBeenCalledWith({
        applicationType: 'application-preview',
        applicationId: application.applicationId,
        previewDeploymentId: preview.previewDeploymentId,
        // The parent's pending row the build fills.
        deploymentId: expect.any(String) as string,
        title: 'Preview Deployment',
        description: expect.any(String) as string,
        type: 'deploy',
        serverId: null,
      });
    });

    it('a PR from an author without write access creates nothing', async () => {
      const { ownerCtx, application, connection } = await setUpApplication();
      // GitHub answers with read-only permission for the PR author.
      octokitMock.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
        data: { permission: 'read' },
      });

      await previews.handlePullRequestEvent(connection.githubId, prOpened);

      const rows = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(rows).toEqual([]);
      expect(queueMock.add).not.toHaveBeenCalled();
    });

    it("a pull request on a Frozen Organization's Application opens no preview and builds nothing", async () => {
      const { ownerCtx, application, connection, organizationId } =
        await setUpApplication();
      await freezeOrganization(ctx, organizationId);

      await previews.handlePullRequestEvent(connection.githubId, prOpened);

      const rows = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(rows).toEqual([]);
      expect(queueMock.add).not.toHaveBeenCalled();
      jest.restoreAllMocks();
    });
  });

  describe('preview limit', () => {
    /** The same PR event, renumbered — one per pull request. */
    const pr = (number: number) => ({
      ...prOpened,
      pullRequestId: `99000${number}`,
      pullRequestNumber: `${number}`,
      pullRequestURL: `https://github.com/example-org/shop/pull/${number}`,
      headBranch: `feature/${number}`,
    });

    it('defaults to three previews per application', async () => {
      const { ownerCtx, application } = await setUpApplication();

      expect(application.previewLimit).toBe(3);

      const found = await applications.findOne(
        ownerCtx,
        application.applicationId,
      );
      expect(found.previewLimit).toBe(3);
    });

    it('opens no more previews than the limit allows', async () => {
      const { ownerCtx, ownerSession, application, connection } =
        await setUpApplication();
      const capped = await request(server)
        .patch(`/applications/${application.applicationId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ previewLimit: 2 });
      expect(capped.status).toBe(200);

      for (const number of [1, 2, 3]) {
        await previews.handlePullRequestEvent(connection.githubId, pr(number));
      }

      const rows = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(rows).toHaveLength(2);
      // The third pull request is the one refused, and nothing was built
      // for it either.
      expect(rows.map((row) => row.pullRequestNumber).sort()).toEqual([
        '1',
        '2',
      ]);
      expect(queueMock.add).toHaveBeenCalledTimes(2);
    });

    it('a limit of zero refuses every preview', async () => {
      const { ownerCtx, ownerSession, application, connection } =
        await setUpApplication();
      await request(server)
        .patch(`/applications/${application.applicationId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ previewLimit: 0 });

      await previews.handlePullRequestEvent(connection.githubId, prOpened);

      const rows = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(rows).toEqual([]);
      expect(queueMock.add).not.toHaveBeenCalled();
    });

    /**
     * `ensurePreview` answered `null` at the cap and the webhook
     * `continue`d past it, so a refused pull request got *nothing*: no preview,
     * no comment, no row, and not a line in the log. The delivery answered 200
     * in 589 ms, which is what made it look like it had worked.
     *
     * **The same comment channel as the other two outcomes, because it is the
     * third outcome of the same event.** A ready preview and a failed build both
     * report through `postPrComment` on the pull request they belong to, and the
     * contributor who opened the third pull request is the one person who cannot
     * see the console. So the assertion is on the GitHub boundary rather than on
     * a log line: a refusal the operator can find and the contributor cannot is
     * the half of this that was never the complaint.
     *
     * The body is asserted for the two facts the screen's own hint promises —
     * the limit, and that closing a pull request frees a slot — rather than
     * word for word, so the copy can be edited without this becoming a second
     * place the sentence is written down.
     */
    it('tells a pull request refused by the limit, and builds nothing for it', async () => {
      const { ownerCtx, ownerSession, application, connection } =
        await setUpApplication();
      await request(server)
        .patch(`/applications/${application.applicationId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ previewLimit: 1 });

      await previews.handlePullRequestEvent(connection.githubId, pr(1));
      // Everything from here is the refused pull request's alone: the first one
      // has had its slot, its job and its own comment already.
      octokitMock.rest.issues.createComment.mockClear();
      queueMock.add.mockClear();

      await previews.handlePullRequestEvent(connection.githubId, pr(2));

      expect(octokitMock.rest.issues.createComment).toHaveBeenCalledTimes(1);
      const [comment] = octokitMock.rest.issues.createComment.mock.lastCall as [
        { owner: string; repo: string; issue_number: number; body: string },
      ];
      // On the pull request that was refused, not on the one holding the slot.
      expect(comment.owner).toBe('octabyte-io');
      expect(comment.repo).toBe('cloudgate');
      expect(comment.issue_number).toBe(2);
      expect(comment.body).toContain('refused');
      expect(comment.body).toContain('1 preview at once');
      expect(comment.body).toContain('Closing another pull request frees');

      // And nothing was built: no second row, no second job.
      const rows = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(rows.map((row) => row.pullRequestNumber)).toEqual(['1']);
      expect(queueMock.add).not.toHaveBeenCalled();
    });

    /**
     * The zero case gets its own sentence rather than the plural one with a `0`
     * in it: "closing another pull request frees a slot" is false when the limit
     * is zero, and an operator sent to close pull requests by a comment that
     * cannot help is worse than the silence this replaces.
     */
    it('tells a pull request refused by a limit of zero what would change it', async () => {
      const { ownerSession, application, connection } =
        await setUpApplication();
      await request(server)
        .patch(`/applications/${application.applicationId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ previewLimit: 0 });

      await previews.handlePullRequestEvent(connection.githubId, prOpened);

      const [comment] = octokitMock.rest.issues.createComment.mock.lastCall as [
        { body: string },
      ];
      expect(comment.body).toContain('refused');
      expect(comment.body).toContain('Most previews at once');
      expect(comment.body).not.toContain('frees a slot');
    });

    /**
     * A comment is a network call to somebody else's API, and this one is made
     * inside the webhook's own loop over every previewing Application — so a
     * GitHub outage must cost the refusal's *notice* and not the delivery.
     */
    it('a refusal GitHub would not take still answers the delivery', async () => {
      const { ownerCtx, ownerSession, application, connection } =
        await setUpApplication();
      await request(server)
        .patch(`/applications/${application.applicationId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ previewLimit: 0 });
      octokitMock.rest.issues.createComment.mockRejectedValue(
        new Error('503 Service Unavailable'),
      );

      await expect(
        previews.handlePullRequestEvent(connection.githubId, prOpened),
      ).resolves.toBeUndefined();

      const rows = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(rows).toEqual([]);
    });

    it('a pull request already holding a preview still rebuilds at the cap', async () => {
      const { ownerCtx, ownerSession, application, connection } =
        await setUpApplication();
      await request(server)
        .patch(`/applications/${application.applicationId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ previewLimit: 1 });

      await previews.handlePullRequestEvent(connection.githubId, pr(1));
      const [first] = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      queueMock.add.mockClear();

      // A new commit on the same PR: the cap is full, but this preview
      // already exists, so it redeploys rather than being refused.
      await previews.handlePullRequestEvent(connection.githubId, {
        ...pr(1),
        action: 'synchronize',
      });

      const rows = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].previewDeploymentId).toBe(first.previewDeploymentId);
      expect(queueMock.add).toHaveBeenCalledTimes(1);
    });

    it('closing a preview frees its slot', async () => {
      const { ownerCtx, ownerSession, application, connection } =
        await setUpApplication();
      await request(server)
        .patch(`/applications/${application.applicationId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ previewLimit: 1 });

      await previews.handlePullRequestEvent(connection.githubId, pr(1));
      await previews.handlePullRequestEvent(connection.githubId, {
        ...pr(1),
        action: 'closed',
      });
      await previews.handlePullRequestEvent(connection.githubId, pr(2));

      const rows = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].pullRequestNumber).toBe('2');
    });
  });

  /**
   * The pull-request half. A preview on an Application with no wildcard
   * gets the address of the machine it runs on, and one whose machine has
   * none is refused the way the limit refuses: no row, no build, a
   * comment and a `warn`.
   */
  describe('the host with no preview wildcard', () => {
    /** The Application's wildcard cleared, and optionally a run Server. */
    async function unwildcarded(
      applicationId: string,
      organizationId: string,
      serverIp?: string,
    ) {
      let serverId: string | null = null;
      if (serverIp !== undefined) {
        const [row] = await ctx.db
          .insert(serverTable)
          .values({
            name: 'runner',
            ipAddress: serverIp,
            port: 22,
            organizationId,
          })
          .returning();
        serverId = row.serverId;
      }
      await ctx.db
        .update(applicationTable)
        .set({ previewWildcard: null, serverId })
        .where(eq(applicationTable.applicationId, applicationId));
    }

    it("carries the run Server's address", async () => {
      const { ownerCtx, application, connection, organizationId } =
        await setUpApplication();
      await unwildcarded(
        application.applicationId,
        organizationId,
        '203.0.113.10',
      );

      await previews.handlePullRequestEvent(connection.githubId, prOpened);

      const [row] = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(row.domain).toBe(`${row.appName}-203-0-113-10.sslip.io`);
      expect(queueMock.add).toHaveBeenCalledTimes(1);
    });

    it("carries the platform host's address when there is no Server", async () => {
      const { ownerCtx, application, connection, organizationId } =
        await setUpApplication();
      await unwildcarded(application.applicationId, organizationId);
      await ctx.db
        .insert(webServerSettings)
        .values({ serverIp: '198.51.100.7' });

      await previews.handlePullRequestEvent(connection.githubId, prOpened);

      const [row] = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(row.domain).toMatch(/-198-51-100-7\.sslip\.io$/);
    });

    it('refuses a machine with no address: no row, no build, one comment and a warn', async () => {
      const { ownerCtx, application, connection, organizationId } =
        await setUpApplication();
      await unwildcarded(application.applicationId, organizationId);
      await ctx.db
        .insert(webServerSettings)
        .values({ serverIp: 'console.example.com' });
      const warn = jest.spyOn(Logger.prototype, 'warn');

      try {
        await previews.handlePullRequestEvent(connection.githubId, prOpened);

        expect(
          await previews.findAllByApplicationId(
            ownerCtx,
            application.applicationId,
          ),
        ).toEqual([]);
        expect(queueMock.add).not.toHaveBeenCalled();
        expect(octokitMock.rest.issues.createComment).toHaveBeenCalledTimes(1);
        const [comment] = octokitMock.rest.issues.createComment.mock
          .lastCall as [{ issue_number: number; body: string }];
        expect(comment.issue_number).toBe(42);
        expect(comment.body).toContain('refused');
        expect(comment.body).toContain('preview wildcard');
        expect(comment.body).toContain('public IP');
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining(
            'sets no preview wildcard, so its preview host would carry an IP in its name, and no IP is recorded for this Cloudgate host',
          ),
        );
      } finally {
        warn.mockRestore();
      }
    });

    it("a comment GitHub would not take still leaves the delivery's other Applications their previews", async () => {
      const { ownerCtx, application, connection, organizationId } =
        await setUpApplication();
      // A second Application on the same repository and branch, with a
      // wildcard, created before the first loses its own.
      const second = await applications.create(ownerCtx, {
        name: 'Web App Two',
        appName: 'web-app-two',
        environmentId: application.environmentId,
      });
      await applications.update(ownerCtx, second.applicationId, {
        sourceType: 'github',
        repository: 'cloudgate',
        owner: 'octabyte-io',
        branch: 'main',
        githubId: connection.githubId,
        isPreviewDeploymentsActive: true,
        previewWildcard: '*.preview.example.com',
      });
      await unwildcarded(application.applicationId, organizationId);
      octokitMock.rest.issues.createComment.mockRejectedValue(
        new Error('503 Service Unavailable'),
      );

      await expect(
        previews.handlePullRequestEvent(connection.githubId, prOpened),
      ).resolves.toBeUndefined();

      expect(
        await previews.findAllByApplicationId(
          ownerCtx,
          application.applicationId,
        ),
      ).toEqual([]);
      const [other] = await previews.findAllByApplicationId(
        ownerCtx,
        second.applicationId,
      );
      expect(other.domain).toBe(`${other.appName}.preview.example.com`);
      expect(queueMock.add).toHaveBeenCalledTimes(1);
    });
  });

  describe('preview deploy', () => {
    it('builds under the preview appName and posts the preview URL on the PR', async () => {
      const { ownerCtx, application, connection } = await setUpApplication();
      await previews.handlePullRequestEvent(connection.githubId, prOpened);
      const [preview] = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );

      // As the queue processor would, once the job reaches the worker.
      await previews.deployPreview(preview.previewDeploymentId, {
        title: 'Preview Deployment',
      });

      // The preview converged as its own Swarm service, not production's.
      expect(docker.createService).toHaveBeenCalledTimes(1);
      const [settings] = docker.createService.mock.lastCall as [
        { Name: string },
      ];
      expect(settings.Name).toBe(preview.appName);

      // The PR gets a comment pointing at the preview.
      expect(octokitMock.rest.issues.createComment).toHaveBeenCalledWith({
        owner: 'octabyte-io',
        repo: 'cloudgate',
        issue_number: 42,
        body: expect.stringContaining(`http://${preview.domain}`) as string,
      });

      const [after] = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(after.previewStatus).toBe('done');
    });

    /** Every shell command the deploy ran, joined for substring assertions. */
    const buildCommands = () =>
      execMock.execAsync.mock.calls
        .map(([command]: [string]) => command)
        .join('\n');

    /**
     * Every value the deploy carried in a build environment rather than in the
     * command, joined for substring assertions.
     *
     * A builder emits `KEY"=$CG_BUILD_ENV_n"` and hands the value
     * back out of band, so an assertion that a variable *reached the build* has
     * to read the environment `exec` was called with — the command names only
     * the holder. Filtered to the `CG_BUILD_` holders on purpose: the local
     * branch spreads `process.env` under the carried variables (so a build can
     * still find its `PATH`), and joining all of that would make these
     * assertions answer for the whole machine.
     */
    const buildEnvValues = () =>
      execMock.execAsync.mock.calls
        .flatMap(
          ([, options]: [string, { env?: NodeJS.ProcessEnv } | undefined]) =>
            Object.entries(options?.env ?? {}),
        )
        .filter(([key]) => key.startsWith('CG_BUILD_'))
        .map(([, value]) => value)
        .join('\n');

    it('builds with previewEnv instead of the production variables', async () => {
      const { ownerCtx, ownerSession, application, connection } =
        await setUpApplication();
      await applications.saveEnvironment(ownerCtx, application.applicationId, {
        env: 'DATABASE_URL=production-db-host',
      });
      const patched = await request(server)
        .patch(`/applications/${application.applicationId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ previewEnv: 'DATABASE_URL=staging-db-host' });
      expect(patched.status).toBe(200);

      await previews.handlePullRequestEvent(connection.githubId, prOpened);
      const [preview] = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      execMock.execAsync.mockClear();
      await previews.deployPreview(preview.previewDeploymentId);

      // The variable reaches nixpacks as an `--env` pair whose value the
      // command only names, so the pair is asserted on the command and
      // the value on the environment it ran with.
      const commands = buildCommands();
      expect(commands).toContain('--env DATABASE_URL');
      expect(commands).not.toContain('staging-db-host');
      const carried = buildEnvValues();
      expect(carried).toContain('staging-db-host');
      expect(carried).not.toContain('production-db-host');
    });

    it('builds with previewBuildArgs instead of the production ones', async () => {
      const { ownerCtx, ownerSession, application, connection } =
        await setUpApplication();
      await applications.saveEnvironment(ownerCtx, application.applicationId, {
        buildArgs: 'API_HOST=api.production.example.com',
      });
      const patched = await request(server)
        .patch(`/applications/${application.applicationId}`)
        .set('Cookie', ownerSession.cookie)
        .send({
          buildType: 'dockerfile',
          previewBuildArgs: 'API_HOST=api.staging.example.com',
        });
      expect(patched.status).toBe(200);

      await previews.handlePullRequestEvent(connection.githubId, prOpened);
      const [preview] = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      execMock.execAsync.mockClear();
      await previews.deployPreview(preview.previewDeploymentId);

      const commands = buildCommands();
      expect(commands).toContain('--build-arg API_HOST');
      expect(commands).not.toContain('api.staging.example.com');
      const carried = buildEnvValues();
      expect(carried).toContain('api.staging.example.com');
      expect(carried).not.toContain('api.production.example.com');
    });

    it('injects no OTEL variables into a preview of a traced Application, and starts no Trace store', async () => {
      const { ownerSession, ownerCtx, application, connection } =
        await setUpApplication();
      const traced = await request(server)
        .put(`/traces/${application.applicationId}?serviceType=application`)
        .set('Cookie', ownerSession.cookie)
        .send({ enabled: true });
      expect(traced.status).toBe(200);

      await previews.handlePullRequestEvent(connection.githubId, prOpened);
      const [preview] = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      execMock.execAsync.mockClear();
      docker.createService.mockClear();
      await previews.deployPreview(preview.previewDeploymentId);

      const call = docker.createService.mock.lastCall as unknown[];
      const settings = call[call.length - 1] as {
        Name: string;
        TaskTemplate: { ContainerSpec: { Env: string[] } };
      };
      expect(settings.Name).toBe(preview.appName);
      expect(
        settings.TaskTemplate.ContainerSpec.Env.filter((entry) =>
          entry.startsWith('OTEL_'),
        ),
      ).toEqual([]);
      const commands = execMock.execAsync.mock.calls.map(
        ([command]: [string]) => command,
      );
      expect(
        commands.filter((command) => command.includes('cloudgate-trace-store')),
      ).toEqual([]);
    });

    it('falls back to the production variables when no preview ones are set', async () => {
      const { ownerCtx, application, connection } = await setUpApplication();
      await applications.saveEnvironment(ownerCtx, application.applicationId, {
        env: 'DATABASE_URL=production-db-host',
      });

      await previews.handlePullRequestEvent(connection.githubId, prOpened);
      const [preview] = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      execMock.execAsync.mockClear();
      await previews.deployPreview(preview.previewDeploymentId);

      expect(buildCommands()).toContain('--env DATABASE_URL');
      expect(buildEnvValues()).toContain('production-db-host');
    });

    /**
     * A preview built, ran, and was announced on the pull request with a
     * link that answered `404 page not found`: nothing ever wrote a router for
     * its host, so Traefik matched none. The one host that was advertised was
     * the one host that was never configured.
     *
     * **The file is what is asserted, because it is the whole of the routing.**
     * Traefik's file provider watches `dynamic/`, and an Application's own
     * Domains reach it as `dynamic/{appName}.yml`; a preview owns its
     * `appName` (ADR-0021), so its router lives in `dynamic/{preview.appName}.yml`
     * or nowhere. The expected rule, backend and port are literals rather than
     * anything the generators compute, so the test cannot agree with a wrong
     * generator by construction (§1.7).
     *
     * **And the comment is read at the moment it is posted**, because "ready"
     * before the router exists is the defect restated: the announcement is only
     * honest if the file is already on disk when GitHub is called.
     */
    it('routes the preview host to the preview service before announcing it', async () => {
      const { ownerCtx, application, connection } = await setUpApplication();
      await applications.update(ownerCtx, application.applicationId, {
        previewPort: 8080,
      });
      await previews.handlePullRequestEvent(connection.githubId, prOpened);
      const [preview] = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      const configPath = dynamicTraefikConfigPath(preview.appName, null);
      // Nothing routes a preview that has not been built.
      expect(fs.existsSync(configPath)).toBe(false);

      let routedWhenAnnounced: boolean | undefined;
      octokitMock.rest.issues.createComment.mockImplementation(() => {
        routedWhenAnnounced = fs.existsSync(configPath);
        return Promise.resolve({ data: { id: 777 } });
      });

      await previews.deployPreview(preview.previewDeploymentId);

      const config = parse(fs.readFileSync(configPath, 'utf8')) as FileConfig;
      const routers = Object.values(config.http?.routers ?? {});
      const forHost = routers.filter(
        (router) => router.rule === `Host(\`${preview.domain}\`)`,
      );
      // Plain HTTP is served rather than redirected: the comment links
      // `http://`, and a redirect to a host with no certificate is a warning
      // page, not a preview.
      const web = forHost.find((router) => router.entryPoints?.[0] === 'web');
      expect(web).toBeDefined();
      expect(web?.middlewares ?? []).not.toContain('redirect-to-https');
      // And HTTPS on the same host, terminated with whatever certificate
      // Traefik's store holds for it — a wildcard certificate uploaded for the
      // preview wildcard is picked by SNI with no resolver named here.
      const secure = forHost.find(
        (router) => router.entryPoints?.[0] === 'websecure',
      );
      expect(secure?.tls).toEqual({});
      // Both at the preview's own service, on the preview's own port — not the
      // parent's appName, and not a port the preview settings do not name.
      for (const router of [web, secure]) {
        expect(
          config.http?.services?.[router?.service ?? '']?.loadBalancer?.servers,
        ).toEqual([{ url: `http://${preview.appName}:8080` }]);
      }

      expect(routedWhenAnnounced).toBe(true);
      expect(octokitMock.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining(
            `Preview deployment ready: http://${preview.domain}`,
          ) as string,
        }),
      );
    });

    /**
     * A preview carries its parent's basic-auth users, because a preview builds
     * with production's variables unless `previewEnv` says otherwise —
     * so an Application an operator put behind a password would otherwise be
     * served without one on every pull request's host. The users are the
     * parent's rows, borrowed rather than copied (ADR-0021); the middleware is
     * the preview's own, named by its own `appName`, in its own file.
     */
    it("puts the preview behind its parent's basic-auth users", async () => {
      const { ownerCtx, application, connection } = await setUpApplication();
      await basicAuth.create(ownerCtx, {
        applicationId: application.applicationId,
        username: 'reviewer',
        password: 'preview-password',
      });
      await previews.handlePullRequestEvent(connection.githubId, prOpened);
      const [preview] = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );

      await previews.deployPreview(preview.previewDeploymentId);

      const config = parse(
        fs.readFileSync(
          dynamicTraefikConfigPath(preview.appName, null),
          'utf8',
        ),
      ) as FileConfig;
      const middlewareName = `auth-${preview.appName}`;
      for (const router of Object.values(config.http?.routers ?? {})) {
        expect(router.middlewares).toContain(middlewareName);
      }
      const middleware = config.http?.middlewares?.[middlewareName] as {
        basicAuth: { users: string[] };
      };
      expect(middleware.basicAuth.users).toHaveLength(1);
      expect(middleware.basicAuth.users[0]).toMatch(/^reviewer:\$2[aby]\$/);
      // The password itself is never written; only its bcrypt hash is.
      expect(JSON.stringify(config)).not.toContain('preview-password');
    });

    /**
     * The other half of the third criterion: a preview that built but could
     * not be routed says so, rather than being announced at a host that will
     * answer 404. The host is made unroutable the way a real row can be — a
     * value stored before `previewWildcard` was held to a hostname (H-41)
     * — and the guard that refuses it is the emitter's, so a backtick never
     * reaches a `Host()` rule.
     */
    it('a preview that builds but cannot be routed says so instead of ready', async () => {
      const { ownerCtx, application, connection } = await setUpApplication();
      await previews.handlePullRequestEvent(connection.githubId, prOpened);
      const [preview] = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      const injected = 'x.example.com`) || Host(`victim.example.com';
      await ctx.db
        .update(previewDeployment)
        .set({ domain: injected })
        .where(
          eq(
            previewDeployment.previewDeploymentId,
            preview.previewDeploymentId,
          ),
        );

      await expect(
        previews.deployPreview(preview.previewDeploymentId),
      ).rejects.toThrow();

      // It did build and converge — this is the routing failing, not the build.
      expect(docker.createService).toHaveBeenCalledTimes(1);
      expect(
        fs.existsSync(dynamicTraefikConfigPath(preview.appName, null)),
      ).toBe(false);
      const bodies = octokitMock.rest.issues.createComment.mock.calls.map(
        ([args]: [{ body: string }]) => args.body,
      );
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toContain('could not be routed');
      // Not announced as ready, and not reported as a failed build either.
      expect(bodies[0]).not.toContain('ready');
      expect(bodies[0]).not.toContain('deployment logs');
      const [after] = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(after.previewStatus).toBe('error');
    });

    it('a failed build marks the preview errored and reports it on the PR', async () => {
      const { ownerCtx, application, connection } = await setUpApplication();
      await previews.handlePullRequestEvent(connection.githubId, prOpened);
      const [preview] = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      execMock.execAsync.mockRejectedValue(new Error('clone failed'));

      await expect(
        previews.deployPreview(preview.previewDeploymentId, {
          title: 'Preview Deployment',
        }),
      ).rejects.toThrow('clone failed');

      expect(octokitMock.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          issue_number: 42,
          body: expect.stringContaining('failed') as string,
        }),
      );
      const [after] = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(after.previewStatus).toBe('error');
    });
  });

  /**
   * Every preview build is a Deployment of its parent
   * Application from the moment it is queued: a `pending` row naming the
   * preview through `deployment.preview_deployment_id`, which the job carries
   * and the build fills. `queueHoldsWhatWasAdded` makes the queue double stand
   * in for the in-memory queue, so a job `add`ed is a job `getJobs` answers as
   * waiting.
   */
  describe('preview builds are Deployments of the parent', () => {
    function queueHoldsWhatWasAdded() {
      queueMock.add.mockImplementation(() =>
        Promise.resolve({ id: `job-${queueMock.add.mock.calls.length}` }),
      );
      queueMock.getJobs.mockImplementation(() =>
        Promise.resolve(
          (queueMock.add.mock.calls as [DeploymentJob][]).map(
            ([data], index) => ({
              id: `job-${index + 1}`,
              state: 'waiting',
              data,
            }),
          ),
        ),
      );
    }

    const rowsOf = (applicationId: string) =>
      ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.applicationId, applicationId));

    async function openPreview() {
      const setUp = await setUpApplication();
      await previews.handlePullRequestEvent(
        setUp.connection.githubId,
        prOpened,
      );
      const [preview] = await previews.findAllByApplicationId(
        setUp.ownerCtx,
        setUp.application.applicationId,
      );
      return { ...setUp, preview };
    }

    it('queuing a pull-request preview build leaves a pending Deployment of the parent carrying the preview id', async () => {
      const { application, preview } = await openPreview();

      const rows = await rowsOf(application.applicationId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        applicationId: application.applicationId,
        previewDeploymentId: preview.previewDeploymentId,
        status: 'pending',
        title: 'Preview Deployment',
        description: 'Pull request #42',
      });
      expect(queueMock.add).toHaveBeenCalledWith({
        applicationType: 'application-preview',
        applicationId: application.applicationId,
        previewDeploymentId: preview.previewDeploymentId,
        deploymentId: rows[0].deploymentId,
        title: 'Preview Deployment',
        description: 'Pull request #42',
        type: 'deploy',
        serverId: null,
      });
    });

    it('a queued preview build can be cancelled before it starts', async () => {
      queueHoldsWhatWasAdded();
      const { ownerCtx, application } = await openPreview();
      const [queued] = await rowsOf(application.applicationId);
      queueMock.cancel.mockResolvedValue(true);

      const cancelled = await deployments.cancel(ownerCtx, queued.deploymentId);

      expect(cancelled).toMatchObject({
        deploymentId: queued.deploymentId,
        status: 'cancelled',
      });
      expect(queueMock.cancel).toHaveBeenCalledWith('job-1');
    });

    it('the build fills the row it was queued under rather than recording its own', async () => {
      const { application, preview } = await openPreview();
      const [queued] = await rowsOf(application.applicationId);

      await previews.deployPreview(preview.previewDeploymentId, {
        title: queued.title,
        description: queued.description ?? '',
        deploymentId: queued.deploymentId,
      });

      const rows = await rowsOf(application.applicationId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        deploymentId: queued.deploymentId,
        previewDeploymentId: preview.previewDeploymentId,
        status: 'done',
      });
    });

    it('the link column refuses a preview id whose preview belongs to a different Application', async () => {
      const { ownerCtx, application, preview } = await openPreview();
      const other = await applications.create(ownerCtx, {
        name: 'Other App',
        appName: 'other-app',
        environmentId: application.environmentId,
      });

      await expect(
        ctx.db.insert(deployment).values({
          applicationId: other.applicationId,
          previewDeploymentId: preview.previewDeploymentId,
          title: 'Forged',
          logPath: '/tmp/forged.log',
        }),
      ).rejects.toThrow();
      // Nor may it qualify a row with no Application at all.
      await expect(
        ctx.db.insert(deployment).values({
          previewDeploymentId: preview.previewDeploymentId,
          title: 'Parentless',
          logPath: '/tmp/parentless.log',
        }),
      ).rejects.toThrow();
      // Its own parent is the one Application it may qualify.
      await expect(
        ctx.db.insert(deployment).values({
          applicationId: application.applicationId,
          previewDeploymentId: preview.previewDeploymentId,
          title: 'Genuine',
          logPath: '/tmp/genuine.log',
        }),
      ).resolves.toBeDefined();
    });

    it("deleting the preview leaves its Deployment rows in the parent's history with the link nulled", async () => {
      const { ownerCtx, application, preview } = await openPreview();
      const [queued] = await rowsOf(application.applicationId);

      await previews.remove(ownerCtx, preview.previewDeploymentId);

      expect(await rowsOf(application.applicationId)).toEqual([
        expect.objectContaining({
          deploymentId: queued.deploymentId,
          applicationId: application.applicationId,
          previewDeploymentId: null,
        }),
      ]);
    });

    it('POST /preview-deployments/:id/redeploy answers 201 with the queued Deployment', async () => {
      const { ownerSession, application, preview } = await openPreview();

      const res = await request(server)
        .post(`/preview-deployments/${preview.previewDeploymentId}/redeploy`)
        .set('Cookie', ownerSession.cookie)
        .send({});

      expect(res.status).toBe(201);
      const body = res.body as { deploymentId: string };
      expect(body).toMatchObject({
        applicationId: application.applicationId,
        previewDeploymentId: preview.previewDeploymentId,
        status: 'pending',
        title: 'Rebuild Preview Deployment',
        description: 'Pull request #42',
      });
      expect(queueMock.add).toHaveBeenLastCalledWith(
        expect.objectContaining({
          applicationType: 'application-preview',
          deploymentId: body.deploymentId,
          type: 'redeploy',
        }),
      );
    });

    it('a second redeploy of the same preview while its build is pending coalesces onto it', async () => {
      queueHoldsWhatWasAdded();
      const { ownerCtx, application, preview } = await openPreview();
      const [queued] = await rowsOf(application.applicationId);

      const again = await previews.redeploy(
        ownerCtx,
        preview.previewDeploymentId,
      );

      expect(again.deploymentId).toBe(queued.deploymentId);
      expect(queueMock.add).toHaveBeenCalledTimes(1);
      expect(await rowsOf(application.applicationId)).toHaveLength(1);
    });

    it("a preview redeploy does not coalesce onto a pending production deploy, nor onto another preview's build", async () => {
      queueHoldsWhatWasAdded();
      const { ownerCtx, application, connection, preview } =
        await openPreview();
      // The pull request's own build has started; production and a second
      // pull request's preview are both queued behind it in the one group.
      await ctx.db
        .update(deployment)
        .set({ status: 'running' })
        .where(eq(deployment.previewDeploymentId, preview.previewDeploymentId));
      const production = await deployments.deploy(
        ownerCtx,
        application.applicationId,
      );
      await previews.handlePullRequestEvent(connection.githubId, {
        ...prOpened,
        pullRequestId: '990002',
        pullRequestNumber: '43',
      });
      const addedBefore = queueMock.add.mock.calls.length;

      const redeployed = await previews.redeploy(
        ownerCtx,
        preview.previewDeploymentId,
      );

      expect(redeployed.deploymentId).not.toBe(production.deploymentId);
      expect(redeployed).toMatchObject({
        previewDeploymentId: preview.previewDeploymentId,
        status: 'pending',
      });
      expect(queueMock.add).toHaveBeenCalledTimes(addedBefore + 1);
    });
  });

  describe('pull request closed', () => {
    it('tears down the preview service and deletes its row', async () => {
      const { ownerCtx, application, connection } = await setUpApplication();
      await previews.handlePullRequestEvent(connection.githubId, prOpened);
      const [preview] = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );

      await previews.handlePullRequestEvent(connection.githubId, {
        ...prOpened,
        action: 'closed',
      });

      const rows = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(rows).toEqual([]);
      // The Swarm service is removed and the cloned code cleaned up — as argv
      // since H-34, so the appName is one element rather than a word in a
      // string the local shell would re-parse.
      const argvs = execMock.execFileAsync.mock.calls.map(
        ([program, args]: [string, string[]]) => [program, ...args],
      );
      expect(argvs).toContainEqual([
        'docker',
        'service',
        'rm',
        preview.appName,
      ]);
      expect(
        argvs.some(
          (argv: string[]) =>
            argv[0] === 'rm' &&
            argv.includes('-rf') &&
            argv.some((word) => word.includes(preview.appName)),
        ),
      ).toBe(true);
    });

    /**
     * The second criterion: the router a build wrote goes when the pull
     * request closes, so a closed pull request's host stops being advertised
     * at a service that no longer exists. Built first, so there is a file to
     * remove — a teardown of a preview that never routed proves nothing.
     */
    it('removes the preview host routing when the pull request closes', async () => {
      const { ownerCtx, application, connection } = await setUpApplication();
      await previews.handlePullRequestEvent(connection.githubId, prOpened);
      const [preview] = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      await previews.deployPreview(preview.previewDeploymentId);
      const configPath = dynamicTraefikConfigPath(preview.appName, null);
      expect(fs.existsSync(configPath)).toBe(true);

      await previews.handlePullRequestEvent(connection.githubId, {
        ...prOpened,
        action: 'closed',
      });

      expect(fs.existsSync(configPath)).toBe(false);
    });

    it('removes the preview host routing when the preview is torn down by hand', async () => {
      const { ownerCtx, application, connection } = await setUpApplication();
      await previews.handlePullRequestEvent(connection.githubId, prOpened);
      const [preview] = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      await previews.deployPreview(preview.previewDeploymentId);
      const configPath = dynamicTraefikConfigPath(preview.appName, null);
      expect(fs.existsSync(configPath)).toBe(true);

      await previews.remove(ownerCtx, preview.previewDeploymentId);

      expect(fs.existsSync(configPath)).toBe(false);
    });

    /**
     * On the path the button does not reach. `PreviewDeploymentsService.
     * teardown` is shared by both, but this is the one that runs unattended —
     * a repository with a normal flow of pull requests grew by 242 MB per
     * preview with nobody pressing anything — so the automatic path is pinned
     * as well as the one `preview-deployments.service.spec.ts` covers.
     *
     * The assertion is *no image tagged with the preview's appName is left*,
     * stated as the removal that was sent, because a mocked daemon has no image
     * list to read back.
     */
    it('removes the image the preview built when the pull request closes', async () => {
      const { ownerCtx, application, connection } = await setUpApplication();
      await previews.handlePullRequestEvent(connection.githubId, prOpened);
      const [preview] = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );

      await previews.handlePullRequestEvent(connection.githubId, {
        ...prOpened,
        action: 'closed',
      });

      const argvs = execMock.execFileAsync.mock.calls.map(
        ([program, args]: [string, string[]]) => [program, ...args],
      );
      expect(argvs).toContainEqual([
        'docker',
        'image',
        'rm',
        `${preview.appName}:latest`,
        '--force',
      ]);
    });
  });

  /**
   * A preview's builds stop before its teardown runs, so a pull request
   * that closes mid-build no longer leaks the container a release was still
   * creating. The queue double is a small model of the in-memory queue —
   * waiting jobs can be taken back out, an active one cannot — because what is
   * under test is which of the preview's builds teardown can stop and which it
   * has to wait out.
   */
  describe('teardown stops the preview’s builds first', () => {
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
        /** A worker takes the job: it is active until {@link finish}. */
        start(job: QueuedJob) {
          job.state = 'active';
        },
        finish(job: QueuedJob) {
          jobs.splice(jobs.indexOf(job), 1);
        },
      };
    }

    const sign = (secret: string, payload: object) =>
      `sha256=${createHmac('sha256', secret)
        .update(JSON.stringify(payload))
        .digest('hex')}`;

    /** GitHub's delivery for {@link prOpened} closing. */
    const prClosedPayload = {
      action: 'closed',
      installation: { id: 99887766 },
      repository: { name: 'cloudgate', owner: { login: 'octabyte-io' } },
      pull_request: {
        id: 990001,
        number: 42,
        title: 'Add health endpoint',
        html_url: 'https://github.com/example-org/shop/pull/42',
        head: { ref: 'feature/health' },
        base: { ref: 'main' },
        user: { login: 'octocat' },
      },
    };

    const rowOf = async (deploymentId: string) => {
      const [row] = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.deploymentId, deploymentId));
      return row;
    };

    /** Every `docker service rm` teardown sent, by its call order. */
    const serviceRemovals = () =>
      execMock.execFileAsync.mock.calls
        .map(([program, args]: [string, string[]], index: number) => ({
          argv: [program, ...args],
          order: execMock.execFileAsync.mock.invocationCallOrder[index],
        }))
        .filter(({ argv }) => argv.join(' ').startsWith('docker service rm'));

    async function openPreview() {
      const setUp = await setUpApplication();
      await previews.handlePullRequestEvent(
        setUp.connection.githubId,
        prOpened,
      );
      const [preview] = await previews.findAllByApplicationId(
        setUp.ownerCtx,
        setUp.application.applicationId,
      );
      const [queued] = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.previewDeploymentId, preview.previewDeploymentId));
      return { ...setUp, preview, queued };
    }

    const until = async (condition: () => boolean) => {
      for (let i = 0; i < 200 && !condition(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(condition()).toBe(true);
    };

    it('closing a pull request with its build pending cancels that build, then tears down, and writes no audit rows', async () => {
      const queue = modelQueue();
      const { preview, queued } = await openPreview();
      expect(queue.jobs).toHaveLength(1);
      // Signing up audited a login; the delivery must add nothing to it.
      const auditedBefore = await ctx.db.select().from(auditLog);

      const res = await request(server)
        .post('/github/webhook')
        .set('x-github-event', 'pull_request')
        .set('x-hub-signature-256', sign('wh-secret', prClosedPayload))
        .send(prClosedPayload);

      expect(res.status).toBe(200);
      expect(await rowOf(queued.deploymentId)).toMatchObject({
        status: 'cancelled',
        // The preview is gone, so the link is nulled.
        previewDeploymentId: null,
      });
      expect(queue.jobs).toEqual([]);
      const removals = serviceRemovals();
      expect(removals).toEqual([
        expect.objectContaining({
          argv: ['docker', 'service', 'rm', preview.appName],
        }),
      ]);
      // Cancelled first, torn down after.
      expect(queueMock.cancel.mock.invocationCallOrder[0]).toBeLessThan(
        removals[0].order,
      );
      expect(await ctx.db.select().from(previewDeployment)).toEqual([]);
      // A pull-request preview's teardown is the platform's, as it always
      // was: no caller, so nothing is audited.
      expect(await ctx.db.select().from(auditLog)).toEqual(auditedBefore);
    });

    it('closing a pull request with its build inside its cancel window kills the build, then tears down', async () => {
      const queue = modelQueue();
      const { application, preview, queued } = await openPreview();
      const [job] = queue.jobs;
      queue.start(job);
      // The engine claims the row and opens the window.
      const record = await deployments.create({
        kind: 'application',
        applicationId: application.applicationId,
        title: queued.title,
        description: queued.description ?? '',
        deploymentId: queued.deploymentId,
      });
      if (!record) throw new Error('the build did not claim its row');
      // The killed build unwinds and its job leaves the queue.
      record.cancelled.addEventListener('abort', () => queue.finish(job));

      await previews.handlePullRequestEvent(application.githubId ?? '', {
        ...prOpened,
        action: 'closed',
      });

      expect(record.cancelled.aborted).toBe(true);
      expect(await rowOf(queued.deploymentId)).toMatchObject({
        status: 'cancelled',
      });
      expect(serviceRemovals()).toEqual([
        expect.objectContaining({
          argv: ['docker', 'service', 'rm', preview.appName],
        }),
      ]);
    });

    /**
     * The wait for a release past its window is off the request: GitHub gives
     * up on a delivery after ten seconds and the proxy on a `DELETE` after
     * 240, and a release can take minutes. So both answer while the build is
     * still releasing, and the teardown still runs after it ends.
     */
    it.each([
      {
        how: 'closing its pull request',
        // The webhook audits nothing, as it never did.
        audited: 0,
        send: () =>
          request(server)
            .post('/github/webhook')
            .set('x-github-event', 'pull_request')
            .set('x-hub-signature-256', sign('wh-secret', prClosedPayload))
            .send(prClosedPayload),
      },
      {
        how: 'deleting it',
        // The caller's own row, and nothing for the wait.
        audited: 1,
        send: (cookie: string, previewDeploymentId: string) =>
          request(server)
            .delete(`/preview-deployments/${previewDeploymentId}`)
            .set('Cookie', cookie),
      },
    ])(
      '$how with its build past its cancel window answers at once and tears down only after that build ends, leaving no service or router',
      async ({ audited, send }) => {
        const queue = modelQueue();
        const { ownerSession, preview, queued } = await openPreview();
        const [job] = queue.jobs;
        queue.start(job);
        // The release is in flight: the Swarm service is being created, which
        // is past the window a cancel can reach.
        let release: () => void = () => undefined;
        docker.createService.mockImplementation(
          () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        );
        const build = previews
          .deployPreview(preview.previewDeploymentId, {
            title: queued.title,
            description: queued.description ?? '',
            deploymentId: queued.deploymentId,
          })
          .finally(() => queue.finish(job));
        await until(() => docker.createService.mock.calls.length === 1);
        const auditedBefore = await ctx.db.select().from(auditLog);

        const res = await send(
          ownerSession.cookie,
          preview.previewDeploymentId,
        );

        // Answered while the release is still held open.
        expect(res.status).toBe(200);
        // Long enough for the wait to have looked twice.
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        expect(serviceRemovals()).toEqual([]);
        expect(await rowOf(queued.deploymentId)).toMatchObject({
          status: 'running',
        });
        expect(await ctx.db.select().from(previewDeployment)).toHaveLength(1);

        release();
        await build;
        const previewsLeft = async () =>
          (await ctx.db.select().from(previewDeployment)).length;
        for (let i = 0; i < 200 && (await previewsLeft()) > 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }

        expect(await rowOf(queued.deploymentId)).toMatchObject({
          status: 'done',
        });
        const removals = serviceRemovals();
        expect(removals).toHaveLength(1);
        expect(docker.createService.mock.invocationCallOrder[0]).toBeLessThan(
          removals[0].order,
        );
        // The router the finished build wrote went with the teardown after it.
        expect(
          fs.existsSync(dynamicTraefikConfigPath(preview.appName, null)),
        ).toBe(false);
        expect(await previewsLeft()).toBe(0);
        expect(
          (await ctx.db.select().from(auditLog)).length - auditedBefore.length,
        ).toBe(audited);
      },
    );

    it('never cancels a production build of the same parent', async () => {
      const queue = modelQueue();
      const { ownerCtx, application, queued } = await openPreview();
      const production = await deployments.deploy(
        ownerCtx,
        application.applicationId,
      );
      const productionJob = queue.jobs.find(
        (job) => job.data.applicationType === 'application',
      );
      expect(productionJob).toBeDefined();

      await previews.handlePullRequestEvent(application.githubId ?? '', {
        ...prOpened,
        action: 'closed',
      });

      expect(await rowOf(queued.deploymentId)).toMatchObject({
        status: 'cancelled',
      });
      expect(await rowOf(production.deploymentId)).toMatchObject({
        status: 'pending',
      });
      expect(queue.jobs).toEqual([productionJob]);
    });
  });

  describe('row-level access', () => {
    /** Opens one preview as the owner and hands back both ctxs. */
    async function setUpPreview() {
      const {
        ownerSession,
        organizationId,
        ownerCtx,
        application,
        connection,
      } = await setUpApplication();
      await previews.handlePullRequestEvent(connection.githubId, prOpened);
      const [preview] = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      queueMock.add.mockClear();
      execMock.execAsync.mockClear();
      return { ownerSession, organizationId, ownerCtx, application, preview };
    }

    it('a member without a row-level grant can neither list, redeploy, nor remove', async () => {
      const { ownerSession, organizationId, ownerCtx, application, preview } =
        await setUpPreview();
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );
      const inviteeCtx = permissionCtx(invitee.id, organizationId);

      await expect(
        previews.findAllByApplicationId(inviteeCtx, application.applicationId),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        previews.redeploy(inviteeCtx, preview.previewDeploymentId),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        previews.remove(inviteeCtx, preview.previewDeploymentId),
      ).rejects.toThrow(ForbiddenException);

      // Nothing was enqueued and nothing was torn down.
      expect(queueMock.add).not.toHaveBeenCalled();
      expect(execMock.execAsync).not.toHaveBeenCalled();
      const rows = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(rows).toHaveLength(1);
    });

    it('previews are invisible outside their own organization', async () => {
      const { ownerSession, application, preview } = await setUpPreview();

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgId = (secondOrg.body as { id: string }).id;
      const secondOrgCtx = permissionCtx(ownerSession.id, secondOrgId);

      // Same user, but acting in the second organization: the preview from
      // the first organization must not resolve, even for its creator.
      await expect(
        previews.findAllByApplicationId(
          secondOrgCtx,
          application.applicationId,
        ),
      ).rejects.toThrow(NotFoundException);
      await expect(
        previews.redeploy(secondOrgCtx, preview.previewDeploymentId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        previews.remove(secondOrgCtx, preview.previewDeploymentId),
      ).rejects.toThrow(NotFoundException);
      expect(queueMock.add).not.toHaveBeenCalled();
      expect(execMock.execAsync).not.toHaveBeenCalled();
    });
  });

  describe('HTTP endpoint surface', () => {
    it('lists, fetches, redeploys, and deletes over HTTP', async () => {
      const { ownerSession, application, connection } =
        await setUpApplication();
      await previews.handlePullRequestEvent(connection.githubId, prOpened);
      queueMock.add.mockClear();
      const cookie = ownerSession.cookie;

      const list = await request(server)
        .get(`/applications/${application.applicationId}/preview-deployments`)
        .set('Cookie', cookie);
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(1);
      const { previewDeploymentId } = (
        list.body as { previewDeploymentId: string }[]
      )[0];

      const one = await request(server)
        .get(`/preview-deployments/${previewDeploymentId}`)
        .set('Cookie', cookie);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({
        previewDeploymentId,
        pullRequestNumber: '42',
      });

      const redeployed = await request(server)
        .post(`/preview-deployments/${previewDeploymentId}/redeploy`)
        .set('Cookie', cookie)
        .send({ title: 'Rebuild' });
      // The pull request's build is still waiting under a queue double that
      // holds nothing, so the rebuild queues its own.
      expect(redeployed.status).toBe(201);
      expect(queueMock.add).toHaveBeenCalledTimes(1);
      expect(queueMock.add).toHaveBeenCalledWith(
        expect.objectContaining({
          applicationType: 'application-preview',
          previewDeploymentId,
          type: 'redeploy',
        }),
      );

      const removed = await request(server)
        .delete(`/preview-deployments/${previewDeploymentId}`)
        .set('Cookie', cookie);
      expect(removed.status).toBe(200);
      const emptied = await request(server)
        .get(`/applications/${application.applicationId}/preview-deployments`)
        .set('Cookie', cookie);
      expect(emptied.body).toEqual([]);
    });

    it('a member without a row-level grant gets 403 over HTTP', async () => {
      const { ownerSession, ownerCtx, application, connection } =
        await setUpApplication();
      await previews.handlePullRequestEvent(connection.githubId, prOpened);
      const [preview] = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );

      const denied = await request(server)
        .post(`/preview-deployments/${preview.previewDeploymentId}/redeploy`)
        .set('Cookie', invitee.cookie)
        .send({});
      expect(denied.status).toBe(403);
    });
  });

  describe('github webhook wiring', () => {
    /** Signs the payload exactly as GitHub does. */
    const sign = (secret: string, payload: object) =>
      `sha256=${createHmac('sha256', secret)
        .update(JSON.stringify(payload))
        .digest('hex')}`;

    // GitHub's pull_request delivery, trimmed to the fields we read.
    const prPayload = {
      action: 'opened',
      installation: { id: 99887766 },
      repository: { name: 'cloudgate', owner: { login: 'octabyte-io' } },
      pull_request: {
        id: 990001,
        number: 42,
        title: 'Add health endpoint',
        html_url: 'https://github.com/example-org/shop/pull/42',
        head: { ref: 'feature/health' },
        base: { ref: 'main' },
        user: { login: 'octocat' },
      },
    };

    it('a signed pull_request delivery creates the preview and enqueues a deploy', async () => {
      const { ownerCtx, application } = await setUpApplication();

      const res = await request(server)
        .post('/github/webhook')
        .set('x-github-event', 'pull_request')
        .set('x-hub-signature-256', sign('wh-secret', prPayload))
        .send(prPayload);

      expect(res.status).toBe(200);
      const rows = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        pullRequestId: '990001',
        pullRequestNumber: '42',
        branch: 'feature/health',
      });
      expect(queueMock.add).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * The printed link: `https://` only where a stored certificate covers
   * the host, derived on every read and never stored, and the same rule for
   * the read answer and the pull-request comment. Serving does not move.
   */
  describe('printed link', () => {
    /** The `*.preview.example.com` wildcard, stored on the platform host. */
    async function uploadWildcard(organizationId: string) {
      await ctx.db.insert(certificate).values({
        name: 'Preview wildcard',
        certificateData: WILDCARD_PREVIEW_EXAMPLE_COM_PEM,
        privateKey:
          '-----BEGIN PRIVATE KEY-----\nnot-read-here\n-----END PRIVATE KEY-----\n',
        organizationId,
        serverId: null,
      });
    }

    it('reads http:// with a urlNote when no certificate covers the host', async () => {
      const { ownerSession, application, connection } =
        await setUpApplication();
      await previews.handlePullRequestEvent(connection.githubId, prOpened);

      const list = await request(server)
        .get(`/applications/${application.applicationId}/preview-deployments`)
        .set('Cookie', ownerSession.cookie);
      const [listed] = list.body as {
        domain: string;
        previewDeploymentId: string;
      }[];
      expect(listed).toMatchObject({
        url: `http://${listed.domain}`,
        urlNote:
          'No unexpired certificate stored for the machine this preview runs on covers *.preview.example.com, so its link is http://.',
      });

      const one = await request(server)
        .get(`/preview-deployments/${listed.previewDeploymentId}`)
        .set('Cookie', ownerSession.cookie);
      expect(one.body).toMatchObject({
        url: `http://${listed.domain}`,
        urlNote: expect.any(String) as string,
      });
    });

    it('flips an existing preview to https:// once a covering wildcard is uploaded, without touching its row', async () => {
      const { organizationId, ownerSession, application, connection } =
        await setUpApplication();
      await previews.handlePullRequestEvent(connection.githubId, prOpened);
      const rowBefore = await ctx.db.select().from(previewDeployment);

      await uploadWildcard(organizationId);

      const list = await request(server)
        .get(`/applications/${application.applicationId}/preview-deployments`)
        .set('Cookie', ownerSession.cookie);
      const [listed] = list.body as Record<string, unknown>[];
      expect(listed.url).toBe(`https://${String(listed.domain)}`);
      expect(listed).not.toHaveProperty('urlNote');
      const one = await request(server)
        .get(`/preview-deployments/${String(listed.previewDeploymentId)}`)
        .set('Cookie', ownerSession.cookie);
      expect(one.body).toMatchObject({ url: listed.url });
      expect(one.body).not.toHaveProperty('urlNote');

      expect(await ctx.db.select().from(previewDeployment)).toEqual(rowBefore);
    });

    it('announces the same scheme on the pull request, and routes the preview byte-for-byte as without a certificate', async () => {
      const { organizationId, ownerCtx, application, connection } =
        await setUpApplication();
      await previews.handlePullRequestEvent(connection.githubId, prOpened);
      const [preview] = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      const configPath = dynamicTraefikConfigPath(preview.appName, null);

      await previews.deployPreview(preview.previewDeploymentId);
      const uncovered = fs.readFileSync(configPath, 'utf8');
      expect(octokitMock.rest.issues.createComment).toHaveBeenLastCalledWith(
        expect.objectContaining({
          body: expect.stringContaining(
            `Preview deployment ready: http://${preview.domain}`,
          ) as string,
        }),
      );

      await uploadWildcard(organizationId);
      await previews.deployPreview(preview.previewDeploymentId);
      const covered = fs.readFileSync(configPath, 'utf8');
      expect(octokitMock.rest.issues.createComment).toHaveBeenLastCalledWith(
        expect.objectContaining({
          body: expect.stringContaining(
            `Preview deployment ready: https://${preview.domain}`,
          ) as string,
        }),
      );
      const [read] = await previews.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(read.url).toBe(`https://${preview.domain}`);

      // Serving is not the printed link's business: both routers, `tls: {}`,
      // no redirect — the same bytes whether or not a certificate covers the
      // host, and the bytes `traefik/config/preview.ts` wrote before the fix.
      expect(covered).toBe(uncovered);
      expect(uncovered).toBe(
        PINNED_PREVIEW_CONFIG.replaceAll('APP', preview.appName).replaceAll(
          'HOST',
          preview.domain,
        ),
      );
    });
  });
});
