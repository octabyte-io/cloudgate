import { eq } from 'drizzle-orm';
import { parse as parseDotenv } from 'dotenv';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  application,
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

/** A Template of own kinds only: a `web` and its `postgres`. */
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
  ADMIN_EMAIL: { ask: { label: Admin email, format: email } }
  SESSION_SECRET: { generate: base64 }
  POSTGRES_INITDB_ARGS: { value: "--data-checksums" }
`,
    'cloudgate.yaml': `version: 1
services:
  app:
    kind: web
    port: 2368
    source: { image: "ghost:5.96" }
    env:
      - ADMIN_EMAIL
      - SESSION_SECRET
      - DATABASE_URL: db.url
  db:
    kind: postgres
    env: [POSTGRES_INITDB_ARGS]
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
  environmentId: string;
  status: string;
  steps: {
    action: string;
    configName: string;
    template?: { setupName: string };
  }[];
  notes: { kind: string; configNames?: string[]; message: string }[];
}

interface SetupBody {
  setupName: string;
  configNames: string[];
  setupRecord: { setupRecordId: string; configNames: string[] };
  plan: PlanBody;
}

/**
 * One Template across a Project's Environments (#1377): a Plan in an
 * Environment it was not set up in holds its parts back with a note, and
 * setting it up there too reuses its Config names and makes only that
 * Environment's values.
 */
describe('Template setup across Environments (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let cookie: string;
  let projectId: string;
  let production: string;
  let staging: string;
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

  async function makeEnvironment(name: string): Promise<string> {
    const env = await request(server)
      .post('/environments')
      .set('Cookie', cookie)
      .send({ name, projectId });
    expect(env.status).toBe(201);
    return (env.body as { environmentId: string }).environmentId;
  }

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
    // A generated Domain needs the platform host's public address.
    await ctx.db.insert(webServerSettings).values({ serverIp: '198.51.100.7' });

    const project = await request(server)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'blog' });
    expect(project.status).toBe(201);
    projectId = (project.body as { projectId: string }).projectId;
    production = await makeEnvironment('production');
    staging = await makeEnvironment('staging');

    // Opening the templates screen saves the catalogue copy setup reads.
    expect(
      (await request(server).get('/templates').set('Cookie', cookie)).status,
    ).toBe(200);
  });

  const setUp = (environmentId: string, email: string) =>
    request(server)
      .post('/templates/setup')
      .set('Cookie', cookie)
      .send({
        templateId: 'ghost',
        projectId,
        environmentId,
        setupName: 'ghost',
        values: { ADMIN_EMAIL: email },
      });

  const apply = (environmentId: string, planId: string) =>
    request(server)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId });

  const planOf = async (environmentId: string) =>
    (
      (
        await request(server)
          .get(`/environments/${environmentId}/plan`)
          .set('Cookie', cookie)
      ).body as { plan: PlanBody }
    ).plan;

  async function appEnv(environmentId: string) {
    const [made] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.environmentId, environmentId));
    return parseDotenv(made.env ?? '');
  }

  it('holds the parts back together in another Environment, with a note', async () => {
    expect((await setUp(production, 'ada@example.com')).status).toBe(201);

    const held = await planOf(staging);

    expect(held.steps.map((step) => step.configName)).toEqual([]);
    expect(held.notes).toEqual([
      expect.objectContaining({
        kind: 'setup-held-back',
        configNames: ['ghost-app', 'ghost-db'],
        message:
          'ghost-app and ghost-db are held back here: they were set up from the ghost template in another Environment, and are created here when the template is set up in this Environment',
      }),
    ]);
  });

  it('sets the template up in a second Environment under the same Config names, making only that Environment’s values', async () => {
    const first = (await setUp(production, 'ada@example.com'))
      .body as SetupBody;
    expect((await apply(production, first.plan.planId)).status).toBe(200);
    const productionPlans = await ctx.db
      .select({ planId: planTable.planId })
      .from(planTable)
      .where(eq(planTable.environmentId, production));

    const res = await setUp(staging, 'grace@example.com');

    expect(res.status).toBe(201);
    const second = res.body as SetupBody;
    expect(second.setupName).toBe('ghost');
    expect(second.configNames).toEqual(['ghost-app', 'ghost-db']);
    // One setup, one record: the second Environment reuses it.
    expect(second.setupRecord.setupRecordId).toBe(
      first.setupRecord.setupRecordId,
    );
    expect(await ctx.db.select().from(setupRecord)).toHaveLength(1);
    expect(second.plan.environmentId).toBe(staging);
    expect(
      second.plan.steps.map((step) => [
        step.action,
        step.configName,
        step.template?.setupName,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['create', 'ghost-app', 'ghost'],
        ['create', 'ghost-db', 'ghost'],
      ]),
    );
    expect(second.plan.notes).toEqual([]);
    // Production is not planned again.
    expect(
      await ctx.db
        .select({ planId: planTable.planId })
        .from(planTable)
        .where(eq(planTable.environmentId, production)),
    ).toEqual(productionPlans);

    expect((await apply(staging, second.plan.planId)).status).toBe(200);
    const made = await appEnv(staging);
    const before = await appEnv(production);
    expect(made.ADMIN_EMAIL).toBe('grace@example.com');
    expect(before.ADMIN_EMAIL).toBe('ada@example.com');
    expect(Buffer.from(made.SESSION_SECRET, 'base64')).toHaveLength(32);
    expect(made.SESSION_SECRET).not.toBe(before.SESSION_SECRET);
    expect(await ctx.db.select().from(pendingSetup)).toEqual([]);
  });

  it('sets it up in a second Environment while the first’s Plan is still open, and both Apply', async () => {
    const first = (await setUp(production, 'ada@example.com'))
      .body as SetupBody;

    const res = await setUp(staging, 'grace@example.com');

    expect(res.status).toBe(201);
    const second = res.body as SetupBody;
    expect(second.configNames).toEqual(['ghost-app', 'ghost-db']);
    expect(await ctx.db.select().from(setupRecord)).toHaveLength(1);
    expect((await planOf(production)).planId).toBe(first.plan.planId);

    expect((await apply(staging, second.plan.planId)).status).toBe(200);
    expect((await apply(production, first.plan.planId)).status).toBe(200);
    expect((await appEnv(staging)).ADMIN_EMAIL).toBe('grace@example.com');
    expect((await appEnv(production)).ADMIN_EMAIL).toBe('ada@example.com');
  });

  it('adds -2 in an Environment that already has the setup', async () => {
    const first = (await setUp(production, 'ada@example.com'))
      .body as SetupBody;
    expect((await apply(production, first.plan.planId)).status).toBe(200);

    const again = await setUp(production, 'ada@example.com');

    expect(again.status).toBe(201);
    expect((again.body as SetupBody).configNames).toEqual([
      'ghost-2-app',
      'ghost-2-db',
    ]);
    expect(await ctx.db.select().from(setupRecord)).toHaveLength(2);
  });
});
