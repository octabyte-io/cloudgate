import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  application,
  auditLog,
  pendingSetup,
  plan as planTable,
  server as serverTable,
  webServerSettings,
} from '../../src/db/schema';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { FETCH_CLIENT } from '../../src/git-providers/fetch.provider';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { PendingSetupAutoApply } from '../../src/templates/setup/pending-setup-auto-apply.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { isPresenceProbe } from '../utils/workload-presence-probe';
import {
  CatalogueHost,
  catalogueFile,
  webTemplate,
} from './catalogue-host.fixture';

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

/** One own `web` each: they run on every Deploy target. */
const KUMA = webTemplate('kuma');
const LINK = webTemplate('link');

interface PlanBody {
  planId: string;
  environmentId: string;
  status: string;
}

interface SetupBody {
  pendingSetup: { pendingSetupId: string; environmentId: string };
  setupRecord: { projectId: string };
  plan: PlanBody;
}

interface ListedBody {
  pendingSetups: {
    pendingSetupId: string;
    autoApply: {
      status: string;
      waitingFor: string | null;
      message: string | null;
    } | null;
  }[];
}

/**
 * The get-started wizard's setup (ADR-0073): with `autoApply`, Cloudgate
 * applies the setup's plan itself, as the person who set it up, once the
 * Server it deploys to is Ready and set up; at once when it is already.
 */
