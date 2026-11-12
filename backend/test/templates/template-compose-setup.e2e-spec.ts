import { eq, sql } from 'drizzle-orm';
import { parse as parseDotenv } from 'dotenv';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  compose,
  domain,
  mount,
  pendingSetup,
  postgres,
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

const COMPOSE_FILE = `services:
  ghost:
    image: ghost:5.96-alpine
    environment:
      database__connection__password: \${DB_PASSWORD}
      mail__from: \${ADMIN_EMAIL}
      url: \${SITE_URL}
      TZ: \${TZ:-Etc/UTC}
      LOCALE: \${LOCALE-en}
    volumes:
      - ../files/config.production.json:/var/lib/ghost/config.production.json
`;

/**
 * A Template with a compose part and an own `postgres`: the stack takes its
 * values in its own `.env`, a config file its compose file binds, and one
 * Domain; the database takes a config file it mounts.
 */
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
  SITE_URL: { value: "{{domains.ghost.url}}" }
  TZ: { ask: { label: Time zone, default: Etc/UTC } }
  LOCALE: { ask: { label: Locale, required: false } }
domains:
  - { service: ghost, port: 2368 }
files:
  - { path: config.production.json }
  - { path: init.sql, entry: db, mount: /docker-entrypoint-initdb.d/init.sql }
`,
    'cloudgate.yaml': `version: 1
services:
  app: { kind: compose, managed: console }
  db:
    kind: postgres
