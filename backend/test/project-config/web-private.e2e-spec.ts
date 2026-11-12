import type Docker from 'dockerode';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { ApplicationsService } from '../../src/applications/applications.service';
import {
  application,
  deployment,
  domain,
  licenseKey,
  member,
  organizationRole,
  port,
  previewDeployment,
  webServerSettings,
} from '../../src/db/schema';
import { mechanizeDockerContainer } from '../../src/deployment-engine/mechanize';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import type { DeploymentJob } from '../../src/deployment-queue/job-types';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import type {
  JobState,
  QueuedJob,
  QueuePort,
} from '../../src/deployment-queue/queue.port';
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
  status: string;
  steps: { action: string; configName: string; kind: string }[];
  results:
    | {
        configName: string;
        action: string;
        status: string;
        serviceId: string | null;
        domain: string | null;
        deploy: { status: string } | null;
      }[]
    | null;
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

const API = `version: 1
services:
  api:
    kind: web-private
    port: 4000
    source:
      image: nginx:1.27
`;

/**
 * A `web-private` is an Application other Services on its Server reach
 * at its internal address, `http://<appName>:<port>`, and nothing outside
 * can. A plan creates it with no Domain; the API refuses a Domain, a
 * published port and previews on it; a kind change to or from `web` is a
 * destroy and a create. The queue, the Swarm and the machines are the
 * boundaries.
 */