describe('Template setup with autoApply (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
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
    http = ctx.app.getHttpServer() as App;
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
    host.served = { body: catalogueFile(KUMA, LINK) };
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

    const res = await request(http).post('/api/auth/sign-up/email').send(owner);
    expect(res.status).toBe(200);
    cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const orgs = await request(http)
      .get('/organizations')
      .set('Cookie', cookie);
    organizationId = (orgs.body as { id: string }[])[0].id;
    // A generated Domain needs the platform host's public address.
    await ctx.db.insert(webServerSettings).values({ serverIp: '198.51.100.7' });
    // Opening the templates screen saves the catalogue copy setup reads.
    expect(
      (await request(http).get('/templates').set('Cookie', cookie)).status,
    ).toBe(200);
  });

  /** An own Server of this Organization; never set up unless `setupOk` says. */
  async function ownServer(setupOk: boolean | null = null): Promise<string> {
    const [row] = await ctx.db
      .insert(serverTable)
      .values({
        name: 'web-1',
        ipAddress: '203.0.113.9',
        port: 22,
        organizationId,
        setupOk,
      })
      .returning();
    return row.serverId;
  }

  const setUp = (body: Record<string, unknown>) =>
    request(http)
      .post('/templates/setup')
      .set('Cookie', cookie)
      .send({
        templateId: 'kuma',
        setupName: 'kuma',
        autoApply: true,
        ...body,
      });

  const listed = async (environmentId: string) =>
    (
      await request(http)
        .get(`/environments/${environmentId}/pending-setups`)
        .set('Cookie', cookie)
    ).body as ListedBody;

  const planOf = async (environmentId: string) =>
    (
      (
        await request(http)
          .get(`/environments/${environmentId}/plan`)
          .set('Cookie', cookie)
      ).body as { plan: PlanBody }
    ).plan;

  it('applies the plan at once when its Server is set up already, and records the Apply as the person who set it up', async () => {
    const serverId = await ownServer(true);
    const res = await setUp({
      newProject: {
        name: 'status',
        deployTarget: { kind: 'server', serverId },
      },
    });

    expect(res.status).toBe(201);
    const body = res.body as SetupBody;
    expect(body.plan.status).toBe('applied');
    const [app] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.configName, 'kuma-app'));
    expect(app.environmentId).toBe(body.pendingSetup.environmentId);
    // Every part made: nothing is left waiting.
    expect(await ctx.db.select().from(pendingSetup)).toEqual([]);

    const rows = await ctx.db.select().from(auditLog);
    const apply = rows.find(
      (row) =>
        row.resourceId === body.pendingSetup.environmentId &&
        (row.metadata ?? '').includes('"autoApply":true'),
    );
    expect(apply).toMatchObject({
      organizationId,
      userEmail: owner.email,
      resourceType: 'environment',
      outcome: 'succeeded',
    });
    expect(JSON.parse(apply!.metadata!)).toMatchObject({
      route: 'POST /environments/:environmentId/plan/apply',
      pendingSetupId: body.pendingSetup.pendingSetupId,
      planId: body.plan.planId,
    });
  });

  it('waits for its Server to be set up, saying what for, then applies on the next look', async () => {
    const serverId = await ownServer();
    const res = await setUp({
      newProject: {
        name: 'status',
        deployTarget: { kind: 'server', serverId },
      },
    });
    expect(res.status).toBe(201);
    const body = res.body as SetupBody;
    const { environmentId, pendingSetupId } = body.pendingSetup;

    // Not applied: the plan waits, and the setup says why.
    expect(body.plan.status).toBe('open');
    expect(await ctx.db.select().from(application)).toEqual([]);
    expect((await listed(environmentId)).pendingSetups).toEqual([
      expect.objectContaining({
        pendingSetupId,
        autoApply: {
          status: 'waiting',
          waitingFor:
            "web-1 has not been set up yet. Run setup on the Server's page",
          message: null,
        },
      }),
    ]);

    // A look before it is set up changes nothing.
    await ctx.app.get(PendingSetupAutoApply).tick();
    expect((await planOf(environmentId)).status).toBe('open');

    await ctx.db
      .update(serverTable)
      .set({ setupOk: true })
      .where(eq(serverTable.serverId, serverId));
    await ctx.app.get(PendingSetupAutoApply).tick();

    expect((await planOf(environmentId)).status).toBe('applied');
    const [app] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.configName, 'kuma-app'));
    expect(app.serverId).toBe(serverId);
    expect(await ctx.db.select().from(pendingSetup)).toEqual([]);
  });

  it('gives up, saying why, when the plan holds more than the setup, and leaves the plan open', async () => {
    const serverId = await ownServer();
    const first = (
      await setUp({
        newProject: {
          name: 'status',
          deployTarget: { kind: 'server', serverId },
        },
      })
    ).body as SetupBody;
    const { environmentId } = first.pendingSetup;
    // A second template set up beside it: the plan now holds both.
    const second = await setUp({
      templateId: 'link',
      setupName: 'link',
      projectId: first.setupRecord.projectId,
      environmentId,
    });
    expect(second.status).toBe(201);

    await ctx.db
      .update(serverTable)
      .set({ setupOk: true })
      .where(eq(serverTable.serverId, serverId));
    await ctx.app.get(PendingSetupAutoApply).tick();

    // Nothing applied on anyone's behalf.
    expect(await ctx.db.select().from(application)).toEqual([]);
    const open = await planOf(environmentId);
    expect(open.status).toBe('open');
    const { pendingSetups } = await listed(environmentId);
    expect(pendingSetups).toHaveLength(2);
    for (const one of pendingSetups) {
      expect(one.autoApply).toEqual({
        status: 'refused',
        waitingFor: null,
        message: expect.stringContaining(
          "The Environment's plan holds more than this app",
        ) as string,
      });
    }

    // The plan is still anyone's to Apply by hand.
    const applied = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: open.planId });
    expect(applied.status).toBe(200);
  });

  it('gives up when its Server is deleted while it waits', async () => {
    const serverId = await ownServer();
    const body = (
      await setUp({
        newProject: {
          name: 'status',
          deployTarget: { kind: 'server', serverId },
        },
      })
    ).body as SetupBody;

    await ctx.db.delete(serverTable).where(eq(serverTable.serverId, serverId));
    await ctx.app.get(PendingSetupAutoApply).tick();

    const [row] = await ctx.db
      .select()
      .from(pendingSetup)
      .where(eq(pendingSetup.pendingSetupId, body.pendingSetup.pendingSetupId));
    expect(row).toMatchObject({
      autoApplyState: 'refused',
      autoApplyMessage:
        'The Server this setup was to deploy to no longer exists',
    });
    expect(await ctx.db.select().from(planTable)).toEqual([
      expect.objectContaining({ status: 'open' }),
    ]);
  });

  it('leaves a setup without autoApply for Apply, as always', async () => {
    const res = await setUp({
      autoApply: undefined,
      newProject: { name: 'status', deployTarget: { kind: 'platform-host' } },
    });

    expect(res.status).toBe(201);
    const body = res.body as SetupBody;
    expect(body.plan.status).toBe('open');
    expect(
      (await listed(body.pendingSetup.environmentId)).pendingSetups,
    ).toEqual([expect.objectContaining({ autoApply: null })]);
    await ctx.app.get(PendingSetupAutoApply).tick();
    expect(await ctx.db.select().from(application)).toEqual([]);
  });

  it('refuses an autoApply that is not true or false', async () => {
    const res = await setUp({
      autoApply: 'yes',
      newProject: { name: 'status', deployTarget: { kind: 'platform-host' } },
    });

    expect(res.status).toBe(400);
  });
});
