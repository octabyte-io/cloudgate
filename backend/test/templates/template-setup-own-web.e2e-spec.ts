import { eq } from 'drizzle-orm';
import { parse as parseDotenv } from 'dotenv';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  application,
  cloudAccount,
  domain,
  pendingSetup,
  plan as planTable,
  setupRecord,
  webServerSettings,
} from '../../src/db/schema';
import type { DeploymentJob } from '../../src/deployment-queue/job-types';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import type {
  JobState,
  QueuedJob,
  QueuePort,
} from '../../src/deployment-queue/queue.port';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { FETCH_CLIENT } from '../../src/git-providers/fetch.provider';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { isPresenceProbe } from '../utils/workload-presence-probe';
import {
  CatalogueHost,
  catalogueFile,
  SQUARE_SVG,
} from './catalogue-host.fixture';
import type { Folder } from './catalogue-host.fixture';

jest.setTimeout(120_000);

const urlBefore = process.env.CLOUDGATE_TEMPLATES_URL;
const oldUrlBefore = process.env.CLOUDGATE_TEMPLATES_BASE_URL;
delete process.env.CLOUDGATE_TEMPLATES_URL;
delete process.env.CLOUDGATE_TEMPLATES_BASE_URL;

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCOUNT = '123456789012';

/** A Template whose values name its own `web`'s URL and host. */
const GHOST: Folder = {
  id: 'ghost',
  revision: 'abc1234',
  files: {
    'template.yaml': `name: Ghost
description: A publishing platform.
version: "5.96"
tags: [blog]
cloudgate: 0.1.0
inputs:
  PUBLIC_URL: { value: "{{domains.app.url}}" }
  MAIL_FROM: { value: "noreply@{{domains.app.host}}" }
`,
    'cloudgate.yaml': `version: 1
services:
  app:
    kind: web
    port: 2368
    source: { image: "ghost:5.96" }
    env: [PUBLIC_URL, MAIL_FROM]
`,
    'logo.svg': SQUARE_SVG,
  },
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

interface PlanBody {
  planId: string;
  status: string;
  steps: {
    action: string;
    configName: string;
    template?: { host?: string };
  }[];
}

interface SetupForm {
  environments: {
    environmentId: string;
    canTake: boolean;
    reason: string | null;
  }[];
}

/**
 * A Template value that refers to an own `web`'s URL (#1375): setup makes
 * that `web`'s generated host, fills it in, and carries it through the Plan
 * to the Domain Apply makes; an Environment where the `web` would get no
 * generated host is not offered.
 */
describe('Template setup of an own web’s URL (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let cookie: string;
  let organizationId: string;
  let projectId: string;
  let environmentId: string;
  const host = new CatalogueHost();
  const queue = new ListQueue();
  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
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

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: FETCH_CLIENT, useValue: host.fetch },
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
    if (urlBefore !== undefined)
      process.env.CLOUDGATE_TEMPLATES_URL = urlBefore;
    if (oldUrlBefore !== undefined)
      process.env.CLOUDGATE_TEMPLATES_BASE_URL = oldUrlBefore;
  });

  const succeeds = (command: string) =>
    Promise.resolve(
      isPresenceProbe(command)
        ? { stdout: 'absent', stderr: '' }
        : { stdout: '', stderr: '' },
    );

  beforeEach(async () => {
    await ctx.resetDb();
    host.reset();
    host.served = { body: catalogueFile(GHOST) };
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
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', cookie);
    organizationId = (orgs.body as { id: string }[])[0].id;

    const project = await request(server)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'blog' });
    expect(project.status).toBe(201);
    projectId = (project.body as { projectId: string }).projectId;
    const env = await request(server)
      .post('/environments')
      .set('Cookie', cookie)
      .send({ name: 'production', projectId });
    expect(env.status).toBe(201);
    environmentId = (env.body as { environmentId: string }).environmentId;

    // Opening the templates screen saves the catalogue copy setup reads.
    expect(
      (await request(server).get('/templates').set('Cookie', cookie)).status,
    ).toBe(200);
  });

  const setUp = (into = environmentId) =>
    request(server).post('/templates/setup').set('Cookie', cookie).send({
      templateId: 'ghost',
      projectId,
      environmentId: into,
      setupName: 'ghost',
    });

  const form = async (): Promise<SetupForm> => {
    const res = await request(server)
      .get('/templates/ghost/setup')
      .query({ projectId })
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.body as SetupForm;
  };

  async function expectNothingWritten() {
    expect(await ctx.db.select().from(pendingSetup)).toEqual([]);
    expect(await ctx.db.select().from(setupRecord)).toEqual([]);
    expect(await ctx.db.select().from(planTable)).toEqual([]);
  }

  describe('on the platform host with its public address', () => {
    beforeEach(async () => {
      await ctx.db
        .insert(webServerSettings)
        .values({ serverIp: '198.51.100.7' });
    });

    it('offers the Environment', async () => {
      expect((await form()).environments).toEqual([
        {
          environmentId,
          name: 'production',
          canTake: true,
          reason: null,
          hosts: null,
          cloudDomains: null,
        },
      ]);
    });

    it('makes the web’s generated host at setup, fills it in, and Applies its Domain on exactly that host', async () => {
      const res = await setUp();

      expect(res.status).toBe(201);
      const plan = (res.body as { plan: PlanBody }).plan;
      const app = plan.steps.find((step) => step.configName === 'ghost-app');
      const picked = app?.template?.host ?? '';
      expect(picked).toMatch(/^ghost-app-[0-9a-f]{6}-198-51-100-7\.sslip\.io$/);

      const applied = await request(server)
        .post(`/environments/${environmentId}/plan/apply`)
        .set('Cookie', cookie)
        .send({ planId: plan.planId });

      expect(applied.status).toBe(200);
      expect((applied.body as PlanBody).status).toBe('applied');
      const [made] = await ctx.db
        .select()
        .from(application)
        .where(eq(application.configName, 'ghost-app'));
      const domains = await ctx.db
        .select({ host: domain.host, https: domain.https })
        .from(domain)
        .where(eq(domain.applicationId, made.applicationId));
      // The generated Domain is plain HTTP, so its URL says so.
      expect(domains).toEqual([{ host: picked, https: false }]);
      expect(parseDotenv(made.env ?? '')).toEqual({
        PUBLIC_URL: `http://${picked}`,
        MAIL_FROM: `noreply@${picked}`,
      });
      expect(await ctx.db.select().from(pendingSetup)).toEqual([]);
    });
  });

  describe('where the web would get no generated host', () => {
    it('refuses on the platform host with no public address, with the reason', async () => {
      const reason =
        "Its web app's URL is filled in at setup on a generated host, and the platform host has no public address to carry in one: set it in Settings → Instance";
      expect((await form()).environments).toEqual([
        {
          environmentId,
          name: 'production',
          canTake: false,
          reason,
          hosts: null,
          cloudDomains: null,
        },
      ]);

      const res = await setUp();

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        message: `production cannot take the Ghost template: ${reason}`,
        code: 'TEMPLATE_SETUP_REFUSED',
      });
      await expectNothingWritten();
    });

    it('refuses in a Cloud Environment, with the reason', async () => {
      const [account] = await ctx.db
        .insert(cloudAccount)
        .values({
          organizationId,
          name: 'Production AWS',
          cloud: 'aws',
          cloudId: ACCOUNT,
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          deployRoleArn: `arn:aws:iam::${ACCOUNT}:role/cloudgate-deploy`,
          taskExecutionRoleArn: `arn:aws:iam::${ACCOUNT}:role/cloudgate-task-execution`,
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
      const cloudId = (env.body as { environmentId: string }).environmentId;
      const reason =
        "Its web app's URL is filled in at setup on a generated host, and a web in a Cloud Environment gets no generated host";
      expect((await form()).environments).toContainEqual({
        environmentId: cloudId,
        name: 'cloud',
        canTake: false,
        reason,
        hosts: null,
        cloudDomains: null,
      });

      const res = await setUp(cloudId);

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        message: `cloud cannot take the Ghost template: ${reason}`,
      });
      await expectNothingWritten();
    });
  });
});
