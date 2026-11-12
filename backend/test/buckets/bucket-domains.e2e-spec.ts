import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { parse as parseYaml } from 'yaml';

import { ApplicationsService } from '../../src/applications/applications.service';
import {
  application,
  bucket,
  domain,
  server as serverTable,
} from '../../src/db/schema';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import type { DeploymentJob } from '../../src/deployment-queue/job-types';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import type {
  JobState,
  QueuedJob,
  QueuePort,
} from '../../src/deployment-queue/queue.port';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

const KEY_ID = 'GK3a1f0c9e2b7d4c6a8e1f0b2d';
const SECRET_KEY =
  '9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0';

interface PlanBody {
  planId: string;
  environmentId: string;
  steps: { action: string; configName: string }[];
  notes: { kind: string; configName: string; message: string }[];
  results: {
    configName: string;
    status: string;
    domain: string | null;
    message: string | null;
  }[];
}

/** The Traefik file-provider config, as Cloudgate writes it. */
interface TraefikFile {
  http: {
    routers: Record<
      string,
      { rule: string; entryPoints: string[]; tls?: { certResolver?: string } }
    >;
    services: Record<
      string,
      { loadBalancer: { servers: { url: string }[]; passHostHeader: boolean } }
    >;
  };
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

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * A Server bucket's Domains (ADR-0037), through the HTTP API: a plan
 * that creates a bucket gives it a generated sslip.io Domain over HTTPS,
 * written to the Server's Traefik as a router to its Garage's S3 API; a
 * linked Service's `endpoint` is that Domain while it exists, and the
 * internal URL once the last one is removed, which the next plan notes. The
 * operator adds and removes a bucket's Domains with the routes and rights
 * any Domain has. The Server's shell and its Docker daemon are the doubles;
 * words and values are written out here, never imported (§1.7).
 */
describe('Bucket Domains on a Server (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let projectId: string;
  let serverId: string;
  let environmentId: string;

  const queue = new ListQueue();
  const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
  const machine = (command: string) => {
    if (isPresenceProbe(command)) return Promise.resolve(ok('absent'));
    if (command.includes('garage key create')) {
      return Promise.resolve(
        ok(`CLOUDGATE_KEY_ID=${KEY_ID}\nCLOUDGATE_SECRET_KEY=${SECRET_KEY}\n`),
      );
    }
    return Promise.resolve(ok());
  };
  const execMock = withArgvExec({
    execAsync: jest.fn<Promise<ExecResult>, [string, unknown?]>(),
    execAsyncRemote: jest.fn<Promise<ExecResult>, [string, string]>(),
  });
  const dockerService = { inspect: jest.fn(), update: jest.fn() };
  const docker = {
    getService: jest.fn(() => dockerService),
    createService: jest.fn(),
    listTasks: jest.fn(),
    getSecret: jest.fn(() => ({
      inspect: jest.fn().mockRejectedValue(new Error('no such secret')),
    })),
    createSecret: jest.fn(),
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
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    queue.jobs = [];
    execMock.execAsync.mockReset().mockImplementation(machine);
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_serverId, command) => machine(command));
    dockerService.inspect
      .mockReset()
      .mockRejectedValue(new Error('no such service'));
    dockerService.update.mockReset().mockResolvedValue(undefined);
    docker.createService.mockReset().mockResolvedValue(undefined);
    docker.createSecret.mockReset().mockResolvedValue({ id: 'secret-1' });
    docker.listTasks
      .mockReset()
      .mockResolvedValue([
        { Status: { State: 'running', Timestamp: '2026-10-17T00:00:00Z' } },
      ]);

    const res = await request(http).post('/api/auth/sign-up/email').send({
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
    });
    expect(res.status).toBe(200);
    cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const orgs = await request(http)
      .get('/organizations')
      .set('Cookie', cookie);
    organizationId = (orgs.body as { id: string }[])[0].id;

