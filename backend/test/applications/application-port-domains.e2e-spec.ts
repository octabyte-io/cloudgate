import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { application, cloudAccount, domain } from '../../src/db/schema';
import type { DeploymentJob } from '../../src/deployment-queue/job-types';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import type {
  JobState,
  QueuedJob,
  QueuePort,
} from '../../src/deployment-queue/queue.port';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

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

interface DomainPortMove {
  from: number;
  to: number;
  moved: { domainId: string; host: string }[];
  left: { domainId: string; host: string; port: number | null }[];
}

/** One written file's backends, as `url`s, from the Traefik writer's last call. */
function backendsWritten(
  writeConfig: jest.Mock,
): Record<string, string> | undefined {
  const call = writeConfig.mock.calls.at(-1) as
    | [
        string,
        {
          http?: {
            services?: Record<
              string,
              { loadBalancer: { servers: { url: string }[] } }
            >;
          };
        },
      ]
    | undefined;
  if (!call) return undefined;
  return Object.fromEntries(
    Object.entries(call[1].http?.services ?? {}).map(([name, service]) => [
      name,
      service.loadBalancer.servers[0].url,
    ]),
  );
}

/**
 * ADR-0068 (#1339): an Application's port change moves every one of its
 * Domains on the old port to the new one and rewrites their routing in the
 * same request, through `PATCH /applications/:id` and an Apply's change
 * step alike. A Domain on another port stays and is named. The Traefik
 * writer, the deployment queue and the shell are the boundaries.
 */
