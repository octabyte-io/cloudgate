import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { application as applicationTable } from '../../src/applications/application.schema';
import { ApplicationsService } from '../../src/applications/applications.service';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import { deployment } from '../../src/deployments/deployment.schema';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { GithubService } from '../../src/git-providers/strategies/github/github.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { freezeOrganization } from '../utils/frozen-organization';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/** Polls until the condition holds (the queue processes in the background). */
async function waitFor(condition: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Signs the payload exactly as GitHub does; the scheme itself is pinned
// against an openssl-computed literal in github-webhook.util.spec.ts.
const sign = (secret: string, payload: object) =>
  `sha256=${createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex')}`;

const connection = {
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

const PUSHED_SHA = '9f1c2e4b7a3d5f60182736455463728190abcdef';

/** A trimmed but real-shaped `push` delivery for octabyte-io/cloudgate. */
const pushTo = (branch: string, extra: object = {}) => ({
  ref: `refs/heads/${branch}`,
  after: PUSHED_SHA,
  deleted: false,
  installation: { id: 99887766 },
  repository: {
    name: 'cloudgate',
    owner: { name: 'octabyte-io', login: 'octabyte-io' },
  },
  pusher: { name: 'grace' },
  head_commit: {
    id: PUSHED_SHA,
    message: 'feat: version 1.1.0\n\nBumps the version string.',
  },
  ...extra,
});

/**
 * A signed `push` from a connected GitHub App deploys every Application
 * on that connection, repository and branch whose Deploy automatically is on —
 * and nothing else. The deployment engine is the boundary (building is the
 * engine's tested territory), so what is asserted is the Deployment row the
 * push records and the job that reaches the engine.
 */
describe('GitHub push deploys (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;

  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  };
  const engineMock = { deploy: jest.fn() };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: DeploymentEngineService, useValue: engineMock },
      ],
    });
    server = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    execMock.execAsync
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '' });
    execMock.execAsyncRemote
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '' });
    engineMock.deploy.mockReset().mockResolvedValue(undefined);
  });

  /** An owner, a connected GitHub App, and an environment to put apps in. */
  async function setUp() {
    const signUp = await request(server).post('/api/auth/sign-up/email').send({
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
    });
    expect(signUp.status).toBe(200);
    const userId = (signUp.body as { user: { id: string } }).user.id;
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', signUp.headers['set-cookie']);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = {
      user: { id: userId },
      session: { activeOrganizationId: organizationId },
    };

    const github = ctx.app.get(GithubService);
    const connected = await github.create(ownerCtx, connection);
    const other = await github.create(ownerCtx, {
      ...connection,
      name: 'Other GitHub',
      installationId: '11223344',
    });

    const project = await ctx.app
      .get(ProjectsService)
      .create(ownerCtx, { name: 'cloudgate' });
    const environment = await ctx.app
      .get(EnvironmentsService)
      .create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
      });

    /** A GitHub-sourced Application on octabyte-io/cloudgate. */
    async function githubApp(
      appName: string,
      source: Partial<typeof applicationTable.$inferInsert>,
    ) {
      const created = await ctx.app.get(ApplicationsService).create(ownerCtx, {
        name: appName,
        appName,
        environmentId: environment.environmentId,
      });
      await ctx.db
        .update(applicationTable)
        .set({
          sourceType: 'github',
          githubId: connected.githubId,
          owner: 'octabyte-io',
          repository: 'cloudgate',
          branch: 'main',
          ...source,
        })
        .where(eq(applicationTable.applicationId, created.applicationId));
      return created.applicationId;
    }

    return { githubApp, otherGithubId: other.githubId, organizationId };
  }

  async function deploymentsOf(applicationId: string) {
    return ctx.db
      .select()
      .from(deployment)
      .where(eq(deployment.applicationId, applicationId));
  }

  function deliver(payload: object) {
    return request(server)
      .post('/github/webhook')
      .set('x-github-event', 'push')
      .set('x-hub-signature-256', sign('wh-secret', payload))
      .send(payload);
  }

  it('a push to the configured branch deploys the pushed commit, and records that a push triggered it', async () => {
    const { githubApp } = await setUp();
    const web = await githubApp('web', {});

    const res = await deliver(pushTo('main'));

    expect(res.status).toBe(200);
    const rows = await deploymentsOf(web);
    expect(rows).toHaveLength(1);
    // Told apart from a "Manual deployment" by its title, and traceable to
    // the push by the commit, branch and pusher it names.
    expect(rows[0].title).toBe('Automatic deployment');
    expect(rows[0].description).toBe(
      `Push to main by grace · ${PUSHED_SHA} · feat: version 1.1.0`,
    );

    await waitFor(() => engineMock.deploy.mock.calls.length > 0);
    expect(engineMock.deploy).toHaveBeenCalledTimes(1);
    const [deployable, meta] = engineMock.deploy.mock.calls[0] as [
      { applicationId: string },
      { title: string; description: string; deploymentId?: string },
    ];
    expect(deployable.applicationId).toBe(web);
    // The engine claims the row the push recorded, and no other.
    expect(meta).toEqual({
      title: 'Automatic deployment',
      description: rows[0].description,
      deploymentId: rows[0].deploymentId,
    });
  });

  it('deploys nothing on another branch, with Deploy automatically off, on a tag trigger, or on another connection', async () => {
    const { githubApp, otherGithubId } = await setUp();
    const develop = await githubApp('develop-app', { branch: 'develop' });
    const manual = await githubApp('manual-app', { autoDeploy: false });
    const onTag = await githubApp('tag-app', { triggerType: 'tag' });
    const elsewhere = await githubApp('elsewhere-app', {
      githubId: otherGithubId,
    });
    const otherRepo = await githubApp('other-repo-app', {
      repository: 'website',
    });
    const main = await githubApp('main-app', {});

    const res = await deliver(pushTo('main'));
    expect(res.status).toBe(200);

    for (const id of [develop, manual, onTag, elsewhere, otherRepo]) {
      expect(await deploymentsOf(id)).toHaveLength(0);
    }
    expect(await deploymentsOf(main)).toHaveLength(1);
    await waitFor(() => engineMock.deploy.mock.calls.length > 0);
    expect(engineMock.deploy).toHaveBeenCalledTimes(1);
  });

  it("a push to a Frozen Organization's connection deploys nothing and reaches no Server", async () => {
    const { githubApp, organizationId } = await setUp();
    const web = await githubApp('web', {});
    await freezeOrganization(ctx, organizationId);
    execMock.execAsync.mockClear();
    execMock.execAsyncRemote.mockClear();

    const res = await deliver(pushTo('main'));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deploymentsQueued: 0 });
    expect(await deploymentsOf(web)).toHaveLength(0);
    expect(engineMock.deploy).not.toHaveBeenCalled();
    expect(execMock.execAsync).not.toHaveBeenCalled();
    expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it('a push to a branch no Application builds deploys nothing', async () => {
    const { githubApp } = await setUp();
    const web = await githubApp('web', {});

    const res = await deliver(pushTo('feature/x'));

    expect(res.status).toBe(200);
    expect(await deploymentsOf(web)).toHaveLength(0);
    expect(engineMock.deploy).not.toHaveBeenCalled();
  });

  it('deleting the configured branch deploys nothing', async () => {
    const { githubApp } = await setUp();
    const web = await githubApp('web', {});

    // GitHub's shape for a branch deletion: `deleted`, a zero `after`, and
    // no head commit.
    const res = await deliver(
      pushTo('main', {
        deleted: true,
        after: '0000000000000000000000000000000000000000',
        head_commit: null,
      }),
    );

    expect(res.status).toBe(200);
    expect(await deploymentsOf(web)).toHaveLength(0);
  });

  it('an Application that cannot be recorded does not stop the others, and the delivery fails', async () => {
    const { githubApp } = await setUp();
    const first = await githubApp('first', {});
    const second = await githubApp('second', {});
    // The log bootstrap of whichever target comes first is refused, the way
    // an unreachable build Server refuses it.
    execMock.execAsync.mockRejectedValueOnce(new Error('connection refused'));

    const res = await deliver(pushTo('main'));

    expect(res.status).toBe(500);
    const counts = [
      (await deploymentsOf(first)).length,
      (await deploymentsOf(second)).length,
    ];
    expect(counts.sort()).toEqual([0, 1]);
    await waitFor(() => engineMock.deploy.mock.calls.length > 0);
  });

  it('an Application whose Deploy automatically was never set deploys on a push, as the Source card says', async () => {
    const { githubApp } = await setUp();
    // Rows written before the column had a default read `null`, which the
    // Source card renders as automatic.
    const legacy = await githubApp('legacy', {
      autoDeploy: null,
      triggerType: null,
    });

    await deliver(pushTo('main'));

    expect(await deploymentsOf(legacy)).toHaveLength(1);
    await waitFor(() => engineMock.deploy.mock.calls.length > 0);
  });
});
