import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { member, pendingSetup, setupRecord } from '../../src/db/schema';
import { FETCH_CLIENT } from '../../src/git-providers/fetch.provider';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { SchedulingService } from '../../src/scheduling/scheduling.service';
import {
  PENDING_SETUP_SWEEP_JOB_ID,
  PendingSetupSweep,
} from '../../src/templates/setup/pending-setup-sweep.service';
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

const DAY_MS = 24 * 60 * 60 * 1000;

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
`,
    'logo.svg': SQUARE_SVG,
  },
};

interface PlanBody {
  planId: string;
  status: string;
  steps: { configName: string; template?: { setupName: string } }[];
}

interface ListedSetup {
  pendingSetupId: string;
  templateId: string;
  templateName: string;
  setupName: string;
  configNames: string[];
  createdAt: string;
  expiresAt: string;
  values: {
    configName: string;
    variable: string;
    made: string;
    hasValue: boolean;
  }[];
}

interface ListBody {
  pendingSetups: ListedSetup[];
  expired: {
    templateId: string;
    templateName: string;
    setupName: string;
    configNames: string[];
    setUpAt: string;
    expiredAt: string;
  }[];
}

/**
 * The Pending setup lifecycle (#1374): listed on its Environment, cancelled
 * there, dropped by a dismissed Plan and kept by a superseded one, and
 * dropped with a note by the 30-day sweep. Setup runs through the API against
 * a stubbed catalogue host.
 */
describe('Pending setups (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let cookie: string;
  let projectId: string;
  let environmentId: string;
  const host = new CatalogueHost();
  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
    execRemote: jest.fn(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: FETCH_CLIENT, useValue: host.fetch },
        { provide: RemoteExecService, useValue: execMock },
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
    execMock.execAsync.mockReset().mockImplementation((command: string) =>
      Promise.resolve({
        stdout: isPresenceProbe(command) ? 'absent' : '',
        stderr: '',
      }),
    );
    execMock.execAsyncRemote
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '' });
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

  const setUp = async (setupName = 'ghost') => {
    const res = await request(server)
      .post('/templates/setup')
      .set('Cookie', cookie)
      .send({
        templateId: 'ghost',
        projectId,
        environmentId,
        setupName,
        values: { ADMIN_EMAIL: 'ada@example.com' },
      });
    expect(res.status).toBe(201);
    return res.body as {
      pendingSetup: { pendingSetupId: string };
      plan: PlanBody;
    };
  };

  const list = (as = cookie) =>
    request(server)
      .get(`/environments/${environmentId}/pending-setups`)
      .set('Cookie', as);

  const cancel = (pendingSetupId: string, as = cookie) =>
    request(server)
      .delete(`/environments/${environmentId}/pending-setups/${pendingSetupId}`)
      .set('Cookie', as);

  const openPlan = async () => {
    const res = await request(server)
      .get(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return (res.body as { plan: PlanBody }).plan;
  };

  it('lists the Environment’s Pending setups, each value only as present', async () => {
    const setup = await setUp();

    const res = await list();

    expect(res.status).toBe(200);
    const body = res.body as ListBody;
    expect(body.expired).toEqual([]);
    expect(body.pendingSetups).toHaveLength(1);
    const [listed] = body.pendingSetups;
    expect(listed).toMatchObject({
      pendingSetupId: setup.pendingSetup.pendingSetupId,
      templateId: 'ghost',
      templateName: 'Ghost',
      setupName: 'ghost',
      configNames: ['ghost-app', 'ghost-db'],
    });
    expect(Date.parse(listed.expiresAt) - Date.parse(listed.createdAt)).toBe(
      30 * DAY_MS,
    );
    expect(listed.values).toContainEqual({
      configName: 'ghost-app',
      variable: 'ADMIN_EMAIL',
      made: 'asked',
      hasValue: true,
    });
    // ADR-0019: present, never the value, asked or generated.
    expect(JSON.stringify(body)).not.toContain('ada@example.com');
    expect(listed.values.every((value) => !('value' in value))).toBe(true);
  });

  it('cancels a Pending setup, drops its unused Setup record and re-plans without its parts', async () => {
    const setup = await setUp();

    const res = await cancel(setup.pendingSetup.pendingSetupId);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      pendingSetup: { pendingSetupId: setup.pendingSetup.pendingSetupId },
    });
    expect(await ctx.db.select().from(pendingSetup)).toEqual([]);
    expect(await ctx.db.select().from(setupRecord)).toEqual([]);
    expect(((await list()).body as ListBody).pendingSetups).toEqual([]);
    // The Environment's plan no longer offers parts nothing can fill.
    const plan = await openPlan();
    expect(plan.planId).not.toBe(setup.plan.planId);
    expect(plan.steps.map((step) => step.configName)).not.toContain(
      'ghost-app',
    );
    const stale = await request(server)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: setup.plan.planId });
    expect(stale.status).toBe(409);
  });

  it('keeps the other Pending setups when one is cancelled', async () => {
    const first = await setUp();
    // The second setup's plan carries the first's entries forward.
    const second = await setUp('docs');

    expect((await cancel(first.pendingSetup.pendingSetupId)).status).toBe(200);

    const listed = ((await list()).body as ListBody).pendingSetups;
    expect(listed.map((one) => one.pendingSetupId)).toEqual([
      second.pendingSetup.pendingSetupId,
    ]);
    const plan = await openPlan();
    expect(
      plan.steps.map((step) => [step.configName, step.template?.setupName]),
    ).toEqual(
      expect.arrayContaining([
        ['docs-app', 'docs'],
        ['docs-db', 'docs'],
      ]),
    );
    expect(plan.steps.map((step) => step.configName)).not.toContain(
      'ghost-app',
    );
  });

  it('answers 404 for a Pending setup that is not in the Environment', async () => {
    const res = await cancel('no-such-setup');

    expect(res.status).toBe(404);
  });

  it('drops the Pending setup when its Plan is dismissed, and keeps it when the Plan is only superseded', async () => {
    const setup = await setUp();

    const checked = await request(server)
      .post(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);
    expect(checked.status).toBe(201);
    const newer = checked.body as PlanBody;
    expect(newer.planId).not.toBe(setup.plan.planId);
    // Superseded: still listed.
    expect(((await list()).body as ListBody).pendingSetups).toHaveLength(1);

    const dismissed = await request(server)
      .post(`/environments/${environmentId}/plan/dismiss`)
      .set('Cookie', cookie)
      .send({ planId: newer.planId });
    expect(dismissed.status).toBe(200);

    expect(((await list()).body as ListBody).pendingSetups).toEqual([]);
    expect(await ctx.db.select().from(setupRecord)).toEqual([]);
  });

  it('refuses a member the Environment was not granted to, listing and cancelling nothing', async () => {
    const setup = await setUp();
    const fixture = await signUpMember(server, cookie);
    await ctx.db
      .update(member)
      .set({ accessedProjects: [projectId], accessedEnvironments: [] })
      .where(eq(member.userId, fixture.id));

    expect((await list(fixture.cookie)).status).toBe(403);
    expect(
      (await cancel(setup.pendingSetup.pendingSetupId, fixture.cookie)).status,
    ).toBe(403);
    expect(await ctx.db.select().from(pendingSetup)).toHaveLength(1);
  });

  it('refuses an Agent on both routes, even one whose role holds the statements', async () => {
    const setup = await setUp();
    const created = await request(server)
      .post('/agents')
      .set('Cookie', cookie)
      .send({ name: 'deploy-bot', role: 'agentOperator' });
    expect(created.status).toBe(201);
    const { key } = created.body as { key: string };

    const listed = await request(server)
      .get(`/environments/${environmentId}/pending-setups`)
      .set('x-api-key', key);
    const cancelled = await request(server)
      .delete(
        `/environments/${environmentId}/pending-setups/${setup.pendingSetup.pendingSetupId}`,
      )
      .set('x-api-key', key);

    for (const res of [listed, cancelled]) {
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'AGENT_NOT_ALLOWED_HERE' });
    }
    expect(await ctx.db.select().from(pendingSetup)).toHaveLength(1);
  });

  describe('the 30-day sweep', () => {
    it('is scheduled', () => {
      expect(ctx.app.get(SchedulingService).ids()).toContain(
        PENDING_SETUP_SWEEP_JOB_ID,
      );
    });

    it('drops a Pending setup older than 30 days with a note, and keeps a younger one', async () => {
      const old = await setUp();
      const young = await setUp('docs');
      const now = Date.now();
      await ctx.db
        .update(pendingSetup)
        .set({ createdAt: new Date(now - 31 * DAY_MS).toISOString() })
        .where(
          eq(pendingSetup.pendingSetupId, old.pendingSetup.pendingSetupId),
        );
      await ctx.db
        .update(pendingSetup)
        .set({ createdAt: new Date(now - 29 * DAY_MS).toISOString() })
        .where(
          eq(pendingSetup.pendingSetupId, young.pendingSetup.pendingSetupId),
        );

      const swept = await ctx.app.get(PendingSetupSweep).sweep(new Date(now));

      expect(swept).toEqual([old.pendingSetup.pendingSetupId]);
      const body = (await list()).body as ListBody;
      expect(body.pendingSetups.map((one) => one.pendingSetupId)).toEqual([
        young.pendingSetup.pendingSetupId,
      ]);
      expect(body.expired).toEqual([
        expect.objectContaining({
          templateId: 'ghost',
          templateName: 'Ghost',
          setupName: 'ghost',
          configNames: ['ghost-app', 'ghost-db'],
          setUpAt: new Date(now - 31 * DAY_MS).toISOString(),
        }),
      ]);
      // Its Setup record recorded nothing else, so it went with it.
      const records = await ctx.db.select().from(setupRecord);
      expect(records.map((record) => record.setupName)).toEqual(['docs']);
      // The note holds nothing of the setup's values.
      const raw = await ctx.db.execute(sql`select * from expired_setup`);
      expect(JSON.stringify(raw.rows)).not.toContain('ada@example.com');
    });

    it('removes a note once it is itself 30 days old', async () => {
      const old = await setUp();
      const now = Date.now();
      await ctx.db
        .update(pendingSetup)
        .set({ createdAt: new Date(now - 31 * DAY_MS).toISOString() })
        .where(
          eq(pendingSetup.pendingSetupId, old.pendingSetup.pendingSetupId),
        );
      const sweep = ctx.app.get(PendingSetupSweep);
      await sweep.sweep(new Date(now));
      expect(((await list()).body as ListBody).expired).toHaveLength(1);

      await sweep.sweep(new Date(now + 31 * DAY_MS));

      expect(((await list()).body as ListBody).expired).toEqual([]);
    });
  });
});