describe('Application port changes (e2e)', () => {
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
    execRemote: jest.fn(),
  };
  const traefikWriterMock = {
    loadOrCreateConfig: jest.fn(),
    writeConfig: jest.fn(),
    removeConfig: jest.fn(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: DEPLOYMENT_QUEUE, useValue: queue },
        { provide: RemoteExecService, useValue: execMock },
        { provide: TraefikWriterService, useValue: traefikWriterMock },
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
    traefikWriterMock.loadOrCreateConfig
      .mockReset()
      .mockResolvedValue({ http: { routers: {}, services: {} } });
    traefikWriterMock.writeConfig.mockReset().mockResolvedValue(undefined);
    traefikWriterMock.removeConfig.mockReset().mockResolvedValue(undefined);

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
    const env = await request(server)
      .post('/environments')
      .set('Cookie', cookie)
      .send({ name: 'production', projectId });
    expect(env.status).toBe(201);
    environmentId = (env.body as { environmentId: string }).environmentId;
  });

  /** `shop-web` on the platform host, on port 3000, from an image. */
  async function createShopWeb(): Promise<string> {
    const made = await request(server)
      .post('/applications')
      .set('Cookie', cookie)
      .send({ name: 'shop-web', environmentId });
    expect(made.status).toBe(201);
    const applicationId = (made.body as { applicationId: string })
      .applicationId;
    await request(server)
      .patch(`/applications/${applicationId}`)
      .set('Cookie', cookie)
      .send({ sourceType: 'docker', dockerImage: 'nginx:1.27', port: 3000 })
      .expect(200);
    return applicationId;
  }

  async function addDomain(applicationId: string, host: string, port: number) {
    const res = await request(server)
      .post('/domains')
      .set('Cookie', cookie)
      .send({ applicationId, host, port });
    expect(res.status).toBe(201);
    return (res.body as { domainId: string }).domainId;
  }

  async function portsByHost(applicationId: string) {
    const rows = await ctx.db
      .select({ host: domain.host, port: domain.port })
      .from(domain)
      .where(eq(domain.applicationId, applicationId));
    return Object.fromEntries(rows.map((row) => [row.host, row.port]));
  }

  async function applicationPort(applicationId: string) {
    const [row] = await ctx.db
      .select({ port: application.port })
      .from(application)
      .where(eq(application.applicationId, applicationId));
    return row.port;
  }

  /** shop-web with www and shop on 3000, api on 8080. */
  async function shopWebWithDomains() {
    const applicationId = await createShopWeb();
    const www = await addDomain(applicationId, 'www.example.com', 3000);
    const shop = await addDomain(applicationId, 'shop.example.com', 3000);
    const api = await addDomain(applicationId, 'api.example.com', 8080);
    traefikWriterMock.writeConfig.mockClear();
    return { applicationId, www, shop, api };
  }

  describe('PATCH /applications/:id', () => {
    it('moves the Domains on the old port, routes them there, and names the one it left', async () => {
      const { applicationId, www, shop, api } = await shopWebWithDomains();

      const res = await request(server)
        .patch(`/applications/${applicationId}`)
        .set('Cookie', cookie)
        .send({ port: 3900 });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ applicationId, port: 3900 });
      expect(
        (res.body as { domainPortMove: DomainPortMove }).domainPortMove,
      ).toEqual({
        from: 3000,
        to: 3900,
        moved: [
          { domainId: shop, host: 'shop.example.com' },
          { domainId: www, host: 'www.example.com' },
        ],
        left: [{ domainId: api, host: 'api.example.com', port: 8080 }],
      });
      expect(await portsByHost(applicationId)).toEqual({
        'www.example.com': 3900,
        'shop.example.com': 3900,
        'api.example.com': 8080,
      });

      // Routed in the same request, with no Domain edited and no redeploy.
      expect(traefikWriterMock.writeConfig).toHaveBeenCalledTimes(1);
      const urls = Object.values(
        backendsWritten(traefikWriterMock.writeConfig) ?? {},
      );
      expect(urls.filter((url) => url.endsWith(':3900'))).toHaveLength(2);
      expect(urls.filter((url) => url.endsWith(':8080'))).toHaveLength(1);
      expect(urls.some((url) => url.endsWith(':3000'))).toBe(false);
      expect(queue.jobs).toHaveLength(0);
    });

    it('moves nothing and rewrites nothing when the port is saved at the value it has', async () => {
      const { applicationId } = await shopWebWithDomains();

      const res = await request(server)
        .patch(`/applications/${applicationId}`)
        .set('Cookie', cookie)
        .send({ port: 3000 });

      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('domainPortMove');
      expect(await portsByHost(applicationId)).toEqual({
        'www.example.com': 3000,
        'shop.example.com': 3000,
        'api.example.com': 8080,
      });
      expect(traefikWriterMock.writeConfig).not.toHaveBeenCalled();
    });

    it('leaves the port and every Domain as they were when the routing cannot be written', async () => {
      const { applicationId } = await shopWebWithDomains();
      traefikWriterMock.writeConfig.mockRejectedValueOnce(
        new Error('the dynamic directory is read-only'),
      );

      const res = await request(server)
        .patch(`/applications/${applicationId}`)
        .set('Cookie', cookie)
        .send({ port: 3900 });

      expect(res.status).toBeGreaterThanOrEqual(400);
      // Neither the port nor a Domain moved on the way to being refused.
      expect(await applicationPort(applicationId)).toBe(3000);
      expect(await portsByHost(applicationId)).toEqual({
        'www.example.com': 3000,
        'shop.example.com': 3000,
        'api.example.com': 8080,
      });
    });

    it('touches no Domain row of an Application in a Cloud account', async () => {
      const [account] = await ctx.db
        .insert(cloudAccount)
        .values({
          organizationId,
          name: 'Production AWS',
          cloud: 'aws',
          cloudId: '123456789012',
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          deployRoleArn: 'arn:aws:iam::123456789012:role/cloudgate-deploy',
          taskExecutionRoleArn:
            'arn:aws:iam::123456789012:role/cloudgate-task-execution',
          externalId: 'external-id-made-by-cloudgate',
          policyVersion: 1,
          lastCheckedAt: new Date().toISOString(),
          lastCheckResult: 'passed',
        })
        .returning();
      const env = await request(server)
        .post('/environments')
        .set('Cookie', cookie)
        .send({
          projectId,
          name: 'cloud',
          deployTarget: {
            kind: 'cloud',
            cloudAccountId: account.cloudAccountId,
            region: 'eu-central-1',
          },
        });
      expect(env.status).toBe(201);
      const [web] = await ctx.db
        .insert(application)
        .values({
          name: 'web',
          environmentId: (env.body as { environmentId: string }).environmentId,
          configName: 'web',
          configKind: 'web',
          sourceType: 'docker',
          dockerImage: 'nginx',
          cloudAccountId: account.cloudAccountId,
          region: 'eu-central-1',
          port: 3000,
          applicationStatus: 'done',
        })
        .returning();
      await ctx.db.insert(domain).values({
        applicationId: web.applicationId,
        host: 'cloud.example.com',
        port: 3000,
      });

      const res = await request(server)
        .patch(`/applications/${web.applicationId}`)
        .set('Cookie', cookie)
        .send({ port: 3900 });

      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('domainPortMove');
      expect(await portsByHost(web.applicationId)).toEqual({
        'cloud.example.com': 3000,
      });
      expect(traefikWriterMock.writeConfig).not.toHaveBeenCalled();
    });
  });

  describe("an Apply's change step", () => {
    it('moves the same Domains when web.port changes, and says so on its change line', async () => {
      const { applicationId, www, shop, api } = await shopWebWithDomains();

      const saved = await request(server)
        .post(`/projects/${projectId}/config/plans`)
        .set('Cookie', cookie)
        .send({
          text: `version: 1
services:
  shop-web:
    kind: web
    port: 3900
    source:
      image: nginx:1.27
`,
        });
      expect(saved.status).toBe(201);
      const plan = (
        saved.body as {
          plans: {
            planId: string;
            environmentId: string;
            steps: { action: string; configName: string }[];
          }[];
        }
      ).plans.find((found) => found.environmentId === environmentId);
      expect(plan?.steps).toEqual([
        expect.objectContaining({ action: 'change', configName: 'shop-web' }),
      ]);

      const applied = await request(server)
        .post(`/environments/${environmentId}/plan/apply`)
        .set('Cookie', cookie)
        .send({ planId: plan?.planId });

      expect(applied.status).toBe(200);
      const [result] = (
        applied.body as {
          results: {
            configName: string;
            status: string;
            domainPortMove?: DomainPortMove;
          }[];
        }
      ).results;
      expect(result).toMatchObject({
        configName: 'shop-web',
        status: 'applied',
      });
      expect(result.domainPortMove).toEqual({
        from: 3000,
        to: 3900,
        moved: [
          { domainId: shop, host: 'shop.example.com' },
          { domainId: www, host: 'www.example.com' },
        ],
        left: [{ domainId: api, host: 'api.example.com', port: 8080 }],
      });
      expect(await applicationPort(applicationId)).toBe(3900);
      expect(await portsByHost(applicationId)).toEqual({
        'www.example.com': 3900,
        'shop.example.com': 3900,
        'api.example.com': 8080,
      });
      const urls = Object.values(
        backendsWritten(traefikWriterMock.writeConfig) ?? {},
      );
      expect(urls.filter((url) => url.endsWith(':3900'))).toHaveLength(2);
      expect(urls.some((url) => url.endsWith(':3000'))).toBe(false);
    });
  });
});
