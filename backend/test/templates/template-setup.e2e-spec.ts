import { eq, sql } from 'drizzle-orm';
import { parse as parseDotenv } from 'dotenv';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  application,
  member,
  pendingSetup,
  plan as planTable,
  postgres,
  projectConfigLocation,
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
import { signUpMember } from '../utils/test-auth';
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
  ADMIN_PASSWORD: { generate: password }
  SITE_TITLE: { value: "Blog of {{ADMIN_EMAIL}}" }
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
      - ADMIN_PASSWORD
      - SITE_TITLE
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
    template?: {
      templateId: string;
      templateName: string;
      setupName: string;
      values: { list: string; variable: string; made: string }[];
    };
  }[];
  results: { configName: string; status: string; message: string | null }[];
}

interface SetupBody {
  setupName: string;
  configNames: string[];
  pendingSetup: {
    pendingSetupId: string;
    values: {
      configName: string;
      variable: string;
      made: string;
      hasValue: boolean;
    }[];
  };
  setupRecord: { templateId: string; revision: string; configNames: string[] };
  plan: PlanBody;
}

/**
 * Setting up an own-kinds-only Template into an existing Project whose
 * config Cloudgate keeps (#1369): setup, then the Plan, then Apply, against a
 * stubbed catalogue host and the usual Server boundaries.
 */
