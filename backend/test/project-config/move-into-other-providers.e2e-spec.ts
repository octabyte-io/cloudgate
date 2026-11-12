import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  application,
  projectConfigLocation,
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
import { FETCH_CLIENT } from '../../src/git-providers/fetch.provider';
import type { FetchClient } from '../../src/git-providers/fetch.provider';
import { BitbucketService } from '../../src/git-providers/strategies/bitbucket/bitbucket.service';
import { GiteaService } from '../../src/git-providers/strategies/gitea/gitea.service';
import { GitlabService } from '../../src/git-providers/strategies/gitlab/gitlab.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
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
  commitSha: string | null;
  branch: string | null;
}

interface Preview {
  to: Record<string, unknown>;
  reads: Array<{
    environmentId: string;
    commitSha: string | null;
    textHash: string;
  }>;
  environments: Array<{
    environmentId: string;
    branch: string | null;
    commitSha: string | null;
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

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/**
 * What each provider's repository listing answers, for the connection
 * resolver of a plan-created Application: every connection reaches the
 * repository. The config itself is read through the harness's fake reader.
 */
const listings: FetchClient = (url: string | URL) => {
  const href = String(url);
  if (href.includes('/api/v4/projects?membership=true')) {
    return Promise.resolve(
      json(
        href.includes('page=1&')
          ? [
              {
                id: 42,
                name: 'shop',
                path_with_namespace: 'acme/platform/shop',
                namespace: {
                  path: 'platform',
                  full_path: 'acme/platform',
                  kind: 'group',
                },
                default_branch: 'main',
              },
            ]
          : [],
      ),
    );
  }
  if (href.includes('/api/v1/user/repos')) {
    return Promise.resolve(
      json([
        {
          id: 3,
          name: 'shop',
          owner: { login: 'acme' },
          html_url: 'https://gitea.example.com/acme/shop',
          default_branch: 'main',
        },
      ]),
    );
  }
  if (href.startsWith('https://api.bitbucket.org/2.0/repositories/acme?')) {
    return Promise.resolve(
      json({
        values: [
          {
            name: 'shop',
            slug: 'shop',
            links: { html: { href: 'https://bitbucket.org/acme/shop' } },
            workspace: { slug: 'acme' },
            mainbranch: { name: 'main' },
          },
        ],
        next: null,
      }),
    );
  }
  return Promise.resolve(new Response('unexpected', { status: 500 }));
};

type Ctx = Parameters<GitlabService['create']>[0];

/** Each provider: how a connection is made, the repository, and the strategy id column. */
const PROVIDERS = [
  {
    type: 'gitlab' as const,
    repository: 'acme/platform/shop',
    connect: (ctx: TestAppContext, as: Ctx, name: string) =>
      ctx.app
        .get(GitlabService)
        .create(as, {
          name,
          gitlabUrl: 'https://gitlab.example.com',
          applicationId: 'app',
          secret: 'secret',
          accessToken: 'glpat',
          refreshToken: 'glrt',
          groupName: 'acme',
          expiresAt: 2_000_000_000, // 2033: an integer column
        })
        .then((row) => ({
          gitProviderId: row.gitProvider.gitProviderId,
          id: row.gitlabId,
        })),
    connectionOf: (row: typeof application.$inferSelect) => row.gitlabId,
    branchOf: (row: typeof application.$inferSelect) => row.gitlabBranch,
  },
  {
    type: 'gitea' as const,
    repository: 'acme/shop',
    connect: (ctx: TestAppContext, as: Ctx, name: string) =>
      ctx.app
        .get(GiteaService)
        .create(as, {
          name,
          giteaUrl: 'https://gitea.example.com',
          accessToken: 'gta',
          expiresAt: 2_000_000_000, // 2033: an integer column
        })
        .then((row) => ({
          gitProviderId: row.gitProvider.gitProviderId,
          id: row.giteaId,
        })),
    connectionOf: (row: typeof application.$inferSelect) => row.giteaId,
    branchOf: (row: typeof application.$inferSelect) => row.giteaBranch,
  },
  {
    type: 'bitbucket' as const,
    repository: 'acme/shop',
    connect: (ctx: TestAppContext, as: Ctx, name: string) =>
      ctx.app
        .get(BitbucketService)
        .create(as, {
          name,
          bitbucketEmail: 'grace@example.com',
          apiToken: 'bb-token',
          bitbucketWorkspaceName: 'acme',
        })
        .then((row) => ({
          gitProviderId: row.gitProvider.gitProviderId,
          id: row.bitbucketId,
        })),
    connectionOf: (row: typeof application.$inferSelect) => row.bitbucketId,
    branchOf: (row: typeof application.$inferSelect) => row.bitbucketBranch,
  },
];

/**
 * A Project config moves into a GitLab, Gitea or Bitbucket repository
 * through the same preview and confirm as GitHub, each Environment
 * then reading it from its Config branch through the config reader port
 * (faked in memory by the harness). A plan-created Application building from
 * the config's own repository gets the config location's connection, even
 * when another connection of that type also reaches it.
 */
describe('Moving a Project config into a GitLab, Gitea or Bitbucket repository (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let cookie: string;
  let as: Ctx;
  let projectId: string;
  let productionId: string;
  let stagingId: string;

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

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: DEPLOYMENT_QUEUE, useValue: queue },
        { provide: RemoteExecService, useValue: execMock },
        {
          provide: RemoteDockerFactory,
          useValue: { getRemoteDocker: jest.fn().mockResolvedValue(docker) },
        },
        { provide: FETCH_CLIENT, useValue: listings },
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
    const userId = (res.body as { user: { id: string } }).user.id;
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', cookie);
    as = {
      user: { id: userId },
      session: { activeOrganizationId: (orgs.body as { id: string }[])[0].id },
    };

    const project = await request(server)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'shop' });
    expect(project.status).toBe(201);
    projectId = (project.body as { projectId: string }).projectId;
    productionId = await createEnvironment('production');
    stagingId = await createEnvironment('staging');
  });

  async function createEnvironment(name: string) {
    const created = await request(server)
      .post('/environments')
      .set('Cookie', cookie)
      .send({ name, projectId });
    expect(created.status).toBe(201);
    return (created.body as { environmentId: string }).environmentId;
  }

  const preview = (to: object) =>
    request(server)
      .post(`/projects/${projectId}/config/move/preview`)
      .set('Cookie', cookie)
      .send({ to });

  const confirm = (to: object, reads: Preview['reads']) =>
    request(server)
      .post(`/projects/${projectId}/config/move`)
      .set('Cookie', cookie)
      .send({ to, reads });

  describe.each(PROVIDERS)('a $type repository', (provider) => {
    const shop = `version: 1
services:
  shop:
    kind: web
    port: 8080
    source:
      ${provider.type}: ${provider.repository}
    build:
      type: dockerfile
`;

    it('is previewed and confirmed like a GitHub one, each Environment reading its own Config branch, and nothing applied', async () => {
      const { gitProviderId } = await provider.connect(ctx, as, 'Team');
      const mainSha = ctx.configReader.commit(provider.repository, shop);
      const stagingSha = ctx.configReader.commit(provider.repository, shop, {
        branch: 'staging',
      });
      await request(server)
        .patch(`/environments/${stagingId}`)
        .set('Cookie', cookie)
        .send({ configBranch: 'staging' });
      const to = {
        kind: 'repository',
        gitProviderId,
        repository: provider.repository,
      };

      const previewed = await preview(to);

      expect(previewed.status).toBe(200);
      const body = previewed.body as Preview;
      expect(body.to).toMatchObject({
        gitProviderId,
        repository: provider.repository,
        providerType: provider.type,
        connectionName: 'Team',
      });
      expect(
        body.environments.map((one) => [
          one.environmentId,
          one.branch,
          one.commitSha,
        ]),
      ).toEqual(
        expect.arrayContaining([
          [productionId, 'main', mainSha],
          [stagingId, 'staging', stagingSha],
        ]),
      );
      expect(ctx.configReader.calls.at(-1)?.connection).toEqual({
        gitProviderId,
        providerType: provider.type,
      });

      const confirmed = await confirm(to, body.reads);

      expect(confirmed.status).toBe(200);
      const plans = (confirmed.body as { plans: PlanBody[] }).plans;
      expect(plans.map((one) => [one.source, one.status])).toEqual([
        ['move', 'open'],
        ['move', 'open'],
      ]);
      const [location] = await ctx.db
        .select()
        .from(projectConfigLocation)
        .where(eq(projectConfigLocation.projectId, projectId));
      expect(location).toMatchObject({
        kind: 'repository',
        text: null,
        gitProviderId,
        repository: provider.repository,
      });
      expect(await ctx.db.select().from(application)).toHaveLength(0);
      expect(queue.jobs).toHaveLength(0);
    });

    it("gives a plan-created Application from the config's own repository the location's connection and the Config branch", async () => {
      await ctx.db
        .insert(webServerSettings)
        .values({ serverIp: '198.51.100.7' });
      // The config's connection is the older one; the newer also reaches
      // the repository, and the resolver would otherwise ask it first.
      const kept = await provider.connect(ctx, as, 'Config connection');
      const other = await provider.connect(ctx, as, 'Another connection');
      ctx.configReader.commit(provider.repository, shop);
      const to = {
        kind: 'repository',
        gitProviderId: kept.gitProviderId,
        repository: provider.repository,
      };
      const previewed = await preview(to);
      expect(previewed.status).toBe(200);
      const confirmed = await confirm(to, (previewed.body as Preview).reads);
      expect(confirmed.status).toBe(200);
      const open = (confirmed.body as { plans: PlanBody[] }).plans.find(
        (one) => one.environmentId === productionId,
      );

      const applied = await request(server)
        .post(`/environments/${productionId}/plan/apply`)
        .set('Cookie', cookie)
        .send({ planId: open?.planId });

      expect(applied.status).toBe(200);
      const [created] = await ctx.db
        .select()
        .from(application)
        .where(eq(application.environmentId, productionId));
      expect(created).toMatchObject({
        configName: 'shop',
        sourceType: provider.type,
      });
      expect(provider.connectionOf(created)).toBe(kept.id);
      expect(provider.connectionOf(created)).not.toBe(other.id);
      expect(provider.branchOf(created)).toBe('main');
    });
  });

  it('takes cloudgate.yml in a GitLab repository when no path is named and every Config branch has only it', async () => {
    const [gitlab] = PROVIDERS;
    const { gitProviderId } = await gitlab.connect(ctx, as, 'Team');
    const text = 'version: 1\nservices:\n  cache:\n    kind: redis\n';
    ctx.configReader.commit(gitlab.repository, text, { path: 'cloudgate.yml' });
    ctx.configReader.commit(gitlab.repository, text, {
      path: 'cloudgate.yml',
      branch: 'staging',
    });
    await request(server)
      .patch(`/environments/${stagingId}`)
      .set('Cookie', cookie)
      .send({ configBranch: 'staging' });
    const to = {
      kind: 'repository',
      gitProviderId,
      repository: gitlab.repository,
    };

    const previewed = await preview(to);

    expect(previewed.status).toBe(200);
    expect((previewed.body as Preview).to).toMatchObject({
      providerType: 'gitlab',
      path: 'cloudgate.yml',
    });
    expect(
      ctx.configReader.calls.filter((call) => call.path === 'cloudgate.yml'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          connection: { gitProviderId, providerType: 'gitlab' },
        }),
      ]),
    );

    const confirmed = await confirm(to, (previewed.body as Preview).reads);

    expect(confirmed.status).toBe(200);
    const [location] = await ctx.db
      .select()
      .from(projectConfigLocation)
      .where(eq(projectConfigLocation.projectId, projectId));
    expect(location).toMatchObject({
      kind: 'repository',
      gitProviderId,
      repository: gitlab.repository,
      path: 'cloudgate.yml',
    });
  });

  it('refuses a GitLab Config branch holding both names when no path is named, and stores nothing', async () => {
    const [gitlab] = PROVIDERS;
    const { gitProviderId } = await gitlab.connect(ctx, as, 'Team');
    const text = 'version: 1\nservices:\n  cache:\n    kind: redis\n';
    ctx.configReader.commit(gitlab.repository, text);
    ctx.configReader.commit(gitlab.repository, text, { path: 'cloudgate.yml' });

    const previewed = await preview({
      kind: 'repository',
      gitProviderId,
      repository: gitlab.repository,
    });

    expect(previewed.status).toBe(409);
    expect(previewed.body).toMatchObject({
      code: 'CONFIG_PATH_AMBIGUOUS',
      message: `Both cloudgate.yaml and cloudgate.yml are in ${gitlab.repository} on branch main; set Path to the one to use`,
    });
    const [location] = await ctx.db
      .select()
      .from(projectConfigLocation)
      .where(eq(projectConfigLocation.projectId, projectId));
    expect(location?.kind ?? 'cloudgate').toBe('cloudgate');
  });

  it('does not take a custom git URL as a config location', async () => {
    const { gitProviderId } = await PROVIDERS[0].connect(ctx, as, 'Team');

    const url = await preview({
      kind: 'repository',
      gitProviderId,
      repository: 'https://git.example.com/acme/shop.git',
    });
    const git = await preview({
      kind: 'git',
      url: 'https://git.example.com/acme/shop.git',
    });

    expect(url.status).toBe(400);
    expect(git.status).toBe(400);
    expect(ctx.configReader.calls).toHaveLength(0);
  });
});
