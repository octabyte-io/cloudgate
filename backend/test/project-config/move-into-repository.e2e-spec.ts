import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  application,
  member,
  plan as planTable,
  postgres,
  projectConfigLocation,
  redis,
  webServerSettings,
} from '../../src/db/schema';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import type { DeploymentJob } from '../../src/deployment-queue/job-types';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import type {
  JobState,
  QueuedJob,
  QueuePort,
} from '../../src/deployment-queue/queue.port';
import { GithubService } from '../../src/git-providers/strategies/github/github.service';
import { OCTOKIT_FACTORY } from '../../src/git-providers/strategies/github/octokit.provider';
import { PushPlans } from '../../src/project-config/push-plans.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { signUpMember } from '../utils/test-auth';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

interface PlanBody {
  planId: string;
  environmentId: string;
  source: string;
  status: string;
  textHash: string;
  commitSha: string | null;
  branch: string | null;
  steps: Array<Record<string, unknown>>;
  notes: Array<Record<string, unknown>>;
  dismissedBy: string | null;
}

interface Read {
  environmentId: string;
  commitSha: string | null;
  textHash: string;
}

interface Preview {
  to: Record<string, unknown>;
  reads: Read[];
  environments: Array<{
    environmentId: string;
    name: string;
    branch: string | null;
    commitSha: string | null;
    fileUrl: string | null;
    steps: Array<Record<string, unknown>>;
    notes: Array<Record<string, unknown>>;
  }>;
}

/** The deployment queue as a list: a queued job is asserted, never run. */
class ListQueue implements QueuePort {
  jobs: QueuedJob[] = [];
  private next = 0;

  add(data: DeploymentJob): Promise<QueuedJob> {
    const job: QueuedJob = { id: `job-${++this.next}`, data, state: 'waiting' };
    this.jobs.push(job);
    return Promise.resolve({ ...job });
  }

  getJobs(states?: JobState[]): Promise<QueuedJob[]> {
    return Promise.resolve(
      this.jobs.filter((job) => !states || states.includes(job.state)),
    );
  }

  cancel(): Promise<boolean> {
    return Promise.resolve(false);
  }

  clearWaiting(): Promise<QueuedJob[]> {
    return Promise.resolve([]);
  }
}

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

/** A config the repository keeps: a web Service from the repository itself. */
const SHOP = `version: 1
services:
  shop:
    kind: web
    port: 8080
    source:
      github: acme/shop
    build:
      type: dockerfile
`;

const DATA = `version: 1
services:
  cache:
    kind: redis
    version: "7"
  db:
    kind: postgres
`;

/**
 * An operator moves a Project's config into a GitHub repository, read
 * per Environment from its Config branch through the config reader port
 * (faked in memory by the harness). A move is a preview and a confirm, and
 * applies nothing; plans record the commit they read, and an Apply is
 * refused once the branch has moved on.
 */
