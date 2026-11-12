import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  application,
  deployment,
  domain,
  licenseKey,
  member,
  mysql,
  organizationRole,
  plan as planTable,
  postgres,
  projectConfigLocation,
  redis,
  server as serverTable,
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
import { parseProjectConfig } from '../../src/project-config';
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

interface StepResult {
  configName: string;
  action: string;
  status: 'applied' | 'failed';
  message: string | null;
  serviceType: string | null;
  serviceId: string | null;
  domain: string | null;
  deploy:
    | { status: 'queued'; deploymentId: string }
    | { status: 'started' }
    | { status: 'not-deployed'; message: string }
    | null;
}

interface PlanBody {
  planId: string;
  environmentId: string;
  status: string;
  steps: { action: string; configName: string }[];
  notes?: { kind: string; configName: string }[];
  results: StepResult[] | null;
  appliedBy: string | null;
  appliedAt: string | null;
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

/** Polls until the condition holds (a database deploy runs after the Apply answers). */
async function waitFor(condition: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
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

/**
 * An operator saves the whole YAML, which stores a plan per Environment
 * and applies nothing, then Applies a plan: creates, then changes, each step
 * through the per-kind create/update paths, Deployments queued and linked.
 * The deployment queue, the Swarm and the GitHub API are the boundaries.
 */
describe('Applying a Plan (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let cookie: string;
  let ownerId: string;
  let organizationId: string;
  let projectId: string;
  let environmentId: string;
  let stagingId: string;

  const queue = new ListQueue();
  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
    // A database deploy pulls its image as argv (`execOnServer`).
    execRemote: jest.fn(),
  };
  const docker = {
    getService: jest.fn(() => ({
      inspect: jest.fn().mockRejectedValue(new Error('no such service')),
      update: jest.fn(),
    })),
    createService: jest.fn().mockResolvedValue(undefined),
    listTasks: jest.fn().mockResolvedValue([{ Status: { State: 'running' } }]),
  };
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
              default_branch: 'trunk',
            },
          ])
        : Promise.resolve([{ name: 'trunk', commit: { sha: 'abc123' } }]),
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
    execMock.execRemote
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '' });

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

    environmentId = await createEnvironment('production');
    stagingId = await createEnvironment('staging');
  });

  async function createEnvironment(name: string, body: object = {}) {
    const created = await request(server)
      .post('/environments')
      .set('Cookie', cookie)
      .send({ name, projectId, ...body });
    expect(created.status).toBe(201);
    return (created.body as { environmentId: string }).environmentId;
  }

  /** The platform host's public address, which a generated Domain carries. */
  async function recordPlatformAddress(serverIp = '198.51.100.7') {
    await ctx.db.insert(webServerSettings).values({ serverIp });
  }

  const save = (text: string, as = cookie) =>
    request(server)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', as)
      .send({ text });

  const apply = (planId: string, environment = environmentId, as = cookie) =>
    request(server)
      .post(`/environments/${environment}/plan/apply`)
      .set('Cookie', as)
      .send({ planId });

  const askForPlan = (environment = environmentId) =>
    request(server)
      .post(`/environments/${environment}/plan`)
      .set('Cookie', cookie);

  /** Saves the text and answers the plan it stored for one Environment. */
  async function planFor(text: string, environment = environmentId) {
    const saved = await save(text);
    expect(saved.status).toBe(201);
    const plans = (saved.body as { plans: PlanBody[] }).plans;
    const found = plans.find((plan) => plan.environmentId === environment);
    expect(found).toBeDefined();
    return found as PlanBody;
  }

  async function storedText() {
    const [row] = await ctx.db
      .select({ text: projectConfigLocation.text })
      .from(projectConfigLocation)
      .where(eq(projectConfigLocation.projectId, projectId));
    return row.text;
  }

  const DATABASES = `version: 1
services:
  db:
    kind: postgres
    size: small
    version: "17"
  cache:
    kind: redis
`;

  describe('saving the YAML', () => {
    it('stores a plan per Environment and applies nothing', async () => {
      const before = await storedText();
      const saved = await save(DATABASES);

      expect(saved.status).toBe(201);
      const body = saved.body as { stored: boolean; plans: PlanBody[] };
      expect(body.stored).toBe(false);
      expect(body.plans.map((plan) => plan.environmentId).sort()).toEqual(
        [environmentId, stagingId].sort(),
      );
      for (const found of body.plans) {
        expect(found.status).toBe('open');
        // The text is the Project's, read through the Project.
        expect(found).not.toHaveProperty('text');
        // In the order the config lists them.
        expect(found.steps.map((step) => step.configName)).toEqual([
          'db',
          'cache',
        ]);
      }
      expect(await storedText()).toBe(before);
      expect(await ctx.db.select().from(postgres)).toHaveLength(0);
    });

    it('refuses a text that does not parse, storing no plan', async () => {
      const saved = await save(
        'version: 1\nservices:\n  db:\n    kind: postgres\n    colour: blue\n',
      );

      expect(saved.status).toBe(409);
      expect((saved.body as { code: string }).code).toBe('PLAN_REFUSED');
      expect(await ctx.db.select().from(planTable)).toHaveLength(0);
    });

    it('stores a text at once when no Environment has anything to change', async () => {
      const text = 'version: 1\n# nothing yet\nservices: {}\n';
      const saved = await save(text);

      expect(saved.status).toBe(201);
      expect((saved.body as { stored: boolean }).stored).toBe(true);
      expect(await storedText()).toBe(text);
    });
  });

  describe('applying', () => {
    it('creates the Services, records who applied it and when, and stores the text', async () => {
      const open = await planFor(DATABASES);

      const applied = await apply(open.planId);

      expect(applied.status).toBe(200);
      const body = applied.body as PlanBody;
      expect(body.status).toBe('applied');
      expect(body.appliedBy).toBe(ownerId);
      expect(body.appliedAt).not.toBeNull();
      expect(
        body.results?.map((result) => [result.configName, result.status]),
      ).toEqual([
        ['db', 'applied'],
        ['cache', 'applied'],
      ]);
      expect(await storedText()).toBe(DATABASES);

      const [db] = await ctx.db
        .select()
        .from(postgres)
        .where(eq(postgres.environmentId, environmentId));
      expect(db).toMatchObject({
        configName: 'db',
        dockerImage: 'postgres:17',
        // size: small is 0.5 CPU / 1 GB, as caps and never reservations.
        cpuLimit: '500000000',
        memoryLimit: '1073741824',
        cpuReservation: null,
        memoryReservation: null,
        serverId: null,
        configPlanId: open.planId,
      });
      // A password Cloudgate generated and keeps; the config has none.
      expect(db.databasePassword).toMatch(/^[a-z0-9]{16}$/);

      const [cache] = await ctx.db
        .select()
        .from(redis)
        .where(eq(redis.environmentId, environmentId));
      // No size: a plan-created Service starts uncapped.
      expect(cache).toMatchObject({ cpuLimit: null, memoryLimit: null });

      // A database's deploy writes no Deployment; it is started, and the
      // database's own status follows it.
      expect(body.results?.[0].deploy).toEqual({ status: 'started' });
      await waitFor(async () => {
        const [row] = await ctx.db
          .select({ status: postgres.applicationStatus })
          .from(postgres)
          .where(eq(postgres.postgresId, db.postgresId));
        return row.status === 'done';
      });

      // The other Environment's plan of the same text still applies.
      const staging = (
        (await ctx.db
          .select()
          .from(planTable)
          .where(
            and(
              eq(planTable.environmentId, stagingId),
              eq(planTable.status, 'open'),
            ),
          )) as PlanBody[]
      )[0];
      expect((await apply(staging.planId, stagingId)).status).toBe(200);
    });

    it('gives a plan-created web its git connection, default branch, Domain, placement and a queued Deployment', async () => {
      const [worker] = await ctx.db
        .insert(serverTable)
        .values({
          name: 'worker',
          ipAddress: '203.0.113.10',
          port: 22,
          serverType: 'deploy',
          organizationId,
        })
        .returning();
      const onServer = await createEnvironment('edge', {
        deployTarget: { kind: 'server', serverId: worker.serverId },
      });
      const ownerCtx = {
        user: { id: ownerId },
        session: { activeOrganizationId: organizationId },
      };
      const github = await ctx.app
        .get(GithubService)
        .create(ownerCtx, connection);

      const open = await planFor(
        `version: 1
services:
  shop:
    kind: web
    port: 8080
    source:
      github: acme/shop
    build:
      type: dockerfile
`,
        onServer,
      );
      expect(open.steps[0]).toMatchObject({
        action: 'create',
        placement: { kind: 'server', serverId: worker.serverId },
      });

      const applied = await apply(open.planId, onServer);

      expect(applied.status).toBe(200);
      const [result] = (applied.body as PlanBody).results ?? [];
      const [shop] = await ctx.db
        .select()
        .from(application)
        .where(eq(application.environmentId, onServer));
      expect(shop).toMatchObject({
        configName: 'shop',
        serverId: worker.serverId,
        sourceType: 'github',
        githubId: github.githubId,
        owner: 'acme',
        repository: 'shop',
        branch: 'trunk',
        port: 8080,
        buildType: 'dockerfile',
        configPlanId: open.planId,
        // A GPU reservation is Cloudgate's; a plan never sets one.
        gpus: 0,
      });

      const [generated] = await ctx.db
        .select()
        .from(domain)
        .where(eq(domain.applicationId, shop.applicationId));
      expect(generated.host).toMatch(/-203-0-113-10\.sslip\.io$/);
      expect(generated.port).toBe(8080);
      expect(result.domain).toBe(generated.host);

      const [queued] = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.applicationId, shop.applicationId));
      expect(queued.status).toBe('pending');
      expect(result.deploy).toEqual({
        status: 'queued',
        deploymentId: queued.deploymentId,
      });
      expect(queue.jobs.map((job) => job.data.deploymentId)).toEqual([
        queued.deploymentId,
      ]);
    });

    it('refuses the plan when no git provider connection reaches the repository', async () => {
      const saved = await save(`version: 1
services:
  shop:
    kind: web
    source:
      github: acme/elsewhere
`);

      expect(saved.status).toBe(409);
      expect((saved.body as { code: string; message: string }).code).toBe(
        'PLAN_REFUSED',
      );
      expect((saved.body as { message: string }).message).toContain(
        'acme/elsewhere',
      );
      expect(await ctx.db.select().from(planTable)).toHaveLength(0);
    });

    it('changes a Service: size sets the caps, an unlisted variable key is removed, and a Deployment is queued', async () => {
      const made = await request(server)
        .post('/applications')
        .set('Cookie', cookie)
        .send({ name: 'Shop', environmentId });
      const shopId = (made.body as { applicationId: string }).applicationId;
      await request(server)
        .patch(`/applications/${shopId}`)
        .set('Cookie', cookie)
        .send({
          sourceType: 'docker',
          dockerImage: 'nginx:1.27',
          memoryReservation: '268435456',
        })
        .expect(200);
      await request(server)
        .patch(`/applications/${shopId}/environment`)
        .set('Cookie', cookie)
        .send({ env: 'KEEP=1\nDROP="two\nlines"\nALSO=3' })
        .expect(200);

      const open = await planFor(`version: 1
services:
  shop:
    kind: web
    size: xsmall
    source:
      image: nginx:1.27
    env: [KEEP, ALSO]
`);
      expect(open.steps).toEqual([
        expect.objectContaining({ action: 'change', configName: 'shop' }),
      ]);

      const applied = await apply(open.planId);

      expect(applied.status).toBe(200);
      expect((applied.body as PlanBody).status).toBe('applied');
      const [shop] = await ctx.db
        .select()
        .from(application)
        .where(eq(application.applicationId, shopId));
      expect(shop).toMatchObject({
        cpuLimit: '250000000',
        memoryLimit: '536870912',
        // A reservation is Cloudgate's; a size never touches it.
        memoryReservation: '268435456',
        env: 'KEEP=1\nALSO=3',
        configPlanId: open.planId,
      });
      const queued = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.applicationId, shopId));
      expect(queued).toHaveLength(1);

      // Asked again, the config and the saved settings agree.
      expect(((await askForPlan()).body as PlanBody).status).toBe('unchanged');
    });

    it('leaves the caps alone when the config states no size', async () => {
      const made = await request(server)
        .post('/redis')
        .set('Cookie', cookie)
        .send({ name: 'cache', environmentId });
      expect(made.status).toBe(201);
      const cacheId = (made.body as { redisId: string }).redisId;
      await request(server)
        .patch(`/redis/${cacheId}`)
        .set('Cookie', cookie)
        .send({ cpuLimit: '2000000000', description: 'old' })
        .expect(200);

      const open = await planFor(`version: 1
services:
  cache:
    kind: redis
    description: sessions
`);
      expect((await apply(open.planId)).status).toBe(200);

      const [cache] = await ctx.db
        .select()
        .from(redis)
        .where(eq(redis.redisId, cacheId));
      expect(cache).toMatchObject({
        description: 'sessions',
        cpuLimit: '2000000000',
      });
    });

    it("neither sets nor resets an Application's GPU reservation, and reads no change in it", async () => {
      const made = await request(server)
        .post('/applications')
        .set('Cookie', cookie)
        .send({ name: 'Llama', environmentId });
      const llamaId = (made.body as { applicationId: string }).applicationId;
      // Written straight to the row: the save's check against the machine's
      // cards is `application-gpus.e2e-spec.ts`'s, not this file's.
      await ctx.db
        .update(application)
        .set({ gpus: 1 })
        .where(eq(application.applicationId, llamaId));

      const open = await planFor(`version: 1
services:
  llama:
    kind: web
    size: xsmall
    source:
      image: ollama/ollama:0.5
`);
      expect((await apply(open.planId)).status).toBe(200);

      const gpusOf = async () =>
        (
          await ctx.db
            .select({ gpus: application.gpus })
            .from(application)
            .where(eq(application.applicationId, llamaId))
        )[0].gpus;
      expect(await gpusOf()).toBe(1);

      // A different reservation is not a difference from the config.
      await ctx.db
        .update(application)
        .set({ gpus: 2 })
        .where(eq(application.applicationId, llamaId));
      expect(((await askForPlan()).body as PlanBody).status).toBe('unchanged');
      expect(await storedText()).not.toContain('gpu');
    });

    it('ends partly-applied when a step fails, and the next plan picks up what is left', async () => {
      // No platform address: a web on the platform host cannot get its Domain.
      const open = await planFor(`version: 1
services:
  db:
    kind: postgres
  shop:
    kind: web
    source:
      image: nginx:1.27
`);

      const applied = await apply(open.planId);

      expect(applied.status).toBe(200);
      const body = applied.body as PlanBody;
      expect(body.status).toBe('partly-applied');
      expect(
        body.results?.map((result) => [result.configName, result.status]),
      ).toEqual([
        ['db', 'applied'],
        ['shop', 'failed'],
      ]);
      expect(body.results?.[1].message).toMatch(/address/i);
      expect(await ctx.db.select().from(application)).toHaveLength(0);

      await recordPlatformAddress();
      const next = (await askForPlan()).body as PlanBody;
      expect(next.steps).toEqual([
        expect.objectContaining({ action: 'create', configName: 'shop' }),
      ]);
      const retried = await apply(next.planId);
      expect((retried.body as PlanBody).status).toBe('applied');
      expect((retried.body as PlanBody).results?.[0].domain).toMatch(
        /-198-51-100-7\.sslip\.io$/,
      );
    });

    it('runs creates before changes', async () => {
      await recordPlatformAddress();
      await request(server)
        .post('/redis')
        .set('Cookie', cookie)
        .send({ name: 'cache', environmentId })
        .expect(201);

      const open = await planFor(`version: 1
services:
  cache:
    kind: redis
    version: "7"
  db:
    kind: postgres
`);
      const body = (await apply(open.planId)).body as PlanBody;

      expect(
        body.results?.map((result) => [result.action, result.configName]),
      ).toEqual([
        ['create', 'db'],
        ['change', 'cache'],
      ]);
    });
  });

  describe('refusals', () => {
    it('refuses a plan whose saved settings have moved on', async () => {
      const made = await request(server)
        .post('/redis')
        .set('Cookie', cookie)
        .send({ name: 'cache', environmentId });
      const cacheId = (made.body as { redisId: string }).redisId;
      const open = await planFor(`version: 1
services:
  cache:
    kind: redis
    version: "7"
`);
      await request(server)
        .patch(`/redis/${cacheId}`)
        .set('Cookie', cookie)
        .send({ description: 'edited in the console' })
        .expect(200);

      const applied = await apply(open.planId);

      expect(applied.status).toBe(409);
      expect((applied.body as { code: string }).code).toBe('PLAN_STALE');
      const [cache] = await ctx.db.select().from(redis);
      expect(cache.dockerImage).toBe('redis:8');
    });

    it('refuses a plan whose stored text has moved on', async () => {
      const open = await planFor(DATABASES);
      // Another edit lands on the stored text after this plan was made.
      await ctx.db
        .update(projectConfigLocation)
        .set({ text: 'version: 1\n# edited\nservices: {}\n' })
        .where(eq(projectConfigLocation.projectId, projectId));

      const applied = await apply(open.planId);

      expect(applied.status).toBe(409);
      expect((applied.body as { code: string }).code).toBe('PLAN_STALE');
      expect(await ctx.db.select().from(postgres)).toHaveLength(0);
    });

    it('refuses the whole Apply up front when a step needs a statement the caller lacks', async () => {
      const made = await request(server)
        .post('/redis')
        .set('Cookie', cookie)
        .send({ name: 'cache', environmentId });
      const cacheId = (made.body as { redisId: string }).redisId;
      const open = await planFor(`version: 1
services:
  cache:
    kind: redis
    version: "7"
  db:
    kind: postgres
`);
      // A built-in member holds service: read/update, not create.
      const fixture = await signUpMember(server, cookie);
      await ctx.db
        .update(member)
        .set({
          accessedProjects: [projectId],
          accessedEnvironments: [environmentId],
          accessedServices: [cacheId],
        })
        .where(eq(member.userId, fixture.id));

      const applied = await apply(open.planId, environmentId, fixture.cookie);

      expect(applied.status).toBe(403);
      expect(await ctx.db.select().from(postgres)).toHaveLength(0);
      const [cache] = await ctx.db.select().from(redis);
      expect(cache.dockerImage).toBe('redis:8');
      const [still] = await ctx.db
        .select({ status: planTable.status })
        .from(planTable)
        .where(eq(planTable.planId, open.planId));
      expect(still.status).toBe('open');
    });

    it('creates a web and its generated Domain without domain: create, which an Apply never needs', async () => {
      await recordPlatformAddress();
      const fixture = await signUpMember(server, cookie);
      await ctx.db.insert(licenseKey).values({
        organizationId,
        key: 'test-license-key',
        status: 'active',
        enableEnterpriseFeatures: true,
      });
      await ctx.db.insert(organizationRole).values({
        organizationId,
        role: 'applier',
        permission: {
          environment: ['read'],
          service: ['create', 'read'],
          deployment: ['create'],
        },
      });
      await ctx.db
        .update(member)
        .set({
          role: 'applier',
          accessedProjects: [projectId],
          accessedEnvironments: [environmentId, stagingId],
        })
        .where(eq(member.userId, fixture.id));
      const open = await planFor(`version: 1
services:
  site:
    kind: web
    source:
      image: nginx:1
`);

      const applied = await apply(open.planId, environmentId, fixture.cookie);

      expect(applied.status).toBe(200);
      expect((applied.body as PlanBody).status).toBe('applied');
      const [site] = await ctx.db
        .select()
        .from(application)
        .where(eq(application.environmentId, environmentId));
      const domains = await ctx.db
        .select()
        .from(domain)
        .where(eq(domain.applicationId, site.applicationId));
      expect(domains).toHaveLength(1);
      expect(domains[0].host).toMatch(/\.sslip\.io$/);
    });

    it('creates a worker with the Application statements alone: recorded as a worker, with no Domain, and its Build deployment queued', async () => {
      // An address a `web` would be given an sslip.io Domain at.
      await recordPlatformAddress();
      const fixture = await signUpMember(server, cookie);
      await ctx.db.insert(licenseKey).values({
        organizationId,
        key: 'test-license-key',
        status: 'active',
        enableEnterpriseFeatures: true,
      });
      await ctx.db.insert(organizationRole).values({
        organizationId,
        role: 'applier',
        permission: {
          environment: ['read'],
          service: ['create', 'read'],
          deployment: ['create'],
        },
      });
      await ctx.db
        .update(member)
        .set({
          role: 'applier',
          accessedProjects: [projectId],
          accessedEnvironments: [environmentId, stagingId],
        })
        .where(eq(member.userId, fixture.id));
      const open = await planFor(`version: 1
services:
  jobs:
    kind: worker
    command: node
    args: [worker.js]
    source:
      image: acme/jobs:1
`);
      expect(open.steps).toEqual([
        expect.objectContaining({
          action: 'create',
          configName: 'jobs',
          kind: 'worker',
        }),
      ]);

      const applied = await apply(open.planId, environmentId, fixture.cookie);

      expect(applied.status).toBe(200);
      expect((applied.body as PlanBody).status).toBe('applied');
      const [result] = (applied.body as PlanBody).results ?? [];
      expect(result.domain).toBeNull();
      const [jobs] = await ctx.db
        .select()
        .from(application)
        .where(eq(application.environmentId, environmentId));
      expect(jobs).toMatchObject({
        configName: 'jobs',
        configKind: 'worker',
        sourceType: 'docker',
        dockerImage: 'acme/jobs:1',
        command: 'node',
        args: ['worker.js'],
        configPlanId: open.planId,
      });
      expect(
        await ctx.db
          .select()
          .from(domain)
          .where(eq(domain.applicationId, jobs.applicationId)),
      ).toEqual([]);
      const [queued] = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.applicationId, jobs.applicationId));
      expect(queued.status).toBe('pending');
      expect(result.deploy).toEqual({
        status: 'queued',
        deploymentId: queued.deploymentId,
      });
      expect(queue.jobs.map((job) => job.data.deploymentId)).toEqual([
        queued.deploymentId,
      ]);

      // Applied, the worker plans nothing more.
      const again = await askForPlan();
      expect((again.body as PlanBody).steps).toEqual([]);
    });

    it('refuses a plan that is no longer open', async () => {
      const open = await planFor(DATABASES);
      expect((await apply(open.planId)).status).toBe(200);

      const again = await apply(open.planId);
      expect(again.status).toBe(409);
      expect((again.body as { code: string }).code).toBe('PLAN_NOT_OPEN');
    });
  });

  describe('native.docker', () => {
    const NATIVE = `version: 1
services:
  shop:
    kind: web
    source:
      image: nginx:1.27
    native:
      docker:
        HealthCheck:
          Test: [CMD, "true"]
          Retries: 5
        UpdateConfig:
          Delay: 5000000000
`;
    const PLAIN = `version: 1
services:
  shop:
    kind: web
    source:
      image: nginx:1.27
`;

    async function makeShop() {
      const made = await request(server)
        .post('/applications')
        .set('Cookie', cookie)
        .send({ name: 'Shop', environmentId });
      const shopId = (made.body as { applicationId: string }).applicationId;
      await request(server)
        .patch(`/applications/${shopId}`)
        .set('Cookie', cookie)
        .send({ sourceType: 'docker', dockerImage: 'nginx:1.27' })
        .expect(200);
      return shopId;
    }

    const swarmOf = async (shopId: string) =>
      (
        await ctx.db
          .select({
            healthCheckSwarm: application.healthCheckSwarm,
            updateConfigSwarm: application.updateConfigSwarm,
          })
          .from(application)
          .where(eq(application.applicationId, shopId))
      )[0];

    it('plans native lines, writes the Swarm columns, plans nothing next, and puts a removed key back to the default', async () => {
      const shopId = await makeShop();

      const open = await planFor(NATIVE);
      expect(open.steps).toEqual([
        expect.objectContaining({
          action: 'change',
          configName: 'shop',
          fields: expect.arrayContaining([
            expect.objectContaining({
              field: 'native.docker.HealthCheck.Retries',
              to: 5,
              native: true,
            }),
            expect.objectContaining({
              field: 'native.docker.UpdateConfig.Delay',
              to: 5_000_000_000,
              native: true,
            }),
          ]) as unknown,
        }),
      ]);
      const applied = await apply(open.planId);
      expect(applied.status).toBe(200);
      expect((applied.body as PlanBody).status).toBe('applied');
      expect(await swarmOf(shopId)).toEqual({
        healthCheckSwarm: { Test: ['CMD', 'true'], Retries: 5 },
        // Cloudgate's other update fields are kept, not replaced.
        updateConfigSwarm: {
          Parallelism: 1,
          Order: 'start-first',
          FailureAction: 'rollback',
          Delay: 5_000_000_000,
        },
      });
      expect(((await askForPlan()).body as PlanBody).status).toBe('unchanged');

      const removed = await planFor(PLAIN);
      expect(removed.steps).toEqual([
        expect.objectContaining({
          fields: expect.arrayContaining([
            expect.objectContaining({
              field: 'native.docker.HealthCheck.Retries',
              from: 5,
              to: null,
              native: true,
              toDefault: true,
            }),
          ]) as unknown,
        }),
      ]);
      expect((await apply(removed.planId)).status).toBe(200);
      expect(await swarmOf(shopId)).toEqual({
        healthCheckSwarm: null,
        updateConfigSwarm: null,
      });
      expect(((await askForPlan()).body as PlanBody).status).toBe('unchanged');
    });

    it('lets a Member with service update apply a native change, with no statement of its own', async () => {
      const shopId = await makeShop();
      const open = await planFor(NATIVE);
      // A built-in member holds service: read/update.
      const fixture = await signUpMember(server, cookie);
      await ctx.db
        .update(member)
        .set({
          accessedProjects: [projectId],
          accessedEnvironments: [environmentId],
          accessedServices: [shopId],
        })
        .where(eq(member.userId, fixture.id));

      const applied = await apply(open.planId, environmentId, fixture.cookie);

      expect(applied.status).toBe(200);
      expect((await swarmOf(shopId)).healthCheckSwarm).toEqual({
        Test: ['CMD', 'true'],
        Retries: 5,
      });
    });

    it('refuses a locked label by its full path, storing no plan', async () => {
      await makeShop();
      const saved = await save(`version: 1
services:
  shop:
    kind: web
    native:
      docker:
        Labels:
          traefik.http.routers.x.rule: "Host(\`victim.example.com\`)"
`);
      expect(saved.status).toBe(409);
      expect((saved.body as { code: string }).code).toBe('PLAN_REFUSED');
      expect(JSON.stringify(saved.body)).toContain(
        'shop.native.docker.Labels.\\"traefik.http.routers.x.rule\\": refused - ',
      );
      expect(await ctx.db.select().from(planTable)).toHaveLength(0);
    });
  });

  describe('a mysql entry', () => {
    const MYSQL = 'version: 1\nservices:\n  shop-db:\n    kind: mysql\n';

    async function onServer() {
      const [worker] = await ctx.db
        .insert(serverTable)
        .values({
          name: 'worker',
          ipAddress: '203.0.113.10',
          port: 22,
          serverType: 'deploy',
          organizationId,
        })
        .returning();
      const edgeId = await createEnvironment('edge', {
        deployTarget: { kind: 'server', serverId: worker.serverId },
      });
      return { serverId: worker.serverId, edgeId };
    }

    const mysqlRows = (environment: string) =>
      ctx.db.select().from(mysql).where(eq(mysql.environmentId, environment));

    const deployed = (environment: string) =>
      waitFor(async () => {
        const [row] = await mysqlRows(environment);
        return row.applicationStatus === 'done';
      });

    it("creates a MySQL on the Environment's Server, running mysql:8.4 with the defaulted database and user and generated passwords; then changes it in place, and destroys it under the name confirmation", async () => {
      const { serverId, edgeId } = await onServer();

      const open = await planFor(MYSQL, edgeId);
      expect(open.steps).toEqual([
        expect.objectContaining({
          action: 'create',
          configName: 'shop-db',
          kind: 'mysql',
        }),
      ]);
      const applied = await apply(open.planId, edgeId);
      expect(applied.status).toBe(200);
      expect((applied.body as PlanBody).results).toEqual([
        expect.objectContaining({
          configName: 'shop-db',
          status: 'applied',
          serviceType: 'mysql',
          deploy: { status: 'started' },
        }),
      ]);

      const [created] = await mysqlRows(edgeId);
      expect(created).toMatchObject({
        configName: 'shop-db',
        name: 'shop-db',
        serverId,
        dockerImage: 'mysql:8.4',
        databaseName: 'shop_db',
        databaseUser: 'shop_db',
        cpuLimit: null,
        memoryLimit: null,
        configPlanId: open.planId,
      });
      // Both passwords are Cloudgate's; the config holds neither.
      expect(created.databasePassword).toMatch(/^[a-z0-9]{16}$/);
      expect(created.databaseRootPassword).toMatch(/^[a-z0-9]{16}$/);
      expect(created.databaseRootPassword).not.toBe(created.databasePassword);
      await deployed(edgeId);

      // version, size and env: a change in place, the same Service.
      const changed = await planFor(
        `${MYSQL}    version: "9.1"\n    size: small\n`,
        edgeId,
      );
      expect(changed.steps).toEqual([
        expect.objectContaining({
          action: 'change',
          configName: 'shop-db',
          kind: 'mysql',
          serviceId: created.mysqlId,
        }),
      ]);
      expect((await apply(changed.planId, edgeId)).status).toBe(200);
      const [after] = await mysqlRows(edgeId);
      expect(after).toMatchObject({
        mysqlId: created.mysqlId,
        appName: created.appName,
        dockerImage: 'mysql:9.1',
        cpuLimit: '500000000',
        memoryLimit: '1073741824',
        databaseName: 'shop_db',
        databaseUser: 'shop_db',
        databasePassword: created.databasePassword,
        databaseRootPassword: created.databaseRootPassword,
        configPlanId: changed.planId,
      });
      await deployed(edgeId);

      // Removing the entry is a destroy, under the usual confirmation.
      const removed = await planFor('version: 1\nservices: {}\n', edgeId);
      expect(removed.steps).toEqual([
        expect.objectContaining({ action: 'destroy', configName: 'shop-db' }),
      ]);
      const unconfirmed = await apply(removed.planId, edgeId);
      expect(unconfirmed.status).toBe(409);
      expect((unconfirmed.body as { code: string }).code).toBe(
        'PLAN_DESTROY_NOT_CONFIRMED',
      );
      expect(await mysqlRows(edgeId)).toHaveLength(1);

      const confirmed = await request(server)
        .post(`/environments/${edgeId}/plan/apply`)
        .set('Cookie', cookie)
        .send({ planId: removed.planId, confirmDestroy: ['shop-db'] });
      expect(confirmed.status).toBe(200);
      expect((confirmed.body as PlanBody).results).toEqual([
        expect.objectContaining({
          action: 'destroy',
          configName: 'shop-db',
          status: 'applied',
        }),
      ]);
      expect(await mysqlRows(edgeId)).toHaveLength(0);
    });

    it('creates the database and user it is told, root included', async () => {
      const { edgeId } = await onServer();
      const open = await planFor(
        `${MYSQL}    version: "8.0"\n    database: shop\n    user: root\n`,
        edgeId,
      );

      expect((await apply(open.planId, edgeId)).status).toBe(200);
      expect((await mysqlRows(edgeId))[0]).toMatchObject({
        dockerImage: 'mysql:8.0',
        databaseName: 'shop',
        databaseUser: 'root',
      });
      await deployed(edgeId);
    });

    it('hands a console-made MySQL over once managed: console is removed: a change in place that keeps its database, user, data volume and passwords', async () => {
      const { serverId, edgeId } = await onServer();
      const made = await request(server)
        .post('/mysql')
        .set('Cookie', cookie)
        .send({
          name: 'shop-db',
          databaseName: 'legacy',
          databaseUser: 'root',
          dockerImage: 'mysql:8',
          environmentId: edgeId,
          serverId,
        });
      expect(made.status).toBe(201);
      const [before] = await mysqlRows(edgeId);
      expect(before).toMatchObject({
        configName: 'shop-db',
        configPlanId: null,
      });
      // The console Save listed it as console-managed, as it does every MySQL.
      expect(parseProjectConfig((await storedText()) ?? '')).toMatchObject({
        ok: true,
        config: {
          services: { 'shop-db': { kind: 'mysql', managed: 'console' } },
        },
      });

      // No version written: the create default, so 8 → 8.4 and nothing else.
      const open = await planFor(MYSQL, edgeId);
      expect(open.steps).toEqual([
        {
          action: 'change',
          configName: 'shop-db',
          kind: 'mysql',
          serviceType: 'mysql',
          serviceId: before.mysqlId,
          name: 'shop-db',
          fields: [{ field: 'version', from: 'mysql:8', to: 'mysql:8.4' }],
        },
      ]);
      expect(open.notes).toEqual([]);
      docker.createService.mockClear();

      const applied = await apply(open.planId, edgeId);
      expect(applied.status).toBe(200);
      expect((applied.body as PlanBody).results).toEqual([
        expect.objectContaining({
          action: 'change',
          configName: 'shop-db',
          status: 'applied',
          deploy: { status: 'started' },
        }),
      ]);
      // The redeploy mounts the same data volume.
      await waitFor(() =>
        Promise.resolve(docker.createService.mock.calls.length > 0),
      );
      expect(JSON.stringify(docker.createService.mock.calls)).toContain(
        `"${before.appName}-data"`,
      );
      await deployed(edgeId);

      const [after] = await mysqlRows(edgeId);
      expect(after).toMatchObject({
        mysqlId: before.mysqlId,
        appName: before.appName,
        dockerImage: 'mysql:8.4',
        databaseName: 'legacy',
        databaseUser: 'root',
        databasePassword: before.databasePassword,
        databaseRootPassword: before.databaseRootPassword,
        configPlanId: open.planId,
        applicationStatus: 'done',
      });
      // Writing the version it now runs has nothing left to change.
      const pinned = await planFor(`${MYSQL}    version: "8.4"\n`, edgeId);
      expect(pinned.steps).toEqual([]);
    });

    it('plans nothing for a handed-over mysql:8 MySQL whose entry writes version: "8"', async () => {
      await ctx.db.insert(mysql).values({
        name: 'shop-db',
        configName: 'shop-db',
        databaseName: 'shop',
        databaseUser: 'shop',
        databasePassword: 'secret',
        databaseRootPassword: 'root-secret',
        dockerImage: 'mysql:8',
        environmentId,
      });

      const open = await planFor(`${MYSQL}    version: "8"\n`);

      expect(open.steps).toEqual([]);
      expect(open.status).toBe('unchanged');
    });

    it('refuses a mysql whose defaulted user would pass 32 characters, asking for user:', async () => {
      const name = `orders-${'a'.repeat(26)}`;
      const saved = await save(
        `version: 1\nservices:\n  ${name}:\n    kind: mysql\n`,
      );

      expect(saved.status).toBe(409);
      expect((saved.body as { code: string }).code).toBe('PLAN_REFUSED');
      expect(JSON.stringify(saved.body)).toContain(`${name}.user`);
      expect(await ctx.db.select().from(mysql)).toHaveLength(0);
    });
  });

  describe('a postgres user', () => {
    it('creates pg-1 with no user: as user app_pg_1 on database pg_1, since PostgreSQL reserves pg_1 as a role', async () => {
      const open = await planFor(
        'version: 1\nservices:\n  pg-1:\n    kind: postgres\n',
      );

      expect((await apply(open.planId)).status).toBe(200);
      const [created] = await ctx.db
        .select()
        .from(postgres)
        .where(eq(postgres.environmentId, environmentId));
      expect(created).toMatchObject({
        configName: 'pg-1',
        databaseName: 'pg_1',
        databaseUser: 'app_pg_1',
      });
    });

    it('refuses a written user: pg_admin, storing no plan and creating nothing', async () => {
      const saved = await save(
        'version: 1\nservices:\n  pg-1:\n    kind: postgres\n    user: pg_admin\n',
      );

      expect(saved.status).toBe(409);
      expect((saved.body as { code: string }).code).toBe('PLAN_REFUSED');
      expect(JSON.stringify(saved.body)).toContain(
        'pg-1.user: PostgreSQL reserves role names starting with pg_; choose another user:',
      );
      expect(await ctx.db.select().from(planTable)).toHaveLength(0);
      expect(await ctx.db.select().from(postgres)).toHaveLength(0);
    });
  });
});