describe('A web-private Service (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let cookie: string;
  let organizationId: string;
  let projectId: string;
  let environmentId: string;

  const queue = new ListQueue();
  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  };
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
    docker.createService.mockClear();
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

    const created = await request(server)
      .post('/environments')
      .set('Cookie', cookie)
      .send({ name: 'production', projectId });
    expect(created.status).toBe(201);
    environmentId = (created.body as { environmentId: string }).environmentId;
    // The platform host's public address, which a `web`'s generated Domain
    // carries; a web-private's create must not need it, but a `web` does.
    await ctx.db.insert(webServerSettings).values({ serverIp: '198.51.100.7' });
  });

  const send = (
    method: 'post' | 'patch' | 'get',
    path: string,
    body?: object,
    as = cookie,
  ) => request(server)[method](path).set('Cookie', as).send(body);

  async function planFor(text: string) {
    const saved = await send('post', `/projects/${projectId}/config/plans`, {
      text,
    });
    expect(saved.status).toBe(201);
    const found = (saved.body as { plans: PlanBody[] }).plans.find(
      (plan) => plan.environmentId === environmentId,
    );
    expect(found).toBeDefined();
    return found as PlanBody;
  }

  const apply = (planId: string, confirmDestroy?: string[], as = cookie) =>
    send(
      'post',
      `/environments/${environmentId}/plan/apply`,
      confirmDestroy === undefined ? { planId } : { planId, confirmDestroy },
      as,
    );

  /** The config's `api` planned and applied; answers its Application row. */
  async function appliedApi() {
    const open = await planFor(API);
    const applied = await apply(open.planId);
    expect(applied.status).toBe(200);
    expect((applied.body as PlanBody).status).toBe('applied');
    const [api] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.environmentId, environmentId));
    return api;
  }

  const codeOf = (res: request.Response) =>
    (res.body as { code?: string }).code;
  const messageOf = (res: request.Response) =>
    (res.body as { message: string }).message;

  describe('a plan that creates one', () => {
    it('creates an Application recorded as web-private, with no Domain, a queued Build and its internal address', async () => {
      const open = await planFor(API);
      expect(open.steps).toEqual([
        expect.objectContaining({
          action: 'create',
          configName: 'api',
          kind: 'web-private',
        }),
      ]);

      const applied = await apply(open.planId);

      expect(applied.status).toBe(200);
      const [result] = (applied.body as PlanBody).results ?? [];
      expect(result).toMatchObject({ status: 'applied', domain: null });
      expect(result.deploy).toMatchObject({ status: 'queued' });

      const [api] = await ctx.db
        .select()
        .from(application)
        .where(eq(application.environmentId, environmentId));
      expect(api).toMatchObject({
        configName: 'api',
        configKind: 'web-private',
        port: 4000,
        sourceType: 'docker',
        dockerImage: 'nginx:1.27',
        isPreviewDeploymentsActive: false,
        requestedPreviewsAllowed: false,
      });
      expect(
        await ctx.db
          .select()
          .from(domain)
          .where(eq(domain.applicationId, api.applicationId)),
      ).toEqual([]);
      const [queued] = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.applicationId, api.applicationId));
      expect(queued.status).toBe('pending');

      const read = await send('get', `/applications/${api.applicationId}`);
      expect(read.status).toBe(200);
      expect((read.body as { internalAddress: string }).internalAddress).toBe(
        `http://${api.appName}:4000`,
      );

      // The next plan of the same text has nothing to change.
      expect((await planFor(API)).steps).toEqual([]);
    });

    it('releases it on the shared overlay network every Application joins, with no published port', async () => {
      const api = await appliedApi();
      const deployable = await ctx.app
        .get(ApplicationsService)
        .findDeployable(api.applicationId);

      await mechanizeDockerContainer(deployable, docker as unknown as Docker);

      expect(docker.createService).toHaveBeenCalledTimes(1);
      const [spec] = docker.createService.mock.calls[0] as unknown as [
        {
          Name: string;
          TaskTemplate: { Networks: { Target: string }[] };
          EndpointSpec?: unknown;
        },
      ];
      // Swarm's DNS resolves the service name on that network, which is
      // what makes `http://<appName>:<port>` the internal address.
      expect(spec.Name).toBe(api.appName);
      expect(spec.TaskTemplate.Networks).toContainEqual({
        Target: 'cloudgate-network',
      });
      expect(spec).not.toHaveProperty('EndpointSpec');
    });

    it('is applied on the Application statements a plan already uses, with no domain: create', async () => {
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
          accessedEnvironments: [environmentId],
        })
        .where(eq(member.userId, fixture.id));
      const open = await planFor(API);

      const applied = await apply(open.planId, undefined, fixture.cookie);

      expect(applied.status).toBe(200);
      expect((applied.body as PlanBody).status).toBe('applied');
      const rows = await ctx.db
        .select({ configKind: application.configKind })
        .from(application);
      expect(rows).toEqual([{ configKind: 'web-private' }]);
    });
  });

  describe('what it refuses, through the API', () => {
    it('refuses a Domain, naming the way out, and stores none', async () => {
      const api = await appliedApi();

      const res = await send('post', '/domains', {
        host: 'api.example.com',
        applicationId: api.applicationId,
        domainType: 'application',
        port: 4000,
      });

      expect(res.status).toBe(409);
      expect(codeOf(res)).toBe('KIND_TAKES_NO_DOMAIN');
      expect(messageOf(res)).toContain('change its kind to web');
      expect(await ctx.db.select().from(domain)).toEqual([]);
    });

    it('refuses a published port, as a Port or in the Swarm endpoint spec, and stores neither', async () => {
      const api = await appliedApi();

      const added = await send('post', '/ports', {
        applicationId: api.applicationId,
        publishedPort: 8080,
        targetPort: 4000,
      });
      expect(added.status).toBe(409);
      expect(codeOf(added)).toBe('KIND_PUBLISHES_NO_PORT');
      expect(await ctx.db.select().from(port)).toEqual([]);

      const spec = await send('patch', `/applications/${api.applicationId}`, {
        endpointSpecSwarm: {
          Ports: [{ TargetPort: 4000, PublishedPort: 8080 }],
        },
      });
      expect(spec.status).toBe(409);
      expect(codeOf(spec)).toBe('KIND_PUBLISHES_NO_PORT');
      const [row] = await ctx.db
        .select({ endpointSpecSwarm: application.endpointSpecSwarm })
        .from(application)
        .where(eq(application.applicationId, api.applicationId));
      expect(row.endpointSpecSwarm).toBeNull();
    });

    it.each(['isPreviewDeploymentsActive', 'requestedPreviewsAllowed'])(
      'refuses switching %s on, and lets it be switched off',
      async (flag) => {
        const api = await appliedApi();

        const on = await send('patch', `/applications/${api.applicationId}`, {
          [flag]: true,
        });
        expect(on.status).toBe(409);
        expect(codeOf(on)).toBe('KIND_TAKES_NO_PREVIEWS');

        const off = await send('patch', `/applications/${api.applicationId}`, {
          [flag]: false,
        });
        expect(off.status).toBe(200);
      },
    );

    it('refuses a requested preview even where the switch was left on, and creates none', async () => {
      const api = await appliedApi();
      // Written past the API, which refuses it: the kind is what refuses.
      await ctx.db
        .update(application)
        .set({ requestedPreviewsAllowed: true })
        .where(eq(application.applicationId, api.applicationId));

      const res = await send(
        'post',
        `/applications/${api.applicationId}/preview-deployments`,
        { branch: 'feature' },
      );

      expect(res.status).toBe(409);
      expect(codeOf(res)).toBe('KIND_TAKES_NO_PREVIEWS');
      expect(await ctx.db.select().from(previewDeployment)).toEqual([]);
    });

    it('leaves a web as it was: its Domain, port and preview switch are taken', async () => {
      const made = await send('post', '/applications', {
        name: 'site',
        environmentId,
      });
      expect(made.status).toBe(201);
      const id = (made.body as { applicationId: string }).applicationId;

      expect(
        (
          await send('post', '/ports', {
            applicationId: id,
            publishedPort: 8080,
            targetPort: 3000,
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await send('patch', `/applications/${id}`, {
            isPreviewDeploymentsActive: true,
          })
        ).status,
      ).toBe(200);
      const read = await send('get', `/applications/${id}`);
      expect((read.body as { internalAddress: unknown }).internalAddress).toBe(
        null,
      );
    });
  });

  describe('a kind change', () => {
    it('plans web to web-private as a destroy plus a create, confirmed by name, and its Domain goes with it', async () => {
      const web = await planFor(API.replace('web-private', 'web'));
      expect((await apply(web.planId)).status).toBe(200);
      expect(await ctx.db.select().from(domain)).toHaveLength(1);

      const open = await planFor(API);
      expect(open.steps.map((step) => [step.action, step.kind])).toEqual([
        ['destroy', 'web'],
        ['create', 'web-private'],
      ]);
      const refused = await apply(open.planId);
      expect(refused.status).toBe(409);
      expect(codeOf(refused)).toBe('PLAN_DESTROY_NOT_CONFIRMED');

      const applied = await apply(open.planId, ['api']);

      expect(applied.status).toBe(200);
      expect((applied.body as PlanBody).status).toBe('applied');
      expect(
        await ctx.db
          .select({
            configName: application.configName,
            configKind: application.configKind,
          })
          .from(application),
      ).toEqual([{ configName: 'api', configKind: 'web-private' }]);
      expect(await ctx.db.select().from(domain)).toEqual([]);
    });

    it('plans web-private to web as a destroy plus a create, confirmed by name', async () => {
      await appliedApi();

      const open = await planFor(API.replace('web-private', 'web'));
      expect(open.steps.map((step) => [step.action, step.kind])).toEqual([
        ['destroy', 'web-private'],
        ['create', 'web'],
      ]);
      expect((await apply(open.planId)).status).toBe(409);

      const applied = await apply(open.planId, ['api']);

      expect(applied.status).toBe(200);
      const [web] = await ctx.db.select().from(application);
      expect(web.configKind).toBe('web');
      expect(
        await ctx.db
          .select()
          .from(domain)
          .where(eq(domain.applicationId, web.applicationId)),
      ).toHaveLength(1);
    });
  });
});
