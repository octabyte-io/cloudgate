import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  application,
  cloudAccount,
  environment,
  licenseKey,
  member,
  organizationRole,
  pendingSetup,
  plan as planTable,
  project,
  projectConfigLocation,
  setupRecord,
  webServerSettings,
} from '../../src/db/schema';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
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
  webTemplate,
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

/** One own `web`: it runs on every Deploy target. */
const KUMA = webTemplate('kuma');

/** One own `web` that asks for an email. */
const MAIL: Folder = {
  id: 'mail',
  files: {
    ...KUMA.files,
    'template.yaml': `${KUMA.files['template.yaml']}inputs:
  ADMIN_EMAIL: { ask: { label: Admin email, format: email } }
`,
    'cloudgate.yaml': `version: 1
services:
  app:
    kind: web
    source: { image: "louislam/uptime-kuma:1.23" }
    env: [ADMIN_EMAIL]
`,
  },
};

/**
 * An own `web` that mounts a config file, which no Cloud Environment takes:
 * a Service in a Cloud account has no container to mount it in.
 */
const MOUNTED: Folder = {
  id: 'mounted',
  files: {
    ...KUMA.files,
    'template.yaml': `${KUMA.files['template.yaml']}files:
  - { path: app.conf, entry: app, mount: /etc/app/app.conf }
`,
    'files/app.conf': 'listen 3001\n',
  },
};

/** A compose part: on a Server, the platform host or its own Stack VM (#1379). */
const STACK: Folder = {
  id: 'stack',
  files: {
    'template.yaml': `name: Stack
description: A compose part.
tags: [demo]
cloudgate: 0.1.0
compose: app
`,
    'cloudgate.yaml': `version: 1
services:
  app: { kind: compose, managed: console }
`,
    'docker-compose.yml': 'services:\n  web:\n    image: nginx:1.27\n',
    'logo.svg': SQUARE_SVG,
  },
};

interface PlanBody {
  planId: string;
  environmentId: string;
  status: string;
  steps: { action: string; configName: string }[];
}

interface SetupBody {
  configNames: string[];
  pendingSetup: { environmentId: string };
  setupRecord: { projectId: string };
  plan: PlanBody;
}

/**
 * "New Project from a template" (#1376): setup makes a Project with a
 * Cloudgate-kept config and its `production` Environment on the Deploy
 * target picked, then sets up into it as into an existing one.
 */