    const project = await request(http)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'shop' });
    expect(project.status).toBe(201);
    projectId = (project.body as { projectId: string }).projectId;

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
    serverId = worker.serverId;

    const created = await request(http)
      .post('/environments')
      .set('Cookie', cookie)
      .send({
        name: 'production',
        projectId,
        deployTarget: { kind: 'server', serverId },
      });
    expect(created.status).toBe(201);
    environmentId = (created.body as { environmentId: string }).environmentId;
  });

  const STACK = `version: 1
services:
  web:
    kind: web
    source:
      image: nginx:1.27
    env: [{ S3_ENDPOINT: uploads.endpoint }, { S3_BUCKET: uploads.name }]
  uploads:
    kind: bucket
`;

  async function save(): Promise<PlanBody> {
    const saved = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text: STACK });
    expect(saved.status).toBe(201);
    return (saved.body as { plans: PlanBody[] }).plans.find(
      (plan) => plan.environmentId === environmentId,
    ) as PlanBody;
  }

  /** "Check for changes": the next plan of the stored config. */
  async function replan(): Promise<PlanBody> {
    const next = await request(http)
      .post(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);
    expect(next.status).toBe(201);
    return next.body as PlanBody;
  }

  async function applyPlan(): Promise<PlanBody> {
    const open = await save();
    const applied = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: open.planId });
    expect(applied.status).toBe(200);
    const body = applied.body as PlanBody;
    expect(
      body.results.filter((result) => result.status !== 'applied'),
    ).toEqual([]);
    await waitFor(async () => {
      const rows = await ctx.db.select().from(bucket);
      return rows.every((row) => row.applicationStatus !== 'running');
    });
    return body;
  }

  /** Deploys web through the real engine and answers its container's Env. */
  async function deployWeb(): Promise<string[]> {
    const [row] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.configName, 'web'));
    const deployable = await ctx.app
      .get(ApplicationsService)
      .findDeployable(row.applicationId);
    await ctx.app.get(DeploymentEngineService).deploy(deployable);
    const call = docker.createService.mock.calls
      .map((args: unknown[]) => args[args.length - 1])
      .filter((settings) => (settings as { Name: string }).Name === row.appName)
      .pop() as { TaskTemplate: { ContainerSpec: { Env: string[] } } };
    return call.TaskTemplate.ContainerSpec.Env;
  }

  /** Every command run on the Server, in order. */
  const commands = (): string[] =>
    execMock.execAsyncRemote.mock.calls.map(([, command]) => command);

  /** The last Traefik file written at `<appName>.yml` on the Server, parsed. */
  function traefikFileOf(appName: string): TraefikFile | null {
    const written = commands()
      .filter((command) => command.endsWith(`/traefik/dynamic/${appName}.yml`))
      .pop();
    const encoded = written?.match(/^echo "([^"]+)" \| base64 -d > /)?.[1];
    if (!encoded) return null;
    return parseYaml(
      Buffer.from(encoded, 'base64').toString('utf8'),
    ) as TraefikFile;
  }

  it('gives a bucket the plan creates a generated Domain, routed to its Garage S3 API over HTTPS', async () => {
    const applied = await applyPlan();
    const [uploads] = await ctx.db.select().from(bucket);
    const rows = await ctx.db
      .select()
      .from(domain)
      .where(eq(domain.bucketId, uploads.bucketId));

    expect(rows).toEqual([
      expect.objectContaining({
        applicationId: null,
        composeId: null,
        https: true,
        certificateType: 'letsencrypt',
        port: 3900,
        path: '/',
        domainType: 'bucket',
      }),
    ]);
    const [bucketDomain] = rows;
    expect(bucketDomain.host).toMatch(
      new RegExp(`^${uploads.appName}-[0-9a-f]{6}-203-0-113-10\\.sslip\\.io$`),
    );
    expect(
      applied.results.find((result) => result.configName === 'uploads'),
    ).toMatchObject({ domain: bucketDomain.host });

    // The Server's Traefik: a web router that redirects, a websecure one
    // with a Let's Encrypt certificate, both on the Domain's host, and a
    // service at the bucket's Swarm service on Garage's S3 port that keeps
    // the Host header Garage checks a signature against.
    const file = traefikFileOf(uploads.appName);
    expect(file).not.toBeNull();
    const routers = Object.values(file?.http.routers ?? {});
    expect(routers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: `Host(\`${bucketDomain.host}\`)`,
          entryPoints: ['websecure'],
          tls: { certResolver: 'letsencrypt' },
        }),
        expect.objectContaining({
          rule: `Host(\`${bucketDomain.host}\`)`,
          entryPoints: ['web'],
        }),
      ]),
    );
    expect(Object.values(file?.http.services ?? {})).toEqual([
      {
        loadBalancer: {
          servers: [{ url: `http://${uploads.appName}:3900` }],
          passHostHeader: true,
        },
      },
    ]);

    // Its page lists it, under the Domain rights any Domain has.
    const listed = await request(http)
      .get(`/buckets/${uploads.bucketId}/domains`)
      .set('Cookie', cookie);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      expect.objectContaining({
        domainId: bucketDomain.domainId,
        host: bucketDomain.host,
        bucketId: uploads.bucketId,
      }),
    ]);
    // And its Environment's Domains name the bucket as the Service.
    const inEnvironment = await request(http)
      .get(`/environments/${environmentId}/domains`)
      .set('Cookie', cookie);
    expect(inEnvironment.status).toBe(200);
    expect(inEnvironment.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          host: bucketDomain.host,
          service: {
            serviceType: 'bucket',
            serviceId: uploads.bucketId,
            name: 'uploads',
          },
        }),
      ]),
    );
  });

  it('hands a linked Service the Domain as endpoint, then the internal URL once its last Domain is removed, and the next plan notes it', async () => {
    await applyPlan();
    const [uploads] = await ctx.db.select().from(bucket);
    const [bucketDomain] = await ctx.db
      .select()
      .from(domain)
      .where(eq(domain.bucketId, uploads.bucketId));

    expect(await deployWeb()).toEqual(
      expect.arrayContaining([
        `S3_ENDPOINT=https://${bucketDomain.host}`,
        `S3_BUCKET=${uploads.bucketName}`,
      ]),
    );
    // A plan of the same config, while it has its Domain, notes nothing of it.
    expect(
      (await replan()).notes.filter((note) => note.kind === 'bucket-no-domain'),
    ).toEqual([]);

    const removed = await request(http)
      .delete(`/domains/${bucketDomain.domainId}`)
      .set('Cookie', cookie);
    expect(removed.status).toBe(200);
    // The last Domain gone, so is its file on the Server.
    expect(commands()).toContain(
      `rm -f /etc/cloudgate/traefik/dynamic/${uploads.appName}.yml`,
    );

    expect(await deployWeb()).toContain(
      `S3_ENDPOINT=http://${uploads.appName}:3900`,
    );
    expect((await replan()).notes).toEqual([
      {
        kind: 'bucket-no-domain',
        configName: 'uploads',
        message:
          'uploads: the bucket has no Domain, so its endpoint is the internal URL and presigned URLs and browser uploads stop working; add a Domain on its page',
      },
    ]);
  });

  it("adds an operator's own Domain to a bucket on Garage's S3 port, and refuses one that would break signed requests", async () => {
    await applyPlan();
    const [uploads] = await ctx.db.select().from(bucket);

    const added = await request(http)
      .post('/domains')
      .set('Cookie', cookie)
      .send({
        host: 'files.example.com',
        bucketId: uploads.bucketId,
        https: true,
        certificateType: 'letsencrypt',
      });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({
      host: 'files.example.com',
      bucketId: uploads.bucketId,
      port: 3900,
      domainType: 'bucket',
    });
    const routers = Object.values(
      traefikFileOf(uploads.appName)?.http.routers ?? {},
    );
    expect(routers.map((router) => router.rule)).toContain(
      'Host(`files.example.com`)',
    );

    // The generated Domain is older, so endpoint stays on it.
    const [generated] = await ctx.db
      .select()
      .from(domain)
      .where(eq(domain.domainType, 'bucket'))
      .orderBy(domain.createdAt);
    expect(await deployWeb()).toContain(
      `S3_ENDPOINT=https://${generated.host}`,
    );

    for (const [field, body] of [
      ['port', { port: 8080 }],
      ['path', { path: '/files' }],
    ] as const) {
      const refused = await request(http)
        .post('/domains')
        .set('Cookie', cookie)
        .send({
          host: `${field}.example.com`,
          bucketId: uploads.bucketId,
          ...body,
        });
      expect(refused.status).toBe(400);
      expect((refused.body as { message: string }).message).toContain(
        `${field}: `,
      );
    }

    const twoParents = await request(http)
      .post('/domains')
      .set('Cookie', cookie)
      .send({
        host: 'both.example.com',
        bucketId: uploads.bucketId,
        applicationId: 'whatever',
      });
    expect(twoParents.status).toBe(400);
  });
});
