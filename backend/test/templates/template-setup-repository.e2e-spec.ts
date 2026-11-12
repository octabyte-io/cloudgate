import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { parse as parseDotenv } from 'dotenv';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  compose,
  pendingSetup,
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
import { GithubService } from '../../src/git-providers/strategies/github/github.service';
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

// Signs the payload exactly as GitHub does (github-push-deploy.e2e-spec.ts).
const sign = (secret: string, payload: object) =>
  `sha256=${createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex')}`;

const COMPOSE_FILE = `services:
  ghost:
    image: ghost:5.96-alpine
    environment:
      database__connection__password: \${DB_PASSWORD}
      mail__from: \${ADMIN_EMAIL}
`;

/** A Template with a compose part and an own `postgres`. */
const GHOST: Folder = {
  id: 'ghost',
  revision: 'abc1234',
  files: {
    'template.yaml': `name: Ghost
description: A publishing platform.
version: "5.96"
tags: [blog]
cloudgate: 0.1.0
compose: app
inputs:
  DB_PASSWORD: { generate: password }
  ADMIN_EMAIL: { ask: { label: Admin email, format: email } }
  POSTGRES_INITDB_ARGS: { value: "--data-checksums" }
domains:
  - { service: ghost, port: 2368 }
`,
    'cloudgate.yaml': `version: 1
services:
  app: { kind: compose, managed: console }
  db:
    kind: postgres
    env: [POSTGRES_INITDB_ARGS]
`,
    'docker-compose.yml': COMPOSE_FILE,
    'logo.svg': SQUARE_SVG,
  },
};

const HOST = 'blog.example.com';

/** The file acme/blog keeps before the setup: no Services. */
const BEFORE = 'version: 1\nservices: {}\n';

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
  source: string;
  status: string;
  steps: {
    action: string;
    configName: string;
    kind: string;
    template?: { pendingSetupId: string; templateName: string };
  }[];
  notes: { kind: string; configName: string; message: string }[];
}

interface SetupBody {
  setupName: string;
  configNames: string[];
  pendingSetup: { pendingSetupId: string };
  plan: PlanBody | null;
  paste: {
    yaml: string;
    repository: string;
    path: string;
    branch: string | null;
  } | null;
}

/**
 * A Template set up into a Project whose config is kept in a repository
 * (#1378, ADR-0065): setup writes the Pending setup and answers the renamed
 * entries to paste, touching nothing in the repository. The next push of
 * the file makes the Plan that creates the parts from the Pending setup,
 * matching strictly by Config name and kind, and notes the values a renamed
 * part left unused. The repository is the harness's in-memory config
 * reader; the catalogue host is stubbed.
 */
