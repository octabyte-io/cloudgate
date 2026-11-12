import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { ApplicationsService } from '../../src/applications/applications.service';
import {
  application,
  deployment,
  mysql,
  plan as planTable,
} from '../../src/db/schema';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import { GithubService } from '../../src/git-providers/strategies/github/github.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/** Polls until the condition holds (the queue processes in the background). */
async function waitFor(condition: () => boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Gives the background queue a moment, for asserting nothing reached it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

// Signs the payload exactly as GitHub does (github-push-deploy.e2e-spec.ts).
const sign = (secret: string, payload: object) =>
  `sha256=${createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex')}`;

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

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

/** The config acme/shop keeps, `shop` described as it is saved. */
const shopConfig = (port: number, extra = '') => `version: 1
services:
  shop:
    kind: web
    port: ${port}
    source:
      github: acme/shop
    build:
      type: dockerfile
${extra}`;

const EMPTY = 'version: 1\nservices: {}\n';

interface HeldBuild {
  deploymentId: string;
  applicationId: string;
  configName: string;
  status: string;
}

interface PlanBody {
  planId: string;
  environmentId: string;
  source: string;
  status: string;
  commitSha: string | null;
  branch: string | null;
  requestedBy: string | null;
  steps: Array<{ action: string; configName: string }>;
  results: Array<{
    configName: string;
    deploy: { status: string; deploymentId?: string } | null;
  }> | null;
  heldBuilds: HeldBuild[];
}

/**
 * A push to a repository-kept config's Config branch prepares a plan
 * for each Environment reading that branch, and applies nothing. When the
 * same push changes an Application's code and its own config entry, its
 * build is held until the plan is applied (new settings) or dismissed (old
 * ones), or released at once with the saved settings.
 *
 * Signed deliveries reach the real webhook route; the config reader is the
 * harness's in-memory fake, and the deployment engine is faked as in the
 * GitHub push-deploy spec, so what is asserted is the Deployment rows and
 * what reached the engine, with the settings it would have built with.
 */
describe('Push plans and held builds (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let cookie: string;
  let projectId: string;
  let productionId: string;
  let stagingId: string;
  let shopId: string;

  const execMock = { execAsync: jest.fn(), execAsyncRemote: jest.fn() };
  /** The port each build would have read, at the moment it started. */
  const builtWithPort: number[] = [];
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
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    builtWithPort.length = 0;
    execMock.execAsync
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '' });
    execMock.execAsyncRemote
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '' });
    engineMock.deploy
      .mockReset()
      .mockImplementation(async (deployable: { applicationId: string }) => {
        const [row] = await ctx.db
          .select({ port: application.port })
          .from(application)
          .where(eq(application.applicationId, deployable.applicationId));
        builtWithPort.push(row?.port ?? -1);
      });

    const res = await request(server)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const ownerId = (res.body as { user: { id: string } }).user.id;
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = {
      user: { id: ownerId },
      session: { activeOrganizationId: organizationId },
    };

    const project = await request(server)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'shop' });
    expect(project.status).toBe(201);
    projectId = (project.body as { projectId: string }).projectId;
    productionId = await createEnvironment('production');
    stagingId = await createEnvironment('staging');
    expect(
      (
        await request(server)
          .patch(`/environments/${stagingId}`)
          .set('Cookie', cookie)
          .send({ configBranch: 'staging' })
      ).status,
    ).toBe(200);

    const github = await ctx.app
      .get(GithubService)
      .create(ownerCtx, connection);

    // `shop` in production, built from acme/shop's main on every push.
    const created = await ctx.app.get(ApplicationsService).create(ownerCtx, {
      name: 'shop',
      appName: 'shop',
      environmentId: productionId,
    });
    shopId = created.applicationId;
    await ctx.db
      .update(application)
      .set({
        sourceType: 'github',
        githubId: github.githubId,
        owner: 'acme',
        repository: 'shop',
        branch: 'main',
        buildType: 'dockerfile',
        port: 8080,
      })
      .where(eq(application.applicationId, shopId));

    // The config moves into acme/shop describing what is saved, so nothing
    // is left to plan: main for production, staging (no Services) for staging.
    ctx.configReader.commit('acme/shop', shopConfig(8080));
    ctx.configReader.commit('acme/shop', EMPTY, { branch: 'staging' });
    const to = {
      kind: 'repository',
      gitProviderId: github.gitProvider.gitProviderId,
      repository: 'acme/shop',
    };
    const previewed = await request(server)
      .post(`/projects/${projectId}/config/move/preview`)
      .set('Cookie', cookie)
      .send({ to });
    expect(previewed.status).toBe(200);
    const moved = await request(server)
      .post(`/projects/${projectId}/config/move`)
      .set('Cookie', cookie)
      .send({ to, reads: (previewed.body as { reads: unknown }).reads });
    expect(moved.status).toBe(200);
    expect(
      (moved.body as { plans: PlanBody[] }).plans.map((one) => one.status),
    ).toEqual(['unchanged', 'unchanged']);
  });

  async function createEnvironment(name: string) {
    const created = await request(server)
      .post('/environments')
      .set('Cookie', cookie)
      .send({ name, projectId });
    expect(created.status).toBe(201);
    return (created.body as { environmentId: string }).environmentId;
  }

  /**
   * A real-shaped `push` delivery to acme/shop, naming the files its commits
   * touched (GitHub lists them per commit as added/modified/removed).
   */
  function deliver(
    branch: string,
    after: string,
    touched: { modified?: string[]; added?: string[]; removed?: string[] },
    extra: object = {},
  ) {
    const payload = {
      ref: `refs/heads/${branch}`,
      before: '1111111111111111111111111111111111111111',
      after,
      deleted: false,
      installation: { id: 99887766 },
      repository: {
        name: 'shop',
        full_name: 'acme/shop',
        owner: { name: 'acme', login: 'acme' },
      },
      pusher: { name: 'grace' },
      head_commit: { id: after, message: 'feat: listen on 9090' },
      commits: [
        {
          id: after,
          message: 'feat: listen on 9090',
          added: touched.added ?? [],
          modified: touched.modified ?? [],
          removed: touched.removed ?? [],
        },
      ],
      ...extra,
    };
    return request(server)
      .post('/github/webhook')
      .set('x-github-event', 'push')
      .set('x-hub-signature-256', sign('wh-secret', payload))
      .send(payload);
  }

  const planOf = async (environmentId: string) => {
    const res = await request(server)
      .get(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return (res.body as { plan: PlanBody | null }).plan;
  };

  const buildsOfShop = () =>
    ctx.db
      .select()
      .from(deployment)
      .where(eq(deployment.applicationId, shopId))
      .orderBy(deployment.createdAt);

  const savedPort = async () => {
    const [row] = await ctx.db
      .select({ port: application.port })
      .from(application)
      .where(eq(application.applicationId, shopId));
    return row.port;
  };

  /** Pushes a change of `shop`'s port together with its code. */
  async function pushPortChange(port = 9090) {
    const sha = ctx.configReader.commit('acme/shop', shopConfig(port));
    const res = await deliver('main', sha, {
      modified: ['cloudgate.yaml', 'src/server.ts'],
    });
    expect(res.status).toBe(200);
    return sha;
  }

  describe('plan preparation', () => {
    it('prepares a push plan for each Environment reading the pushed branch, and applies nothing', async () => {
      const sha = await pushPortChange();

      const production = await planOf(productionId);
      expect(production).toMatchObject({
        source: 'push',
        status: 'open',
        commitSha: sha,
        branch: 'main',
        requestedBy: null,
      });
      expect(production?.steps).toEqual([
        expect.objectContaining({ action: 'change', configName: 'shop' }),
      ]);
      // Staging reads its own branch, which this push did not move.
      expect((await planOf(stagingId))?.source).toBe('move');
      expect(await savedPort()).toBe(8080);
    });

    it('a push to another Environment’s Config branch plans only that Environment', async () => {
      const sha = ctx.configReader.commit(
        'acme/shop',
        'version: 1\nservices:\n  cache:\n    kind: redis\n',
        { branch: 'staging' },
      );

      const res = await deliver('staging', sha, {
        modified: ['cloudgate.yaml'],
      });

      expect(res.status).toBe(200);
      expect(await planOf(stagingId)).toMatchObject({
        source: 'push',
        commitSha: sha,
        branch: 'staging',
      });
      expect((await planOf(productionId))?.source).toBe('move');
    });

    it('a push whose config cannot be read plans nothing and still deploys', async () => {
      ctx.configReader.setUnreachable('acme/shop');

      const res = await deliver('main', 'abc0000000', {
        modified: ['cloudgate.yaml', 'src/server.ts'],
      });

      expect(res.status).toBe(200);
      expect((await planOf(productionId))?.source).toBe('move');
      const builds = await buildsOfShop();
      expect(builds.map((row) => row.status)).toEqual(['pending']);
      await waitFor(() => builtWithPort.length > 0);
      expect(engineMock.deploy).toHaveBeenCalledTimes(1);
    });
  });

  describe('what the previous config described', () => {
    const consoleShop = (name = 'shop') =>
      `version: 1\nservices:\n  ${name}:\n    kind: web\n    managed: console\n`;

    async function pushConfig(text: string) {
      const sha = ctx.configReader.commit('acme/shop', text);
      const res = await deliver('main', sha, { modified: ['cloudgate.yaml'] });
      expect(res.status).toBe(200);
      return sha;
    }

    const checkForChanges = () =>
      request(server)
        .post(`/environments/${productionId}/plan`)
        .set('Cookie', cookie);

    it('destroys a described Service a push drops from the file', async () => {
      const sha = await pushConfig(EMPTY);

      expect(await planOf(productionId)).toMatchObject({
        source: 'push',
        status: 'open',
        commitSha: sha,
        steps: [
          expect.objectContaining({ action: 'destroy', configName: 'shop' }),
        ],
      });
    });

    it('never destroys a Service whose console-managed line a push drops, then or on a later plan', async () => {
      await pushConfig(consoleShop());
      expect((await planOf(productionId))?.status).toBe('unchanged');

      await pushConfig(EMPTY);

      const dropped = await planOf(productionId);
      expect(dropped).toMatchObject({ source: 'push', status: 'unchanged' });
      expect(dropped?.steps).toEqual([]);
      const later = await checkForChanges();
      expect(later.status).toBe(201);
      expect(later.body).toMatchObject({ status: 'unchanged', steps: [] });
    });

    it('notes on a push plan, and on Check for changes, that a console-managed MySQL can now be described', async () => {
      await ctx.db.insert(mysql).values({
        name: 'Shop DB',
        configName: 'shop-db',
        databaseName: 'shop',
        databaseUser: 'shop',
        databasePassword: 'secret',
        databaseRootPassword: 'root-secret',
        dockerImage: 'mysql:8',
        environmentId: productionId,
      });
      const note = {
        kind: 'mysql-can-be-described',
        configName: 'shop-db',
        message:
          'shop-db: mysql can now be described; remove managed: console to hand it to the config',
      };

      await pushConfig(
        shopConfig(8080, '  shop-db:\n    kind: mysql\n    managed: console\n'),
      );

      expect(await planOf(productionId)).toMatchObject({
        source: 'push',
        status: 'unchanged',
        notes: [note],
      });
      const later = await checkForChanges();
      expect(later.status).toBe(201);
      expect(later.body).toMatchObject({
        status: 'unchanged',
        steps: [],
        notes: [note],
      });
    });

    it('refuses a console-managed line added for a Service that does not exist, or renamed', async () => {
      await pushConfig(
        `${EMPTY.replace('services: {}', 'services:')}  ghost:\n    kind: mongo\n    managed: console\n`,
      );
      // The push plans nothing; asking for a plan names the refusal.
      expect((await planOf(productionId))?.source).toBe('move');
      const added = await checkForChanges();
      expect(added.status).toBe(409);
      expect(added.body).toMatchObject({ code: 'PLAN_REFUSED' });
      expect((added.body as { message: string }).message).toMatch(/ghost/);

      await pushConfig(consoleShop());
      await pushConfig(consoleShop('store'));
      const renamed = await checkForChanges();
      expect(renamed.status).toBe(409);
      expect((renamed.body as { message: string }).message).toMatch(/store/);
    });
  });

  describe('held builds', () => {
    it('holds the build of an Application whose code and own entry the push changed, and the plan names it', async () => {
      await pushPortChange();

      const builds = await buildsOfShop();
      expect(builds.map((row) => row.status)).toEqual(['held']);
      await settle();
      expect(engineMock.deploy).not.toHaveBeenCalled();

      const production = await planOf(productionId);
      expect(production?.heldBuilds).toEqual([
        expect.objectContaining({
          deploymentId: builds[0].deploymentId,
          applicationId: shopId,
          configName: 'shop',
          status: 'held',
        }),
      ]);
      // The Deployment log lists it, held.
      const log = await request(server)
        .get(`/applications/${shopId}/deployments`)
        .set('Cookie', cookie);
      expect(log.status).toBe(200);
      expect(
        (log.body as Array<{ status: string; heldByPlanId: string | null }>)[0],
      ).toMatchObject({ status: 'held', heldByPlanId: production?.planId });
    });

    it('applying the plan queues the held build with the new settings, and no second one', async () => {
      await pushPortChange();
      const production = (await planOf(productionId)) as PlanBody;
      const [held] = await buildsOfShop();

      const applied = await request(server)
        .post(`/environments/${productionId}/plan/apply`)
        .set('Cookie', cookie)
        .send({ planId: production.planId });

      expect(applied.status).toBe(200);
      const body = applied.body as PlanBody;
      expect(body.results?.[0].deploy).toEqual({
        status: 'queued',
        deploymentId: held.deploymentId,
      });
      await waitFor(() => builtWithPort.length > 0);
      expect(builtWithPort).toEqual([9090]);
      const builds = await buildsOfShop();
      expect(builds).toHaveLength(1);
      expect(builds[0].status).toBe('pending');
      expect(body.heldBuilds).toEqual([
        expect.objectContaining({
          deploymentId: held.deploymentId,
          status: 'pending',
        }),
      ]);
    });

    it('dismissing the plan queues the held build with the old settings', async () => {
      await pushPortChange();
      const production = (await planOf(productionId)) as PlanBody;

      const dismissed = await request(server)
        .post(`/environments/${productionId}/plan/dismiss`)
        .set('Cookie', cookie)
        .send({ planId: production.planId });

      expect(dismissed.status).toBe(200);
      await waitFor(() => builtWithPort.length > 0);
      expect(builtWithPort).toEqual([8080]);
      expect(await savedPort()).toBe(8080);
      expect((await buildsOfShop()).map((row) => row.status)).toEqual([
        'pending',
      ]);
    });

    it('"build now with saved settings" releases a held build at once and leaves the plan open', async () => {
      await pushPortChange();
      const [held] = await buildsOfShop();

      const released = await request(server)
        .post(`/deployments/${held.deploymentId}/build-now`)
        .set('Cookie', cookie);

      expect(released.status).toBe(200);
      expect((released.body as { status: string }).status).toBe('pending');
      await waitFor(() => builtWithPort.length > 0);
      expect(builtWithPort).toEqual([8080]);
      const production = (await planOf(productionId)) as PlanBody;
      expect(production.status).toBe('open');
      expect(production.heldBuilds[0].status).toBe('pending');

      // Released once: a second ask is refused, and applying later queues an
      // ordinary Deployment of its own.
      const again = await request(server)
        .post(`/deployments/${held.deploymentId}/build-now`)
        .set('Cookie', cookie);
      expect(again.status).toBe(409);
    });

    it('a held build can be cancelled, and the plan’s Apply then queues an ordinary Deployment', async () => {
      await pushPortChange();
      const [held] = await buildsOfShop();

      const cancelled = await request(server)
        .post(`/deployments/${held.deploymentId}/cancel`)
        .set('Cookie', cookie);
      expect(cancelled.status).toBe(200);
      expect((cancelled.body as { status: string }).status).toBe('cancelled');

      const production = (await planOf(productionId)) as PlanBody;
      const applied = await request(server)
        .post(`/environments/${productionId}/plan/apply`)
        .set('Cookie', cookie)
        .send({ planId: production.planId });
      expect(applied.status).toBe(200);
      await waitFor(() => builtWithPort.length > 0);
      expect(builtWithPort).toEqual([9090]);
      const builds = await buildsOfShop();
      expect(builds.map((row) => row.status)).toEqual(['cancelled', 'pending']);
    });

    it('a manual Deploy while a build is held cancels the held build, so only one builds', async () => {
      await pushPortChange();
      const [held] = await buildsOfShop();
      expect(held.status).toBe('held');

      const deployed = await request(server)
        .post(`/applications/${shopId}/deployments`)
        .set('Cookie', cookie)
        .send({});

      expect(deployed.status).toBe(201);
      await waitFor(() => builtWithPort.length > 0);
      // It builds with the saved settings, as "build now" would.
      expect(builtWithPort).toEqual([8080]);
      const builds = await buildsOfShop();
      expect(builds.map((row) => row.status)).toEqual(['cancelled', 'pending']);
      // The plan stays open, naming the build it no longer holds.
      const production = (await planOf(productionId)) as PlanBody;
      expect(production.status).toBe('open');
      expect(production.heldBuilds).toEqual([
        expect.objectContaining({
          deploymentId: held.deploymentId,
          status: 'cancelled',
        }),
      ]);
      const applied = await request(server)
        .post(`/environments/${productionId}/plan/apply`)
        .set('Cookie', cookie)
        .send({ planId: production.planId });
      expect(applied.status).toBe(200);
      await settle();
      expect(
        (await buildsOfShop()).filter((row) => row.status === 'held'),
      ).toEqual([]);
    });

    it('a push that does not change the Application’s own entry builds as today', async () => {
      // The config file changes, but not `shop`'s entry.
      const sha = ctx.configReader.commit(
        'acme/shop',
        shopConfig(8080, '  cache:\n    kind: redis\n'),
      );

      const res = await deliver('main', sha, {
        modified: ['cloudgate.yaml', 'src/server.ts'],
      });

      expect(res.status).toBe(200);
      expect((await planOf(productionId))?.source).toBe('push');
      expect((await buildsOfShop()).map((row) => row.status)).toEqual([
        'pending',
      ]);
      await waitFor(() => builtWithPort.length > 0);
      expect(builtWithPort).toEqual([8080]);
    });

    it('a code-only push builds as today even while an earlier plan changes the entry', async () => {
      await pushPortChange();
      const first = (await planOf(productionId)) as PlanBody;
      const [held] = await buildsOfShop();

      // Head moves with code only: the config file is untouched.
      const sha = ctx.configReader.commit('acme/shop', shopConfig(9090));
      const res = await deliver('main', sha, { modified: ['src/server.ts'] });

      expect(res.status).toBe(200);
      const second = (await planOf(productionId)) as PlanBody;
      expect(second.planId).not.toBe(first.planId);
      // The earlier hold moved to the newer plan, which still changes `shop`.
      expect(second.heldBuilds.map((one) => one.deploymentId)).toEqual([
        held.deploymentId,
      ]);
      const builds = await buildsOfShop();
      expect(builds.map((row) => row.status)).toEqual(['held', 'pending']);
    });

    it('a newer push that changes the entry again replaces the earlier held build', async () => {
      await pushPortChange(9090);
      const [earlier] = await buildsOfShop();

      await pushPortChange(7070);

      const builds = await buildsOfShop();
      expect(builds.map((row) => row.status)).toEqual(['cancelled', 'held']);
      const production = (await planOf(productionId)) as PlanBody;
      expect(builds[0].deploymentId).toBe(earlier.deploymentId);
      // The newer plan names both: the one it holds, and the one replaced.
      expect(
        production.heldBuilds.map(({ deploymentId, status }) => ({
          deploymentId,
          status,
        })),
      ).toEqual([
        { deploymentId: earlier.deploymentId, status: 'cancelled' },
        { deploymentId: builds[1].deploymentId, status: 'held' },
      ]);
      await settle();
      expect(engineMock.deploy).not.toHaveBeenCalled();
    });

    it('a newer plan that no longer changes the entry queues the held build', async () => {
      await pushPortChange();
      // The entry is put back as saved; a "Check for changes" of it.
      ctx.configReader.commit('acme/shop', shopConfig(8080));

      const asked = await request(server)
        .post(`/environments/${productionId}/plan`)
        .set('Cookie', cookie);

      expect(asked.status).toBe(201);
      await waitFor(() => builtWithPort.length > 0);
      expect(builtWithPort).toEqual([8080]);
      const [plan] = await ctx.db
        .select()
        .from(planTable)
        .where(eq(planTable.source, 'push'));
      expect(plan.status).toBe('superseded');
    });
  });
});