`,
    'docker-compose.yml': COMPOSE_FILE,
    'files/config.production.json':
      '{ "url": "{{domains.ghost.url}}", "mail": "{{ADMIN_EMAIL}}", "theme": "{{ theme }}" }',
    'files/init.sql': '-- for {{domains.ghost.host}}\n',
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

interface PlanStepBody {
  action: string;
  configName: string;
  kind: string;
  template?: {
    templateName: string;
    values: { list: string; variable: string; made: string }[];
    domains?: { service: string; port: number; path: string; host: string }[];
    files?: { path: string; mount: string | null }[];
  };
}

interface PlanBody {
  planId: string;
  status: string;
  steps: PlanStepBody[];
  results: { configName: string; status: string; message: string | null }[];
}

interface SetupBody {
  configNames: string[];
  plan: PlanBody;
}

interface FormBody {
  domains: { name: string; service: string; port: number; path: string }[];
  environments: {
    environmentId: string;
    canTake: boolean;
    hosts: Record<string, string> | null;
  }[];
}

const HOST = 'blog.example.com';

/**
 * A Template's compose part set up on the platform host (#1373): its Domain
 * prefilled on a generated sslip.io host, then setup, the Plan's create of
 * the stack, and the Apply that writes the stack, its `.env`, its encrypted
 * file mounts and its Domain in one step, against a stubbed catalogue host
 * and the usual Server boundaries.
 */
describe('Template compose part setup (e2e)', () => {
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

  async function createProject(name: string) {
    const project = await request(server)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name });
    expect(project.status).toBe(201);
    const id = (project.body as { projectId: string }).projectId;
    const env = await request(server)
      .post('/environments')
      .set('Cookie', cookie)
      .send({ name: 'production', projectId: id });
    expect(env.status).toBe(201);
    return {
      projectId: id,
      environmentId: (env.body as { environmentId: string }).environmentId,
    };
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
    // A generated host needs the platform host's public address.
    await ctx.db.insert(webServerSettings).values({ serverIp: '198.51.100.7' });

    ({ projectId, environmentId } = await createProject('blog'));

    // Opening the templates screen saves the catalogue copy setup reads.
    expect(
      (await request(server).get('/templates').set('Cookie', cookie)).status,
    ).toBe(200);
  });

  const setUp = (hosts: Record<string, string> = { ghost: HOST }) =>
    request(server)
      .post('/templates/setup')
      .set('Cookie', cookie)
      .send({
        templateId: 'ghost',
        projectId,
        environmentId,
        setupName: 'ghost',
        values: { ADMIN_EMAIL: 'ada@example.com', TZ: 'Asia/Karachi' },
        hosts,
      });

  const apply = (planId: string) =>
    request(server)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId });

  /** The host taken by a Domain on a stack in another Project. */
  async function takeHost(taken: string) {
    const other = await createProject('other');
    const stack = await request(server)
      .post('/compose')
      .set('Cookie', cookie)
      .send({
        name: 'site',
        environmentId: other.environmentId,
        composeFile: 'services:\n  web:\n    image: nginx:1.27\n',
        sourceType: 'raw',
      });
    expect(stack.status).toBe(201);
    const made = await request(server)
      .post('/domains')
      .set('Cookie', cookie)
      .send({
        host: taken,
        composeId: (stack.body as { composeId: string }).composeId,
        domainType: 'compose',
        serviceName: 'web',
        port: 80,
      });
    expect(made.status).toBe(201);
    return (stack.body as { composeId: string }).composeId;
  }

  it('prefills each compose Domain with a generated sslip.io host', async () => {
    const res = await request(server)
      .get('/templates/ghost/setup')
      .query({ projectId })
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    const form = res.body as FormBody;
    expect(form.domains).toEqual([
      { name: 'ghost', service: 'ghost', port: 2368, path: '/' },
    ]);
    expect(form.environments).toEqual([
      expect.objectContaining({ environmentId, canTake: true }),
    ]);
    expect(form.environments[0].hosts?.ghost).toMatch(
      /^ghost-ghost-[0-9a-f]{6}-198-51-100-7\.sslip\.io$/,
    );
  });

  it('plans the stack from its template and Applies the stack, its .env, its encrypted mounts and its Domain', async () => {
    const res = await setUp();

    expect(res.status).toBe(201);
    const body = res.body as SetupBody;
    expect(body.configNames).toEqual(['ghost-app', 'ghost-db']);
    const stackStep = body.plan.steps.find(
      (step) => step.configName === 'ghost-app',
    );
    expect(stackStep).toMatchObject({
      action: 'create',
      kind: 'compose',
      template: {
        templateName: 'Ghost',
        domains: [{ service: 'ghost', port: 2368, path: '/', host: HOST }],
        files: [{ path: 'config.production.json', mount: null }],
      },
    });
    expect(stackStep?.template?.values).toEqual(
      expect.arrayContaining([
        {
          list: 'env',
          variable: 'DB_PASSWORD',
          made: 'generated (password, 32 characters)',
        },
        { list: 'env', variable: 'ADMIN_EMAIL', made: 'asked' },
        { list: 'env', variable: 'SITE_URL', made: 'fixed' },
      ]),
    );
    // The plan names files and hosts, never a value.
    expect(JSON.stringify(body.plan)).not.toContain('ada@example.com');

    const applied = await apply(body.plan.planId);

    expect(applied.status).toBe(200);
    expect((applied.body as PlanBody).status).toBe('applied');
    const [stack] = await ctx.db
      .select()
      .from(compose)
      .where(eq(compose.configName, 'ghost-app'));
    expect(stack).toMatchObject({
      sourceType: 'raw',
      composeType: 'docker-compose',
      composeFile: COMPOSE_FILE,
    });
    const env = parseDotenv(stack.env ?? '');
    expect(env.ADMIN_EMAIL).toBe('ada@example.com');
    expect(env.SITE_URL).toBe(`https://${HOST}`);
    expect(env.DB_PASSWORD).toMatch(/^[A-Za-z0-9]{32}$/);
    // An answer the compose file reads with a default is written, so it
    // wins over that default (#1406); a blank one is left out, so
    // `\${LOCALE-en}` still falls back to its default rather than to ''.
    expect(env.TZ).toBe('Asia/Karachi');
    expect(env).not.toHaveProperty('LOCALE');

    // The stack's config file, filled in once, and encrypted at rest.
    const mounts = await ctx.db
      .select()
      .from(mount)
      .where(eq(mount.composeId, stack.composeId));
    expect(mounts).toEqual([
      expect.objectContaining({
        type: 'file',
        filePath: 'config.production.json',
        mountPath: '',
        content: `{ "url": "https://${HOST}", "mail": "ada@example.com", "theme": "{{ theme }}" }`,
      }),
    ]);
    const raw = await ctx.db.execute<{ content: string }>(
      sql`select content from mount where compose_id = ${stack.composeId}`,
    );
    expect(raw.rows[0].content).toMatch(/^enc:v1:/);

    // The own postgres mounts its file where the template says.
    const [db] = await ctx.db
      .select()
      .from(postgres)
      .where(eq(postgres.configName, 'ghost-db'));
    expect(
      await ctx.db
        .select()
        .from(mount)
        .where(eq(mount.postgresId, db.postgresId)),
    ).toEqual([
      expect.objectContaining({
        filePath: 'init.sql',
        mountPath: '/docker-entrypoint-initdb.d/init.sql',
        content: `-- for ${HOST}\n`,
      }),
    ]);

    expect(
      await ctx.db
        .select()
        .from(domain)
        .where(eq(domain.composeId, stack.composeId)),
    ).toEqual([
      expect.objectContaining({
        host: HOST,
        path: '/',
        port: 2368,
        serviceName: 'ghost',
        domainType: 'compose',
        https: true,
      }),
    ]);
    // Its first Deployment is queued.
    expect(
      queue.jobs.some(
        (job) =>
          (job.data as { composeId?: string }).composeId === stack.composeId,
      ),
    ).toBe(true);
    // Used up.
    expect(await ctx.db.select().from(pendingSetup)).toEqual([]);

    // Console-managed from here on: the next plan leaves it alone.
    const checked = await request(server)
      .post(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);
    expect(checked.status).toBe(201);
    expect(
      (checked.body as PlanBody).steps.filter(
        (step) => step.configName === 'ghost-app',
      ),
    ).toEqual([]);
  });

  /** The stack's `.env` and Domains after setting it up on `hosts` and Applying. */
  async function appliedOn(hosts: Record<string, string>) {
    const res = await setUp(hosts);
    expect(res.status).toBe(201);
    const applied = await apply((res.body as SetupBody).plan.planId);
    expect(applied.status).toBe(200);
    expect((applied.body as PlanBody).status).toBe('applied');
    const [stack] = await ctx.db
      .select()
      .from(compose)
      .where(eq(compose.configName, 'ghost-app'));
    return {
      env: parseDotenv(stack.env ?? ''),
      domains: await ctx.db
        .select()
        .from(domain)
        .where(eq(domain.composeId, stack.composeId)),
    };
  }

  it('serves an sslip.io host the user typed over HTTPS with a Let’s Encrypt certificate, as an Application Domain on one is (#1411)', async () => {
    const typed = 'ghost-198-51-100-7.sslip.io';

    const { env, domains } = await appliedOn({ ghost: typed });

    expect(env.SITE_URL).toBe(`https://${typed}`);
    expect(domains).toEqual([
      expect.objectContaining({
        host: typed,
        https: true,
        certificateType: 'letsencrypt',
      }),
    ]);
  });

  it('keeps the host the form generated plain HTTP, as a plan-made web’s generated Domain is (#1411)', async () => {
    const form = await request(server)
      .get('/templates/ghost/setup')
      .query({ projectId })
      .set('Cookie', cookie);
    const generated = (form.body as FormBody).environments[0].hosts?.ghost;
    expect(generated).toBeDefined();

    const { env, domains } = await appliedOn({ ghost: generated! });

    expect(env.SITE_URL).toBe(`http://${generated}`);
    expect(domains).toEqual([
      expect.objectContaining({
        host: generated,
        https: false,
        certificateType: 'none',
      }),
    ]);
  });

  it('refuses a host already taken at setup, saving nothing', async () => {
    await takeHost(HOST);

    const res = await setUp();

    expect(res.status).toBe(409);
    expect((res.body as { message: string }).message).toMatch(
      /^The host blog\.example\.com is taken: /,
    );
    expect(await ctx.db.select().from(pendingSetup)).toEqual([]);
  });

  it('refuses a host taken after setup, at the next Plan and at Apply, writing nothing', async () => {
    const body = (await setUp()).body as SetupBody;
    const othersStack = await takeHost(HOST);

    const replanned = await request(server)
      .post(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);
    expect(replanned.status).toBe(409);
    expect((replanned.body as { message: string }).message).toContain(
      `ghost-app: its Domain ${HOST} is taken`,
    );

    const applied = await apply(body.plan.planId);

    expect(applied.status).toBe(409);
    expect((applied.body as { message: string }).message).toContain(
      `ghost-app: its Domain ${HOST} is taken`,
    );
    // Nothing written: no stack but the other Project's, no database, and
    // the Pending setup whole.
    expect(
      (await ctx.db.select().from(compose)).map((row) => row.composeId),
    ).toEqual([othersStack]);
    expect(await ctx.db.select().from(postgres)).toEqual([]);
    const [kept] = await ctx.db.select().from(pendingSetup);
    expect(kept.parts.map((part) => part.configName)).toEqual([
      'ghost-app',
      'ghost-db',
    ]);
  });

  it('deletes the stack’s row again when a write after it fails, keeping the part for the next Plan', async () => {
    const body = (await setUp()).body as SetupBody;
    // The stack's config file cannot be written where it runs.
    execMock.execAsync.mockImplementation((command: string) =>
      command.includes('config.production.json')
        ? Promise.reject(new Error('disk full'))
        : succeeds(command),
    );

    const applied = await apply(body.plan.planId);

    expect(applied.status).toBe(200);
    const result = applied.body as PlanBody;
    expect(result.status).toBe('partly-applied');
    expect(
      result.results.find((one) => one.configName === 'ghost-app'),
    ).toMatchObject({ status: 'failed' });
    // All or nothing: no row, no mount, no Domain.
    expect(
      await ctx.db
        .select()
        .from(compose)
        .where(eq(compose.configName, 'ghost-app')),
    ).toEqual([]);
    expect(await ctx.db.select().from(domain)).toEqual([]);
    // The database was made; the stack waits in the Pending setup.
    expect(await ctx.db.select().from(postgres)).toHaveLength(1);
    const [kept] = await ctx.db.select().from(pendingSetup);
    expect(kept.parts.map((part) => part.configName)).toEqual(['ghost-app']);
    expect(kept.body.composeFile).toBe(COMPOSE_FILE);
  });
});