describe('Template setup into a repository-kept config (e2e)', () => {
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

  const succeeds = (command: string) =>
    Promise.resolve(
      isPresenceProbe(command)
        ? { stdout: 'absent', stderr: '' }
        : { stdout: '', stderr: '' },
    );

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
    const ownerId = (res.body as { user: { id: string } }).user.id;
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', cookie);
    const ownerCtx = {
      user: { id: ownerId },
      session: { activeOrganizationId: (orgs.body as { id: string }[])[0].id },
    };
    // A generated host needs the platform host's public address.
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

    // The config moves into acme/blog.
    const github = await ctx.app
      .get(GithubService)
      .create(ownerCtx, connection);
    ctx.configReader.commit('acme/blog', BEFORE);
    const to = {
      kind: 'repository',
      gitProviderId: github.gitProvider.gitProviderId,
      repository: 'acme/blog',
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

    // Opening the templates screen saves the catalogue copy setup reads.
    expect(
      (await request(server).get('/templates').set('Cookie', cookie)).status,
    ).toBe(200);
  });

  const setUp = () =>
    request(server)
      .post('/templates/setup')
      .set('Cookie', cookie)
      .send({
        templateId: 'ghost',
        projectId,
        environmentId,
        setupName: 'ghost',
        values: { ADMIN_EMAIL: 'ada@example.com' },
        hosts: { ghost: HOST },
      });

  /** Commits `text` to acme/blog's main and delivers GitHub's push of it. */
  async function push(text: string) {
    const after = ctx.configReader.commit('acme/blog', text);
    const payload = {
      ref: 'refs/heads/main',
      before: '1111111111111111111111111111111111111111',
      after,
      deleted: false,
      installation: { id: 99887766 },
      repository: {
        name: 'blog',
        full_name: 'acme/blog',
        owner: { name: 'acme', login: 'acme' },
      },
      pusher: { name: 'grace' },
      head_commit: { id: after, message: 'Add Ghost' },
      commits: [
        {
          id: after,
          message: 'Add Ghost',
          added: [],
          modified: ['cloudgate.yaml'],
          removed: [],
        },
      ],
    };
    const res = await request(server)
      .post('/github/webhook')
      .set('x-github-event', 'push')
      .set('x-hub-signature-256', sign('wh-secret', payload))
      .send(payload);
    expect(res.status).toBe(200);
    const plan = await request(server)
      .get(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);
    expect(plan.status).toBe(200);
    return (plan.body as { plan: PlanBody | null }).plan;
  }

  it('writes the Pending setup and answers the renamed entries to paste, touching nothing in the repository', async () => {
    const reads = ctx.configReader.calls.length;

    const res = await setUp();

    expect(res.status).toBe(201);
    const body = res.body as SetupBody;
    expect(body.configNames).toEqual(['ghost-app', 'ghost-db']);
    expect(body.plan).toBeNull();
    expect(body.paste).toEqual({
      yaml: `services:
  ghost-app: { kind: compose, managed: console }
  ghost-db:
    kind: postgres
    env: [ POSTGRES_INITDB_ARGS ]
`,
      repository: 'acme/blog',
      path: 'cloudgate.yaml',
      branch: null,
    });
    const [pending] = await ctx.db.select().from(pendingSetup);
    expect(pending.parts.map((part) => [part.configName, part.kind])).toEqual([
      ['ghost-app', 'compose'],
      ['ghost-db', 'postgres'],
    ]);
    expect(await ctx.db.select().from(setupRecord)).toEqual([
      expect.objectContaining({ configNames: ['ghost-app', 'ghost-db'] }),
    ]);
    // Nothing read from or written to the repository, and no text kept.
    expect(ctx.configReader.calls.length).toBe(reads);
    const [location] = await ctx.db
      .select()
      .from(projectConfigLocation)
      .where(eq(projectConfigLocation.projectId, projectId));
    expect(location).toMatchObject({ kind: 'repository', text: null });
    // No plan opened by the setup itself.
    const plan = await request(server)
      .get(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);
    expect((plan.body as { plan: PlanBody | null }).plan?.source).not.toBe(
      'request',
    );
  });

  it('makes the push of the pasted entries a Plan that creates every part from the Pending setup, and Applies it', async () => {
    const setup = (await setUp()).body as SetupBody;

    const plan = await push(`version: 1\n${setup.paste?.yaml ?? ''}`);

    expect(plan).toMatchObject({ source: 'push', status: 'open' });
    const created = plan?.steps.filter((step) => step.action === 'create');
    expect(
      created?.map((step) => [
        step.configName,
        step.kind,
        step.template?.pendingSetupId,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['ghost-app', 'compose', setup.pendingSetup.pendingSetupId],
        ['ghost-db', 'postgres', setup.pendingSetup.pendingSetupId],
      ]),
    );
    expect(
      plan?.notes.filter((note) => note.kind === 'setup-values-unused'),
    ).toEqual([]);

    const applied = await request(server)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: plan?.planId });

    expect(applied.status).toBe(200);
    expect((applied.body as PlanBody).status).toBe('applied');
    const [stack] = await ctx.db
      .select()
      .from(compose)
      .where(eq(compose.configName, 'ghost-app'));
    expect(parseDotenv(stack.env ?? '').ADMIN_EMAIL).toBe('ada@example.com');
    const [db] = await ctx.db
      .select()
      .from(postgres)
      .where(eq(postgres.configName, 'ghost-db'));
    expect(parseDotenv(db.env ?? '').POSTGRES_INITDB_ARGS).toBe(
      '--data-checksums',
    );
    expect(await ctx.db.select().from(pendingSetup)).toEqual([]);
  });

  it('gives a part renamed in the pasted entries nothing, and notes its values left unused on the push Plan', async () => {
    const setup = (await setUp()).body as SetupBody;
    const renamed = `version: 1\n${setup.paste?.yaml.replace('ghost-db', 'blog-db') ?? ''}`;

    const plan = await push(renamed);

    expect(
      plan?.steps.find((step) => step.configName === 'blog-db'),
    ).toMatchObject({ action: 'create', kind: 'postgres' });
    expect(
      plan?.steps.find((step) => step.configName === 'blog-db')?.template,
    ).toBeUndefined();
    const notes =
      plan?.notes.filter((note) => note.kind === 'setup-values-unused') ?? [];
    expect(notes.map((note) => note.configName)).toEqual(['ghost-db']);
    expect(notes[0].message).toContain(
      'this config lists no postgres named ghost-db, so its values (POSTGRES_INITDB_ARGS) are left unused',
    );
  });

  it('keeps the Pending setup when the push Plan is dismissed', async () => {
    const setup = (await setUp()).body as SetupBody;
    const plan = await push(`version: 1\n${setup.paste?.yaml ?? ''}`);

    const dismissed = await request(server)
      .post(`/environments/${environmentId}/plan/dismiss`)
      .set('Cookie', cookie)
      .send({ planId: plan?.planId });

    expect(dismissed.status).toBe(200);
    expect(
      (await ctx.db.select().from(pendingSetup)).map(
        (row) => row.pendingSetupId,
      ),
    ).toEqual([setup.pendingSetup.pendingSetupId]);
  });
});