describe('Moving a Project config into a repository (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let cookie: string;
  let ownerId: string;
  let organizationId: string;
  let projectId: string;
  let productionId: string;
  let stagingId: string;
  let gitProviderId: string;
  let githubId: string;

  const queue = new ListQueue();
  const execMock = { execAsync: jest.fn(), execAsyncRemote: jest.fn() };
  const docker = {
    getService: jest.fn(() => ({
      inspect: jest.fn().mockRejectedValue(new Error('no such service')),
      update: jest.fn(),
    })),
    createService: jest.fn().mockResolvedValue(undefined),
    listTasks: jest.fn().mockResolvedValue([{ Status: { State: 'running' } }]),
  };
  // What the connection resolver lists for a plan-created Application.
  const stubOctokit = {
    rest: {
      apps: { listReposAccessibleToInstallation: 'repos-endpoint' },
      repos: { listBranches: 'branches-endpoint' },
    },
    auth: () => Promise.resolve({ token: 'ghs_stub-token' }),
    paginate: (endpoint: unknown) =>
      endpoint === 'repos-endpoint'
        ? Promise.resolve([
            {
              name: 'shop',
              owner: { login: 'acme' },
              html_url: 'https://github.com/acme/shop',
              default_branch: 'main',
            },
          ])
        : Promise.resolve([{ name: 'main', commit: { sha: 'abc123' } }]),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: DEPLOYMENT_QUEUE, useValue: queue },
        { provide: RemoteExecService, useValue: execMock },
        {
          provide: RemoteDockerFactory,
          useValue: { getRemoteDocker: jest.fn().mockResolvedValue(docker) },
        },
        { provide: OCTOKIT_FACTORY, useValue: () => stubOctokit },
      ],
    });
    server = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  const succeeds = (command: string) =>
    Promise.resolve(
      isPresenceProbe(command)
        ? { stdout: 'absent', stderr: '' }
        : { stdout: '', stderr: '' },
    );

  beforeEach(async () => {
    await ctx.resetDb();
    queue.jobs = [];
    execMock.execAsync.mockReset().mockImplementation(succeeds);
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_serverId: string, command: string) =>
        succeeds(command),
      );

    const res = await request(server)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    ownerId = (res.body as { user: { id: string } }).user.id;
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', cookie);
    organizationId = (orgs.body as { id: string }[])[0].id;

    const project = await request(server)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'shop' });
    expect(project.status).toBe(201);
    projectId = (project.body as { projectId: string }).projectId;
    productionId = await createEnvironment('production');
    stagingId = await createEnvironment('staging');

    const github = await ctx.app.get(GithubService).create(
      {
        user: { id: ownerId },
        session: { activeOrganizationId: organizationId },
      },
      connection,
    );
    gitProviderId = github.gitProvider.gitProviderId;
    githubId = github.githubId;
  });

  async function createEnvironment(name: string) {
    const created = await request(server)
      .post('/environments')
      .set('Cookie', cookie)
      .send({ name, projectId });
    expect(created.status).toBe(201);
    return (created.body as { environmentId: string }).environmentId;
  }

  const setConfigBranch = (
    environmentId: string,
    configBranch: string | null,
  ) =>
    request(server)
      .patch(`/environments/${environmentId}`)
      .set('Cookie', cookie)
      .send({ configBranch });

  const target = (extra: object = {}) => ({
    kind: 'repository',
    gitProviderId,
    repository: 'acme/shop',
    ...extra,
  });

  const preview = (to: object = target(), as = cookie) =>
    request(server)
      .post(`/projects/${projectId}/config/move/preview`)
      .set('Cookie', as)
      .send({ to });

  const confirm = (body: { to: object; reads: Read[] }, as = cookie) =>
    request(server)
      .post(`/projects/${projectId}/config/move`)
      .set('Cookie', as)
      .send(body);

  const askForPlan = (environmentId: string) =>
    request(server)
      .post(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);

  const apply = (environmentId: string, planId: string) =>
    request(server)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId });

  async function location() {
    const [found] = await ctx.db
      .select()
      .from(projectConfigLocation)
      .where(eq(projectConfigLocation.projectId, projectId));
    return found;
  }

  /** Previews and confirms the move, answering the plans it stored. */
  async function moveIn(): Promise<PlanBody[]> {
    const previewed = await preview();
    expect(previewed.status).toBe(200);
    const { reads } = previewed.body as Preview;
    const confirmed = await confirm({ to: target(), reads });
    expect(confirmed.status).toBe(200);
    return (confirmed.body as { plans: PlanBody[] }).plans;
  }

  describe('the preview', () => {
    it("refuses when an Environment's Config branch is missing, naming the repository and branch, and changes nothing", async () => {
      ctx.configReader.commit('acme/shop', DATA);
      expect((await setConfigBranch(stagingId, 'staging')).status).toBe(200);

      const previewed = await preview();

      expect(previewed.status).toBe(409);
      const body = previewed.body as { code: string; message: string };
      expect(body.code).toBe('CONFIG_UNREADABLE');
      expect(body.message).toContain('acme/shop');
      expect(body.message).toContain('staging');
      expect((await location()).kind).toBe('cloudgate');
      expect(await ctx.db.select().from(planTable)).toHaveLength(0);
    });

    it('refuses an unreachable repository and a missing file the same way', async () => {
      const unknown = await preview();
      expect(unknown.status).toBe(409);
      expect((unknown.body as { code: string }).code).toBe('CONFIG_UNREADABLE');

      ctx.configReader.commit('acme/shop', DATA);
      const elsewhere = await preview(
        target({ path: 'deploy/cloudgate.yaml' }),
      );
      expect(elsewhere.status).toBe(409);
      expect((elsewhere.body as { message: string }).message).toContain(
        'deploy/cloudgate.yaml',
      );
    });

    it("refuses a copy that does not parse, naming the Environment's repository and branch", async () => {
      ctx.configReader.commit('acme/shop', DATA);
      ctx.configReader.commit(
        'acme/shop',
        'version: 1\nservices:\n  cache:\n    kind: redis\n    colour: blue\n',
        { branch: 'staging' },
      );
      await setConfigBranch(stagingId, 'staging');

      const previewed = await preview();

      expect(previewed.status).toBe(409);
      const body = previewed.body as { code: string; message: string };
      expect(body.code).toBe('PLAN_REFUSED');
      expect(body.message).toContain('cache.colour');
      expect(body.message).toContain('staging');
      expect(body.message).toContain('acme/shop');
    });

    it("answers each Environment's plan against its own Config branch, and stores nothing", async () => {
      const mainSha = ctx.configReader.commit('acme/shop', DATA);
      const stagingSha = ctx.configReader.commit(
        'acme/shop',
        'version: 1\nservices:\n  cache:\n    kind: redis\n',
        { branch: 'staging' },
      );
      await setConfigBranch(stagingId, 'staging');

      const previewed = await preview();

      expect(previewed.status).toBe(200);
      const body = previewed.body as Preview;
      expect(body.to).toMatchObject({
        kind: 'repository',
        gitProviderId,
        repository: 'acme/shop',
        path: 'cloudgate.yaml',
      });
      const production = body.environments.find(
        (one) => one.environmentId === productionId,
      );
      const staging = body.environments.find(
        (one) => one.environmentId === stagingId,
      );
      expect(production).toMatchObject({
        name: 'production',
        branch: 'main',
        commitSha: mainSha,
      });
      // A brand-new Project's first move shows the creates (US66).
      expect(
        production?.steps.map((step) => [step.action, step.configName]),
      ).toEqual([
        ['create', 'cache'],
        ['create', 'db'],
      ]);
      expect(staging).toMatchObject({
        branch: 'staging',
        commitSha: stagingSha,
      });
      expect(staging?.steps.map((step) => step.configName)).toEqual(['cache']);
      expect(body.reads).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            environmentId: productionId,
            commitSha: mainSha,
          }),
          expect.objectContaining({
            environmentId: stagingId,
            commitSha: stagingSha,
          }),
        ]),
      );

      expect((await location()).kind).toBe('cloudgate');
      expect(await ctx.db.select().from(planTable)).toHaveLength(0);
    });

    it('needs project: update', async () => {
      ctx.configReader.commit('acme/shop', DATA);
      const fixture = await signUpMember(server, cookie);
      await ctx.db
        .update(member)
        .set({
          accessedProjects: [projectId],
          accessedEnvironments: [productionId, stagingId],
        })
        .where(eq(member.userId, fixture.id));

      expect((await preview(target(), fixture.cookie)).status).toBe(403);
      expect(
        (
          await confirm(
            {
              to: target(),
              reads: [],
            },
            fixture.cookie,
          )
        ).status,
      ).toBe(403);
    });

    it('refuses a git provider connection outside the organization', async () => {
      ctx.configReader.commit('acme/shop', DATA);

      const previewed = await preview(target({ gitProviderId: 'not-ours' }));

      expect(previewed.status).toBe(404);
    });
  });

  describe('the confirm', () => {
    it('switches the location, dismisses the old open plans, stores the previewed plans as open, and applies nothing', async () => {
      // An open plan of the Cloudgate-kept config, which the move replaces.
      const saved = await request(server)
        .post(`/projects/${projectId}/config/plans`)
        .set('Cookie', cookie)
        .send({
          text: 'version: 1\nservices:\n  sessions:\n    kind: redis\n',
        });
      expect(saved.status).toBe(201);
      const old = (saved.body as { plans: PlanBody[] }).plans;
      const sha = ctx.configReader.commit('acme/shop', DATA);

      const plans = await moveIn();

      const moved = await location();
      expect(moved).toMatchObject({
        kind: 'repository',
        text: null,
        gitProviderId,
        repository: 'acme/shop',
        path: 'cloudgate.yaml',
      });
      for (const one of old) {
        const [found] = await ctx.db
          .select()
          .from(planTable)
          .where(eq(planTable.planId, one.planId));
        expect(found).toMatchObject({
          status: 'dismissed',
          dismissedBy: ownerId,
        });
      }
      expect(plans).toHaveLength(2);
      for (const one of plans) {
        expect(one).toMatchObject({
          source: 'move',
          status: 'open',
          commitSha: sha,
          branch: 'main',
        });
      }
      // Nothing applied: no Service written, nothing queued.
      expect(await ctx.db.select().from(redis)).toHaveLength(0);
      expect(await ctx.db.select().from(postgres)).toHaveLength(0);
      expect(queue.jobs).toHaveLength(0);

      // The config page names where it is kept and holds no text.
      const config = await request(server)
        .get(`/projects/${projectId}/config`)
        .set('Cookie', cookie);
      expect(config.status).toBe(200);
      expect(
        (config.body as { location: Record<string, unknown> }).location,
      ).toMatchObject({
        kind: 'repository',
        gitProviderId,
        providerType: 'github',
        connectionName: 'Team GitHub',
        repository: 'acme/shop',
        path: 'cloudgate.yaml',
      });
      expect(JSON.stringify(config.body)).not.toContain('redis');
    });

    it('is refused when a read changed since the preview, and changes nothing', async () => {
      ctx.configReader.commit('acme/shop', DATA);
      const previewed = await preview();
      const { reads } = previewed.body as Preview;
      ctx.configReader.commit(
        'acme/shop',
        'version: 1\nservices:\n  cache:\n    kind: redis\n',
      );

      const confirmed = await confirm({ to: target(), reads });

      expect(confirmed.status).toBe(409);
      expect((confirmed.body as { code: string }).code).toBe('MOVE_STALE');
      expect((await location()).kind).toBe('cloudgate');
      expect(await ctx.db.select().from(planTable)).toHaveLength(0);
    });

    it('is refused when the reads name other Environments than the Project has', async () => {
      ctx.configReader.commit('acme/shop', DATA);
      const previewed = await preview();
      const { reads } = previewed.body as Preview;

      const confirmed = await confirm({ to: target(), reads: reads.slice(1) });

      expect(confirmed.status).toBe(409);
      expect((confirmed.body as { code: string }).code).toBe('MOVE_STALE');
    });
  });

  describe('with no path', () => {
    const YML = { path: 'cloudgate.yml' };

    /** Nothing was stored: the location is still Cloudgate's, and no plan was made. */
    async function nothingStored() {
      expect((await location()).kind).toBe('cloudgate');
      expect(await ctx.db.select().from(planTable)).toHaveLength(0);
    }

    it('takes cloudgate.yml when every Config branch has only it, previews and stores it, and a later push plan reads it', async () => {
      const mainSha = ctx.configReader.commit('acme/shop', DATA, YML);
      ctx.configReader.commit('acme/shop', DATA, {
        ...YML,
        branch: 'staging',
      });
      await setConfigBranch(stagingId, 'staging');

      const previewed = await preview();

      expect(previewed.status).toBe(200);
      const body = previewed.body as Preview;
      expect(body.to).toMatchObject({
        kind: 'repository',
        repository: 'acme/shop',
        path: 'cloudgate.yml',
      });
      for (const one of body.environments) {
        expect(one.fileUrl).toContain('cloudgate.yml');
      }

      const confirmed = await confirm({ to: target(), reads: body.reads });

      expect(confirmed.status).toBe(200);
      expect(await location()).toMatchObject({
        kind: 'repository',
        repository: 'acme/shop',
        path: 'cloudgate.yml',
      });
      expect(
        (confirmed.body as { location: Record<string, unknown> }).location,
      ).toMatchObject({ path: 'cloudgate.yml' });

      const pushedSha = ctx.configReader.commit(
        'acme/shop',
        `${DATA}  more:\n    kind: redis\n`,
        YML,
      );
      expect(pushedSha).not.toBe(mainSha);
      ctx.configReader.calls.length = 0;
      await ctx.app.get(PushPlans).planPush({
        gitProviderId,
        repository: 'acme/shop',
        branch: 'main',
        changedFiles: ['cloudgate.yml'],
      });

      const [pushed] = await ctx.db
        .select()
        .from(planTable)
        .where(eq(planTable.source, 'push'));
      expect(pushed).toMatchObject({
        environmentId: productionId,
        status: 'open',
        commitSha: pushedSha,
      });
      expect(
        ctx.configReader.calls.every((call) => call.path === 'cloudgate.yml'),
      ).toBe(true);
    });

    it('takes cloudgate.yaml when every Config branch has only it, as before', async () => {
      ctx.configReader.commit('acme/shop', DATA);

      await moveIn();

      expect((await location()).path).toBe('cloudgate.yaml');
    });

    it('refuses a Config branch holding both names, naming the repository and branch, and stores nothing', async () => {
      ctx.configReader.commit('acme/shop', DATA);
      ctx.configReader.commit('acme/shop', DATA, { branch: 'staging' });
      ctx.configReader.commit('acme/shop', DATA, {
        ...YML,
        branch: 'staging',
      });
      await setConfigBranch(stagingId, 'staging');

      const previewed = await preview();
      const confirmed = await confirm({ to: target(), reads: [] });

      for (const refused of [previewed, confirmed]) {
        expect(refused.status).toBe(409);
        expect(refused.body).toMatchObject({
          code: 'CONFIG_PATH_AMBIGUOUS',
          message:
            'Both cloudgate.yaml and cloudgate.yml are in acme/shop on branch staging; set Path to the one to use',
        });
      }
      await nothingStored();
    });

    it("refuses Environments whose Config branches hold different names, naming each Environment's branch and file, and stores nothing", async () => {
      ctx.configReader.commit('acme/shop', DATA);
      ctx.configReader.commit('acme/shop', DATA, {
        ...YML,
        branch: 'staging',
      });
      await setConfigBranch(stagingId, 'staging');

      const previewed = await preview();

      expect(previewed.status).toBe(409);
      const body = previewed.body as { code: string; message: string };
      expect(body.code).toBe('CONFIG_PATH_AMBIGUOUS');
      expect(body.message).toContain('acme/shop');
      expect(body.message).toContain(
        "the production Environment's branch main has only cloudgate.yaml",
      );
      expect(body.message).toContain(
        "the staging Environment's branch staging has only cloudgate.yml",
      );
      await nothingStored();
    });

    it('refuses a Config branch with neither name, naming both', async () => {
      ctx.configReader.commit('acme/shop', DATA, { path: 'deploy.yaml' });

      const previewed = await preview();

      expect(previewed.status).toBe(409);
      const body = previewed.body as { code: string; message: string };
      expect(body.code).toBe('CONFIG_UNREADABLE');
      expect(body.message).toContain(
        'There is no cloudgate.yaml or cloudgate.yml in acme/shop on branch main',
      );
      await nothingStored();
    });

    it('does not look for cloudgate.yml when cloudgate.yaml is named', async () => {
      ctx.configReader.commit('acme/shop', DATA, YML);

      const previewed = await preview(target({ path: 'cloudgate.yaml' }));

      expect(previewed.status).toBe(409);
      const body = previewed.body as { code: string; message: string };
      expect(body.code).toBe('CONFIG_UNREADABLE');
      expect(body.message).toContain(
        'There is no file cloudgate.yaml in repository acme/shop on branch main',
      );
      expect(
        ctx.configReader.calls.some((call) => call.path === 'cloudgate.yml'),
      ).toBe(false);
      await nothingStored();
    });

    it('keeps reading the stored cloudgate.yml after a cloudgate.yaml is committed beside it', async () => {
      ctx.configReader.commit('acme/shop', DATA, YML);
      await moveIn();
      expect((await location()).path).toBe('cloudgate.yml');

      // A different config under the other name: were it read, the plan
      // would no longer create cache and db.
      const sha = ctx.configReader.commit(
        'acme/shop',
        'version: 1\nservices: {}\n',
      );
      ctx.configReader.calls.length = 0;
      await ctx.app.get(PushPlans).planPush({
        gitProviderId,
        repository: 'acme/shop',
        branch: 'main',
        changedFiles: ['cloudgate.yaml'],
      });

      expect((await location()).path).toBe('cloudgate.yml');
      expect(ctx.configReader.calls.length).toBeGreaterThan(0);
      expect(
        ctx.configReader.calls.every((call) => call.path === 'cloudgate.yml'),
      ).toBe(true);
      const [pushed] = await ctx.db
        .select()
        .from(planTable)
        .where(eq(planTable.source, 'push'));
      expect(pushed.commitSha).toBe(sha);
      // The plan read cloudgate.yml, which still lists both.
      expect(
        pushed.steps.map((step) => [
          step.action,
          (step as { configName?: string }).configName,
        ]),
      ).toEqual([
        ['create', 'cache'],
        ['create', 'db'],
      ]);
    });
  });

  describe('plans of a repository-kept config', () => {
    it("reads each Environment's Config branch, records the commit, and stores no text", async () => {
      ctx.configReader.commit('acme/shop', DATA);
      await moveIn();
      const stagingSha = ctx.configReader.commit(
        'acme/shop',
        'version: 1\nservices:\n  cache:\n    kind: redis\n',
        { branch: 'staging' },
      );
      await setConfigBranch(stagingId, 'staging');

      const planned = await askForPlan(stagingId);

      expect(planned.status).toBe(201);
      expect(planned.body as PlanBody).toMatchObject({
        source: 'request',
        status: 'open',
        commitSha: stagingSha,
        branch: 'staging',
      });
      const [stored] = await ctx.db
        .select({ text: planTable.text })
        .from(planTable)
        .where(eq(planTable.planId, (planned.body as PlanBody).planId));
      expect(stored.text).toBeNull();
      expect(ctx.configReader.calls.at(-1)).toMatchObject({
        repository: 'acme/shop',
        path: 'cloudgate.yaml',
        ref: 'staging',
        connection: { gitProviderId, providerType: 'github' },
      });
    });

    it('refuses the plan for a missing Config branch or an unreachable repository, naming them, with no fallback', async () => {
      ctx.configReader.commit('acme/shop', DATA);
      const [production] = (await moveIn()).filter(
        (one) => one.environmentId === productionId,
      );

      expect((await setConfigBranch(productionId, 'release')).status).toBe(200);
      const missing = await askForPlan(productionId);
      expect(missing.status).toBe(409);
      expect(missing.body as { code: string; message: string }).toMatchObject({
        code: 'CONFIG_UNREADABLE',
        message: expect.stringMatching(
          /acme\/shop.*release|release.*acme\/shop/,
        ) as string,
      });

      await setConfigBranch(productionId, null);
      ctx.configReader.setUnreachable('acme/shop');
      const unreachable = await askForPlan(productionId);
      expect(unreachable.status).toBe(409);
      expect((unreachable.body as { message: string }).message).toContain(
        'acme/shop',
      );

      // The open plan is still the move's.
      const read = await request(server)
        .get(`/environments/${productionId}/plan`)
        .set('Cookie', cookie);
      expect((read.body as { plan: PlanBody }).plan.planId).toBe(
        production.planId,
      );
    });

    it('refuses an Apply once the Config branch moved on, and applies one that did not, storing no text', async () => {
      await ctx.db
        .insert(webServerSettings)
        .values({ serverIp: '198.51.100.7' });
      ctx.configReader.commit('acme/shop', DATA);
      const plans = await moveIn();
      const production = plans.find(
        (one) => one.environmentId === productionId,
      );
      const staging = plans.find((one) => one.environmentId === stagingId);
      // Staging reads its own branch from now on; production's moves on.
      ctx.configReader.commit('acme/shop', DATA, { branch: 'staging' });
      await setConfigBranch(stagingId, 'staging');
      ctx.configReader.commit('acme/shop', `${DATA}  more:\n    kind: redis\n`);

      const stale = await apply(productionId, production?.planId ?? '');
      expect(stale.status).toBe(409);
      expect((stale.body as { code: string }).code).toBe('PLAN_STALE');

      // Staging's plan was read from main's old commit, so it is stale too.
      const branchMoved = await apply(stagingId, staging?.planId ?? '');
      expect((branchMoved.body as { code: string }).code).toBe('PLAN_STALE');
      expect(await ctx.db.select().from(redis)).toHaveLength(0);

      const fresh = await askForPlan(stagingId);
      expect(fresh.status).toBe(201);
      const applied = await apply(stagingId, (fresh.body as PlanBody).planId);
      expect(applied.status).toBe(200);
      expect((applied.body as PlanBody).status).toBe('applied');
      expect(await ctx.db.select().from(redis)).toHaveLength(1);
      expect((await location()).text).toBeNull();
    });

    it("gives a plan-created Application building from the config's own repository the Environment's Config branch", async () => {
      await ctx.db
        .insert(webServerSettings)
        .values({ serverIp: '198.51.100.7' });
      ctx.configReader.commit('acme/shop', SHOP);
      ctx.configReader.commit('acme/shop', SHOP, { branch: 'staging' });
      await setConfigBranch(stagingId, 'staging');
      const plans = await moveIn();

      for (const [environmentId, branch] of [
        [stagingId, 'staging'],
        [productionId, 'main'],
      ] as const) {
        const open = plans.find((one) => one.environmentId === environmentId);
        const applied = await apply(environmentId, open?.planId ?? '');
        expect(applied.status).toBe(200);
        const [shop] = await ctx.db
          .select()
          .from(application)
          .where(eq(application.environmentId, environmentId));
        expect(shop).toMatchObject({
          configName: 'shop',
          sourceType: 'github',
          githubId,
          owner: 'acme',
          repository: 'shop',
          branch,
        });
      }
    });
  });

  describe("an Environment's copy", () => {
    it('is read live with its commit and a link to the file', async () => {
      const sha = ctx.configReader.commit('acme/shop', DATA);
      await moveIn();

      const copy = await request(server)
        .get(`/environments/${productionId}/config`)
        .set('Cookie', cookie);

      expect(copy.status).toBe(200);
      expect(copy.body).toMatchObject({
        kind: 'repository',
        environmentId: productionId,
        repository: 'acme/shop',
        path: 'cloudgate.yaml',
        configBranch: null,
        copy: {
          text: DATA,
          commitSha: sha,
          branch: 'main',
          fileUrl: expect.stringContaining(sha) as string,
        },
        refusal: null,
      });
    });

    it('answers why it cannot be read', async () => {
      ctx.configReader.commit('acme/shop', DATA);
      await moveIn();
      await setConfigBranch(stagingId, 'gone');

      const copy = await request(server)
        .get(`/environments/${stagingId}/config`)
        .set('Cookie', cookie);

      expect(copy.status).toBe(200);
      expect(copy.body).toMatchObject({
        copy: null,
        refusal: { reason: 'branch-missing', branch: 'gone' },
      });
    });

    it('is the Project text while the config is kept in Cloudgate', async () => {
      const copy = await request(server)
        .get(`/environments/${productionId}/config`)
        .set('Cookie', cookie);

      expect(copy.status).toBe(200);
      expect(copy.body).toEqual({
        kind: 'cloudgate',
        environmentId: productionId,
      });
      expect(ctx.configReader.calls).toHaveLength(0);
    });
  });

  it('refuses a whole-YAML save once the config is kept in a repository', async () => {
    ctx.configReader.commit('acme/shop', DATA);
    await moveIn();

    const saved = await request(server)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text: DATA });

    expect(saved.status).toBe(409);
    expect(saved.body as { code: string; message: string }).toMatchObject({
      code: 'PROJECT_CONFIG_REPOSITORY_KEPT',
      message: expect.stringContaining('acme/shop') as string,
    });
  });

  it('keeps a Config branch per Environment, cleared back to the default branch', async () => {
    const set = await setConfigBranch(stagingId, 'staging');
    expect(set.status).toBe(200);
    expect((set.body as { configBranch: string | null }).configBranch).toBe(
      'staging',
    );
    const cleared = await setConfigBranch(stagingId, '');
    expect((cleared.body as { configBranch: string | null }).configBranch).toBe(
      null,
    );
    const refused = await setConfigBranch(stagingId, 'two words');
    expect(refused.status).toBe(400);
  });
});