describe('Template setup into a new Project (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let cookie: string;
  let organizationId: string;
  const host = new CatalogueHost();
  const queue = {
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    getJobs: jest.fn().mockResolvedValue([]),
    cancel: jest.fn(),
    clearWaiting: jest.fn().mockResolvedValue([]),
  };
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
    host.served = { body: catalogueFile(KUMA, MAIL, STACK, MOUNTED) };
    queue.add.mockClear();
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
    // A generated Domain needs the platform host's public address.
    await ctx.db.insert(webServerSettings).values({ serverIp: '198.51.100.7' });

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
        templateId: 'kuma',
        newProject: { name: 'status', deployTarget: { kind: 'platform-host' } },
        setupName: 'kuma',
        ...body,
      });

  async function nothingSaved() {
    expect(await ctx.db.select().from(project)).toEqual([]);
    expect(await ctx.db.select().from(environment)).toEqual([]);
    expect(await ctx.db.select().from(pendingSetup)).toEqual([]);
    expect(await ctx.db.select().from(setupRecord)).toEqual([]);
    expect(await ctx.db.select().from(planTable)).toEqual([]);
  }

  it('answers the setup form with no Project, saying which Deploy targets can take the template', async () => {
    const res = await request(server)
      .get('/templates/mounted/setup')
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      templateId: 'mounted',
      environments: [],
      // An own part's config file has no container to mount in in a cloud.
      deployTargets: {
        server: null,
        platformHost: null,
        aws: expect.any(String) as string,
        gcp: expect.any(String) as string,
      },
    });

    // A compose part runs on a Server (#1373), or in a cloud on its own
    // Stack VM (#1379).
    for (const id of ['kuma', 'stack']) {
      const form = await request(server)
        .get(`/templates/${id}/setup`)
        .set('Cookie', cookie);
      expect(form.body).toMatchObject({
        deployTargets: {
          server: null,
          platformHost: null,
          aws: null,
          gcp: null,
        },
      });
    }
  });

  it('makes the Project, its Cloudgate-kept config and its production Environment, then sets up into it', async () => {
    const res = await setUp();

    expect(res.status).toBe(201);
    const body = res.body as SetupBody;
    const [made] = await ctx.db
      .select()
      .from(project)
      .where(eq(project.projectId, body.setupRecord.projectId));
    expect(made.name).toBe('status');
    const [location] = await ctx.db
      .select()
      .from(projectConfigLocation)
      .where(eq(projectConfigLocation.projectId, made.projectId));
    expect(location.kind).toBe('cloudgate');
    const environments = await ctx.db
      .select()
      .from(environment)
      .where(eq(environment.projectId, made.projectId));
    expect(environments).toHaveLength(1);
    expect(environments[0]).toMatchObject({
      environmentId: body.pendingSetup.environmentId,
      name: 'production',
      deployTarget: { kind: 'platform-host' },
    });

    // The Plan in that Environment, as for an existing Project.
    expect(body.configNames).toEqual(['kuma-app']);
    expect(body.plan.environmentId).toBe(environments[0].environmentId);
    expect(body.plan.steps).toContainEqual(
      expect.objectContaining({ action: 'create', configName: 'kuma-app' }),
    );

    const applied = await request(server)
      .post(`/environments/${environments[0].environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: body.plan.planId });
    expect(applied.status).toBe(200);
    expect((applied.body as PlanBody).status).toBe('applied');
    const [app] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.configName, 'kuma-app'));
    expect(app.environmentId).toBe(environments[0].environmentId);
    expect(await ctx.db.select().from(pendingSetup)).toEqual([]);
  });

  it('leaves the Project empty when its Plan is dismissed', async () => {
    const body = (await setUp()).body as SetupBody;

    const dismissed = await request(server)
      .post(`/environments/${body.pendingSetup.environmentId}/plan/dismiss`)
      .set('Cookie', cookie)
      .send({ planId: body.plan.planId });

    expect(dismissed.status).toBe(200);
    expect(await ctx.db.select().from(pendingSetup)).toEqual([]);
    expect(await ctx.db.select().from(project)).toHaveLength(1);
    expect(await ctx.db.select().from(environment)).toHaveLength(1);
  });

  it('refuses a Project name already taken, saving nothing more', async () => {
    expect(
      (
        await request(server)
          .post('/projects')
          .set('Cookie', cookie)
          .send({ name: 'status' })
      ).status,
    ).toBe(201);

    const res = await setUp();

    expect(res.status).toBe(409);
    expect(await ctx.db.select().from(project)).toHaveLength(1);
    expect(await ctx.db.select().from(environment)).toEqual([]);
    expect(await ctx.db.select().from(pendingSetup)).toEqual([]);
  });

  it('refuses a request naming both an existing Project and a new one', async () => {
    const res = await setUp({ projectId: 'p-1', environmentId: 'e-1' });

    expect(res.status).toBe(400);
    await nothingSaved();
  });

  it('checks eligibility against the picked Deploy target, before anything is saved', async () => {
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

    const res = await setUp({
      templateId: 'mounted',
      setupName: 'mounted',
      newProject: {
        name: 'status',
        deployTarget: {
          kind: 'cloud',
          cloudAccountId: account.cloudAccountId,
          region: 'eu-central-1',
        },
      },
    });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'TEMPLATE_SETUP_REFUSED' });
    await nothingSaved();
  });

  it('refuses an asked value that fails its check before the Project is made', async () => {
    const res = await setUp({
      templateId: 'mail',
      setupName: 'mail',
      values: { ADMIN_EMAIL: 'not-an-email' },
    });

    expect(res.status).toBe(400);
    await nothingSaved();
  });

  /** A licensed custom role holding every statement setup asks but `missing`. */
  async function memberWithout(missing: 'project' | 'environment' | null) {
    const fixture = await signUpMember(server, cookie);
    const permission: Record<string, string[]> = {
      project: ['create'],
      environment: ['create', 'read', 'update'],
      service: ['create', 'read', 'update'],
      deployment: ['create', 'read'],
    };
    if (missing === 'project') permission.project = [];
    if (missing === 'environment') permission.environment = ['read'];
    await ctx.db.insert(licenseKey).values({
      organizationId,
      key: 'test-license-key',
      status: 'active',
      enableEnterpriseFeatures: true,
    });
    await ctx.db
      .insert(organizationRole)
      .values({ organizationId, role: 'template-setter', permission });
    await ctx.db
      .update(member)
      .set({ role: 'template-setter' })
      .where(eq(member.userId, fixture.id));
    return fixture;
  }

  it('lets a member whose role holds every statement set up a new Project', async () => {
    const fixture = await memberWithout(null);

    const res = await setUp({}, fixture.cookie);

    expect(res.status).toBe(201);
  });

  it.each(['project', 'environment'] as const)(
    'refuses a member without %s: create before anything is saved',
    async (missing) => {
      const fixture = await memberWithout(missing);

      const res = await setUp({}, fixture.cookie);

      expect(res.status).toBe(403);
      await nothingSaved();
    },
  );
});