describe('Template setup (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let cookie: string;
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
    // A generated Domain needs the platform host's public address.
    await ctx.db.insert(webServerSettings).values({ serverIp: '198.51.100.7' });

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

  const setUp = (body: Record<string, unknown> = {}, as = cookie) =>
    request(server)
      .post('/templates/setup')
      .set('Cookie', as)
      .send({
        templateId: 'ghost',
        projectId,
        environmentId,
        setupName: 'ghost',
        values: { ADMIN_EMAIL: 'ada@example.com' },
        ...body,
      });

  const apply = (planId: string) =>
    request(server)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId });

  async function storedText() {
    const [row] = await ctx.db
      .select({ text: projectConfigLocation.text })
      .from(projectConfigLocation)
      .where(eq(projectConfigLocation.projectId, projectId));
    return row.text ?? '';
  }

  it('offers the Environment in the setup form, with the values it asks', async () => {
    const res = await request(server)
      .get('/templates/ghost/setup')
      .query({ projectId })
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      templateId: 'ghost',
      setupName: 'ghost',
      asked: [
        {
          name: 'ADMIN_EMAIL',
          label: 'Admin email',
          format: 'email',
          required: true,
        },
      ],
      environments: [
        { environmentId, name: 'production', canTake: true, reason: null },
      ],
    });
  });

  it('sets up, plans each value as how it is made, and Applies the values into each Service’s own env', async () => {
    const res = await setUp();

    expect(res.status).toBe(201);
    const body = res.body as SetupBody;
    expect(body.configNames).toEqual(['ghost-app', 'ghost-db']);
    // ADR-0019: present, never the value.
    expect(JSON.stringify(body)).not.toContain('ada@example.com');
    expect(body.pendingSetup.values).toContainEqual({
      configName: 'ghost-app',
      variable: 'SESSION_SECRET',
      made: 'generated (base64, 32 bytes)',
      hasValue: true,
    });
    expect(body.setupRecord).toMatchObject({
      templateId: 'ghost',
      revision: 'abc1234',
      configNames: ['ghost-app', 'ghost-db'],
    });

    // The Plan: ordinary creates, each value a rule.
    const app = body.plan.steps.find((step) => step.configName === 'ghost-app');
    expect(app?.template).toMatchObject({
      templateId: 'ghost',
      templateName: 'Ghost',
    });
    const lines = app?.template?.values ?? [];
    expect(lines).toContainEqual({
      list: 'env',
      variable: 'ADMIN_EMAIL',
      made: 'asked',
    });
    expect(lines).toContainEqual({
      list: 'env',
      variable: 'ADMIN_PASSWORD',
      made: 'generated (password, 32 characters)',
    });
    expect(lines).toContainEqual({
      list: 'env',
      variable: 'SITE_TITLE',
      made: 'fixed',
    });

    // Encrypted at rest (ADR-0006): the raw column is ciphertext.
    const raw = await ctx.db.execute<{ body: string }>(
      sql`select body from pending_setup`,
    );
    expect(raw.rows[0].body).toMatch(/^enc:v1:/);
    // The config gains the entries only at Apply.
    expect(await storedText()).not.toContain('ghost-app');

    const applied = await apply(body.plan.planId);

    expect(applied.status).toBe(200);
    expect((applied.body as PlanBody).status).toBe('applied');
    const [made] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.configName, 'ghost-app'));
    const env = parseDotenv(made.env ?? '');
    expect(env.ADMIN_EMAIL).toBe('ada@example.com');
    expect(env.SITE_TITLE).toBe('Blog of ada@example.com');
    expect(Buffer.from(env.SESSION_SECRET, 'base64')).toHaveLength(32);
    expect(env.ADMIN_PASSWORD).toMatch(/^[A-Za-z0-9]{32}$/);
    // The wired one is a link, not a saved value (ADR-0031).
    expect(env).not.toHaveProperty('DATABASE_URL');
    const [db] = await ctx.db
      .select()
      .from(postgres)
      .where(eq(postgres.configName, 'ghost-db'));
    expect(parseDotenv(db.env ?? '')).toEqual({
      POSTGRES_INITDB_ARGS: '--data-checksums',
    });

    // The generated password reads back like any value.
    const read = await request(server)
      .get(`/applications/${made.applicationId}`)
      .set('Cookie', cookie);
    expect(read.status).toBe(200);
    expect((read.body as { env: string }).env).toContain(env.ADMIN_PASSWORD);

    // Used up: the Pending setup is gone, the Setup record and text stay.
    expect(await ctx.db.select().from(pendingSetup)).toEqual([]);
    expect(await ctx.db.select().from(setupRecord)).toHaveLength(1);
    expect(await storedText()).toContain('DATABASE_URL: ghost-db.url');
  });

  it('adds -2 to the whole setup name when a part’s name is taken', async () => {
    expect((await setUp()).status).toBe(201);

    const second = await setUp();

    expect(second.status).toBe(201);
    expect((second.body as SetupBody).configNames).toEqual([
      'ghost-2-app',
      'ghost-2-db',
    ]);
  });

  it('refuses an asked value that fails its check, writing nothing', async () => {
    const res = await setUp({ values: { ADMIN_EMAIL: 'not-an-email' } });

    expect(res.status).toBe(400);
    expect((res.body as { message: string }).message).toBe(
      'Admin email must be an email address, as its format says',
    );
    expect(await ctx.db.select().from(pendingSetup)).toEqual([]);
    expect(await ctx.db.select().from(setupRecord)).toEqual([]);
    expect(await ctx.db.select().from(planTable)).toEqual([]);
  });

  it('refuses a member without service: create before anything is saved', async () => {
    const fixture = await signUpMember(server, cookie);
    await ctx.db
      .update(member)
      .set({
        accessedProjects: [projectId],
        accessedEnvironments: [environmentId],
      })
      .where(eq(member.userId, fixture.id));

    const res = await setUp({}, fixture.cookie);

    expect(res.status).toBe(403);
    expect(await ctx.db.select().from(pendingSetup)).toEqual([]);
    expect(await ctx.db.select().from(setupRecord)).toEqual([]);
    expect(await ctx.db.select().from(planTable)).toEqual([]);
  });

  it('refuses an Agent, even one whose role holds the statements', async () => {
    const created = await request(server)
      .post('/agents')
      .set('Cookie', cookie)
      .send({ name: 'deploy-bot', role: 'agentOperator' });
    expect(created.status).toBe(201);
    const { key } = created.body as { key: string };

    const res = await request(server)
      .post('/templates/setup')
      .set('x-api-key', key)
      .send({
        templateId: 'ghost',
        projectId,
        environmentId,
        setupName: 'ghost',
        values: { ADMIN_EMAIL: 'ada@example.com' },
      });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'AGENT_NOT_ALLOWED_HERE' });
    expect(await ctx.db.select().from(pendingSetup)).toEqual([]);
  });

  it('keeps the setup through Check for changes, whose plan carries its entries forward', async () => {
    const body = (await setUp()).body as SetupBody;

    const checked = await request(server)
      .post(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);

    expect(checked.status).toBe(201);
    const newer = checked.body as PlanBody;
    expect(newer.planId).not.toBe(body.plan.planId);
    expect(
      newer.steps.map((step) => [step.configName, step.template?.setupName]),
    ).toEqual(
      expect.arrayContaining([
        ['ghost-app', 'ghost'],
        ['ghost-db', 'ghost'],
      ]),
    );
    expect(await ctx.db.select().from(pendingSetup)).toHaveLength(1);

    expect((await apply(newer.planId)).status).toBe(200);
    expect(await ctx.db.select().from(pendingSetup)).toEqual([]);
  });

  it('drops the Pending setup and its unused Setup record when its Plan is dismissed', async () => {
    const body = (await setUp()).body as SetupBody;

    const dismissed = await request(server)
      .post(`/environments/${environmentId}/plan/dismiss`)
      .set('Cookie', cookie)
      .send({ planId: body.plan.planId });

    expect(dismissed.status).toBe(200);
    expect(await ctx.db.select().from(pendingSetup)).toEqual([]);
    expect(await ctx.db.select().from(setupRecord)).toEqual([]);
  });
});
