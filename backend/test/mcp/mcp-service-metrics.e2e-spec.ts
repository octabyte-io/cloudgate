import { asc, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { ApplicationsService } from '../../src/applications/applications.service';
import { ComposeService } from '../../src/compose/compose.service';
import { PostgresService } from '../../src/databases/postgres/postgres.service';
import {
  application,
  auditLog,
  cloudAccount,
  compose,
  containerMetric,
} from '../../src/db/schema';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import type { PermissionCtx } from '../../src/rbac/permission.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { defaultMetricsConfig, server } from '../../src/servers/server.schema';
import { ServersService } from '../../src/servers/servers.service';
import { SshKeysService } from '../../src/ssh-keys/ssh-keys.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(180_000);

/**
 * A Service's container metrics over MCP (spec #189, ADR-0096): a real Agent
 * key against the real `POST /mcp`, asserting on the answers and the audit
 * rows.
 *
 * The samples are written as `container_metric` rows, in the shape the
 * collector stores (`container-stats.collector.ts`), because producing them
 * through `docker stats` is the monitoring suite's subject. The Server's
 * monitoring config is written onto its row for the same reason. Every figure
 * expected below is worked out by hand from the samples written here.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const FINALITY =
  'This is an access decision, not a failure. Retrying, or trying another tool or id, will not change it. Tell the operator what you needed.';
const NOT_FOUND_OR_NOT_PERMITTED = `Not found or not permitted. ${FINALITY}`;

/** Never in an MCP answer: the host's exclude list, the operator's config. */
const EXCLUDE_MARKER = 'exclude-marker-7c1d9e';

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

type Json = Record<string, unknown>;

/** One stored sample, as the collector writes it. */
interface Sample {
  minutesAgo: number;
  cpu: number;
  memory: [used: number, unit: string, percentage: number];
  total?: [number, string];
  network?: [
    input: number,
    inputUnit: string,
    output: number,
    outputUnit: string,
  ];
  disk?: [read: number, readUnit: string, write: number, writeUnit: string];
}

describe('MCP get_service_metrics (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let ownerCookie: string;
  let ownerId: string;
  let organizationId: string;
  let answers: string[] = [];
  const now = Date.now();

  const ok = { stdout: '', stderr: '', exitCode: 0 };
  const execMock = {
    execAsync: jest.fn().mockResolvedValue(ok),
    execAsyncRemote: jest.fn().mockResolvedValue(ok),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: execMock }],
    });
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    answers = [];
    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    ownerCookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    ownerId = (res.body as { user: { id: string } }).user.id;
    const active = await request(httpServer)
      .get('/organizations/active')
      .set('Cookie', ownerCookie);
    organizationId = (active.body as { id: string }).id;
  });

  afterEach(() => {
    for (const text of answers) expect(text).not.toContain(EXCLUDE_MARKER);
  });

  const ctxIn = (orgId: string): PermissionCtx => ({
    user: { id: ownerId },
    session: { activeOrganizationId: orgId },
  });

  /** A Server of the owner's, with monitoring set up or not. */
  async function aServer(name: string, setUp: boolean): Promise<string> {
    const home = ctxIn(organizationId);
    const key = await ctx.app
      .get(SshKeysService)
      .create(home, { name: `${name}-key` });
    const created = await ctx.app.get(ServersService).create(home, {
      name,
      ipAddress: '203.0.113.10',
      port: 22,
      username: 'root',
      sshKeyId: key.sshKeyId,
    });
    if (setUp) {
      await ctx.db
        .update(server)
        .set({
          metricsConfig: {
            ...defaultMetricsConfig,
            server: {
              ...defaultMetricsConfig.server,
              token: 'metrics-token',
              cronJob: '0 0 * * *',
            },
            containers: {
              refreshRate: 10,
              services: {
                include: ['web-app', 'worker-app', 'shop'],
                exclude: [EXCLUDE_MARKER],
              },
            },
          },
        })
        .where(eq(server.serverId, created.serverId));
    }
    return created.serverId;
  }

  /**
   * One Environment holding, on a monitored Server, a granted Web, a granted
   * Shop that was never sampled beside a granted My Shop that was, and an
   * ungranted Worker; a Compose on a Server without monitoring; a Postgres on
   * the platform host, which has none either; an Application in a Cloud
   * account; and an Application in another Organization.
   */
  async function tree() {
    const home = ctxIn(organizationId);
    const project = await ctx.app
      .get(ProjectsService)
      .create(home, { name: 'shop' });
    const env = await ctx.app.get(EnvironmentsService).create(home, {
      name: 'production',
      projectId: project.projectId,
    });
    const applications = ctx.app.get(ApplicationsService);
    const create = (name: string, appName: string) =>
      applications.create(home, {
        name,
        appName,
        environmentId: env.environmentId,
      });
    const web = await create('Web', 'web-app');
    const worker = await create('Worker', 'worker-app');
    const shop = await create('Shop', 'shop');
    const myShop = await create('My Shop', 'myshop');
    const cloud = await create('Api', 'cloud-api');
    const stack = await ctx.app.get(ComposeService).create(home, {
      name: 'Stack',
      appName: 'stack-app',
      environmentId: env.environmentId,
    });
    const database = await ctx.app.get(PostgresService).create(home, {
      name: 'Orders',
      appName: 'orders-db',
      databaseName: 'orders',
      databaseUser: 'orders',
      databasePassword: 'orders-password-1',
      environmentId: env.environmentId,
    });

    const monitored = await aServer('monitored', true);
    const unmonitored = await aServer('unmonitored', false);
    for (const one of [web, worker, shop, myShop]) {
      await ctx.db
        .update(application)
        .set({ serverId: monitored })
        .where(eq(application.applicationId, one.applicationId));
    }
    await ctx.db
      .update(compose)
      .set({ serverId: unmonitored })
      .where(eq(compose.composeId, stack.composeId));

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
        externalId: 'external-id-1',
        policyVersion: 3,
        lastCheckedAt: new Date().toISOString(),
        lastCheckResult: 'passed',
      })
      .returning();
    await ctx.db
      .update(application)
      .set({
        serverId: null,
        cloudAccountId: account.cloudAccountId,
        region: 'eu-central-1',
      })
      .where(eq(application.applicationId, cloud.applicationId));

    const second = await createOrganization(httpServer, ctx.db, ownerCookie, {
      name: 'Elsewhere',
    });
    expect(second.status).toBe(201);
    const elsewhere = ctxIn((second.body as { id: string }).id);
    const foreignProject = await ctx.app
      .get(ProjectsService)
      .create(elsewhere, { name: 'foreign' });
    const foreignEnv = await ctx.app
      .get(EnvironmentsService)
      .create(elsewhere, {
        name: 'production',
        projectId: foreignProject.projectId,
      });
    const foreign = await applications.create(elsewhere, {
      name: 'Foreign',
      appName: 'foreign-app',
      environmentId: foreignEnv.environmentId,
    });

    return {
      projectId: project.projectId,
      environmentId: env.environmentId,
      monitored,
      webId: web.applicationId,
      workerId: worker.applicationId,
      shopId: shop.applicationId,
      myShopId: myShop.applicationId,
      cloudId: cloud.applicationId,
      composeId: stack.composeId,
      postgresId: database.postgresId,
      foreignId: foreign.applicationId,
    };
  }

  type Tree = Awaited<ReturnType<typeof tree>>;

  async function agentFor(
    t: Tree,
    role = 'agentReader',
  ): Promise<{ id: string; key: string }> {
    const res = await request(httpServer)
      .post('/agents')
      .set('Cookie', ownerCookie)
      .send({
        name: `bot-${role}`,
        role,
        grant: {
          accessedProjects: [t.projectId],
          accessedEnvironments: [t.environmentId],
          accessedServices: [
            t.webId,
            t.shopId,
            t.myShopId,
            t.cloudId,
            t.composeId,
            t.postgresId,
          ],
        },
      });
    expect(res.status).toBe(201);
    const body = res.body as { agent: { id: string }; key: string };
    return { id: body.agent.id, key: body.key };
  }

  const at = (minutesAgo: number) =>
    new Date(now - minutesAgo * 60_000).toISOString();

  /** Stored samples of one container, as the collector writes them. */
  async function seed(
    serverId: string,
    containerName: string,
    samples: Sample[],
  ): Promise<void> {
    await ctx.db.insert(containerMetric).values(
      samples.map((sample) => {
        const timestamp = at(sample.minutesAgo);
        const [total, totalUnit] = sample.total ?? [1, 'GB'];
        const [input, inputUnit, output, outputUnit] = sample.network ?? [
          0,
          'B',
          0,
          'B',
        ];
        const [read, readUnit, write, writeUnit] = sample.disk ?? [
          0,
          'B',
          0,
          'B',
        ];
        return {
          timestamp,
          containerId: 'c0ffee',
          containerName,
          serverId,
          metrics: {
            CPU: sample.cpu,
            Memory: {
              used: sample.memory[0],
              usedUnit: sample.memory[1],
              percentage: sample.memory[2],
              total,
              totalUnit,
            },
            Network: { input, output, inputUnit, outputUnit },
            BlockIO: { read, write, readUnit, writeUnit },
            Container: 'c0ffee',
            ID: 'c0ffee',
            Name: containerName,
            timestamp,
          },
        };
      }),
    );
  }

  /** Web's samples: five in the last hour, one two hours ago. */
  async function seedWeb(t: Tree): Promise<void> {
    await seed(t.monitored, 'web-app.1.t6ga2k', [
      { minutesAgo: 120, cpu: 90, memory: [0.5, 'GB', 50] },
      { minutesAgo: 50, cpu: 10, memory: [100, 'MB', 9.77] },
      { minutesAgo: 40, cpu: 20, memory: [200, 'MB', 19.53] },
      { minutesAgo: 30, cpu: 30, memory: [300, 'MB', 29.3] },
      { minutesAgo: 20, cpu: 40, memory: [400, 'MB', 39.06] },
      {
        minutesAgo: 10,
        cpu: 50,
        memory: [500, 'MB', 48.83],
        network: [1.5, 'GB', 250, 'kB'],
        disk: [12, 'MB', 3.4, 'GB'],
      },
    ]);
  }

  async function callTool(
    key: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const res = await request(httpServer)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .set('Authorization', `Bearer ${key}`)
      .set('MCP-Protocol-Version', '2025-06-18')
      .send({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'get_service_metrics', arguments: args },
      });
    expect(res.status).toBe(200);
    answers.push(res.text);
    return (res.body as { result: ToolResult }).result;
  }

  async function read(key: string, args: Record<string, unknown>) {
    const result = await callTool(key, args);
    expect(result.isError).toBeFalsy();
    return JSON.parse(result.content[0].text) as Json;
  }

  async function rowsOf(agentId: string) {
    return (
      await ctx.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.userId, agentId))
        .orderBy(asc(auditLog.createdAt))
    ).map((row) => {
      const metadata = JSON.parse(row.metadata ?? '{}') as {
        tool?: string;
        reason?: string;
      };
      return [
        row.resourceType,
        row.outcome,
        row.resourceId,
        metadata.tool,
        metadata.reason,
      ];
    });
  }

  /** The window an answer says it read, `hours` back from about now. */
  function expectWindow(answer: Json, hours: number): void {
    const since = Date.parse(answer.since as string);
    const until = Date.parse(answer.until as string);
    expect(answer.windowHours).toBe(hours);
    expect(until - since).toBe(hours * 3_600_000);
    expect(until).toBeGreaterThanOrEqual(now);
  }

  it("summarises a granted Service's last hour: CPU and memory now, on average and at peak, memory against its limit, network and disk totals, and a trend", async () => {
    const t = await tree();
    await seedWeb(t);
    const agent = await agentFor(t);

    const answer = await read(agent.key, {
      serviceType: 'application',
      serviceId: t.webId,
    });

    expect(Object.keys(answer).sort()).toEqual([
      'available',
      'cpu',
      'disk',
      'lastSampledAt',
      'memory',
      'network',
      'samples',
      'serviceId',
      'serviceType',
      'since',
      'trend',
      'unavailableReason',
      'until',
      'windowHours',
    ]);
    expectWindow(answer, 1);
    expect(answer).toMatchObject({
      serviceType: 'application',
      serviceId: t.webId,
      available: true,
      unavailableReason: null,
      samples: 5,
      lastSampledAt: at(10),
      cpu: { nowPercent: 50, averagePercent: 30, peakPercent: 50 },
      memory: {
        nowMiB: 500,
        averageMiB: 300,
        peakMiB: 500,
        limitMiB: 1024,
        nowPercent: 48.83,
        peakPercent: 48.83,
      },
      network: { receivedMB: 1500, sentMB: 0.25 },
      disk: { readMB: 12, writtenMB: 3400 },
    });
    expect(answer.trend).toEqual(
      [50, 40, 30, 20, 10].map((minutesAgo, i) => ({
        at: at(minutesAgo),
        cpuPercent: (i + 1) * 10,
        memoryMiB: (i + 1) * 100,
      })),
    );

    expect(await rowsOf(agent.id)).toEqual([
      ['application', 'succeeded', t.webId, 'get_service_metrics', undefined],
    ]);
  });

  it('reads an asked-for window, and refuses one over 24 hours', async () => {
    const t = await tree();
    await seedWeb(t);
    const agent = await agentFor(t, 'agentOperator');

    const three = await read(agent.key, {
      serviceType: 'application',
      serviceId: t.webId,
      hours: 3,
    });
    expectWindow(three, 3);
    expect(three).toMatchObject({
      samples: 6,
      cpu: { nowPercent: 50, averagePercent: 40, peakPercent: 90 },
      // (512 + 100 + 200 + 300 + 400 + 500) / 6
      memory: { averageMiB: 335.33, peakMiB: 512, peakPercent: 50 },
    });

    const day = await read(agent.key, {
      serviceType: 'application',
      serviceId: t.webId,
      hours: 24,
    });
    expectWindow(day, 24);

    const refused = await callTool(agent.key, {
      serviceType: 'application',
      serviceId: t.webId,
      hours: 25,
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).not.toContain('"cpu"');

    expect((await rowsOf(agent.id)).map((row) => [row[1], row[4]])).toEqual([
      ['succeeded', undefined],
      ['succeeded', undefined],
      ['failed', 'invalid-arguments'],
    ]);
  });

  it('carries at most 60 trend points, each the mean of its run of samples', async () => {
    const t = await tree();
    // 120 samples, one every 20 seconds, alternating 10 % and 30 % CPU.
    await seed(
      t.monitored,
      'web-app.1.t6ga2k',
      Array.from({ length: 120 }, (_, i) => ({
        minutesAgo: 50 - i / 3,
        cpu: i % 2 === 0 ? 10 : 30,
        memory: [i % 2 === 0 ? 100 : 300, 'MB', 10] as Sample['memory'],
      })),
    );
    const agent = await agentFor(t);

    const answer = await read(agent.key, {
      serviceType: 'application',
      serviceId: t.webId,
    });

    expect(answer.samples).toBe(120);
    const trend = answer.trend as Json[];
    expect(trend).toHaveLength(60);
    for (const point of trend) {
      expect(point).toMatchObject({ cpuPercent: 20, memoryMiB: 200 });
    }
    expect(trend[59].at).toBe(answer.lastSampledAt);
  });

  it("sums an Application's replicas, collection tick by collection tick", async () => {
    const t = await tree();
    await seed(t.monitored, 'web-app.1.t6ga2k', [
      { minutesAgo: 30, cpu: 10, memory: [100, 'MB', 9.77] },
      { minutesAgo: 20, cpu: 20, memory: [200, 'MB', 19.53] },
      {
        minutesAgo: 10,
        cpu: 30,
        memory: [300, 'MB', 29.3],
        network: [1, 'GB', 100, 'kB'],
        disk: [10, 'MB', 1, 'GB'],
      },
    ]);
    await seed(t.monitored, 'web-app.2.p0q9r8', [
      { minutesAgo: 30, cpu: 40, memory: [400, 'MB', 39.06] },
      { minutesAgo: 20, cpu: 50, memory: [500, 'MB', 48.83] },
      {
        minutesAgo: 10,
        cpu: 60,
        memory: [600, 'MB', 58.59],
        network: [500, 'MB', 150, 'kB'],
        disk: [5, 'MB', 2, 'GB'],
      },
    ]);
    const agent = await agentFor(t);

    const answer = await read(agent.key, {
      serviceType: 'application',
      serviceId: t.webId,
    });

    expect(answer).toMatchObject({
      available: true,
      samples: 3,
      lastSampledAt: at(10),
      // 10 + 40, 20 + 50, 30 + 60
      cpu: { nowPercent: 90, averagePercent: 70, peakPercent: 90 },
      memory: {
        nowMiB: 900,
        averageMiB: 700,
        peakMiB: 900,
        // Two 1 GB limits.
        limitMiB: 2048,
        // 900 of 2048 MiB
        nowPercent: 43.95,
        peakPercent: 43.95,
      },
      // Each replica's last counters: 1000 + 500 MB in, 0.1 + 0.15 MB out.
      network: { receivedMB: 1500, sentMB: 0.25 },
      disk: { readMB: 15, writtenMB: 3000 },
    });
    expect(answer.trend).toEqual([
      { at: at(30), cpuPercent: 50, memoryMiB: 500 },
      { at: at(20), cpuPercent: 70, memoryMiB: 700 },
      { at: at(10), cpuPercent: 90, memoryMiB: 900 },
    ]);
  });

  it("reads every container a Compose runs and sums them, never another Service's", async () => {
    const t = await tree();
    await ctx.db
      .update(compose)
      .set({ serverId: t.monitored })
      .where(eq(compose.composeId, t.composeId));
    await seed(t.monitored, 'stack-app-api-1', [
      { minutesAgo: 20, cpu: 5, memory: [50, 'MB', 4.88] },
      { minutesAgo: 10, cpu: 15, memory: [150, 'MB', 14.65] },
    ]);
    await seed(t.monitored, 'stack-app-worker-1', [
      { minutesAgo: 20, cpu: 25, memory: [250, 'MB', 24.41] },
      { minutesAgo: 10, cpu: 35, memory: [350, 'MB', 34.18] },
    ]);
    // Its name contains the Compose's, but it is not one of its containers.
    await seed(t.monitored, 'stack-apple-1', [
      { minutesAgo: 10, cpu: 99, memory: [990, 'MB', 96.68] },
    ]);
    const agent = await agentFor(t);

    const answer = await read(agent.key, {
      serviceType: 'compose',
      serviceId: t.composeId,
    });

    expect(answer).toMatchObject({
      serviceType: 'compose',
      available: true,
      samples: 2,
      lastSampledAt: at(10),
      cpu: { nowPercent: 50, averagePercent: 40, peakPercent: 50 },
      memory: {
        nowMiB: 500,
        averageMiB: 400,
        peakMiB: 500,
        limitMiB: 2048,
        // 500 of 2048 MiB
        nowPercent: 24.41,
        peakPercent: 24.41,
      },
    });
    expect(answer.trend).toEqual([
      { at: at(20), cpuPercent: 30, memoryMiB: 300 },
      { at: at(10), cpuPercent: 50, memoryMiB: 500 },
    ]);
    expect(await rowsOf(agent.id)).toEqual([
      ['compose', 'succeeded', t.composeId, 'get_service_metrics', undefined],
    ]);
  });

  it('takes no bucket, which runs no container', async () => {
    const t = await tree();
    const agent = await agentFor(t);

    const refused = await callTool(agent.key, {
      serviceType: 'bucket',
      serviceId: t.webId,
    });

    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).not.toContain('"cpu"');
    expect((await rowsOf(agent.id)).map((row) => [row[1], row[4]])).toEqual([
      ['failed', 'invalid-arguments'],
    ]);
  });

  it('answers a Service in a Cloud account, on a Server without monitoring, or on a platform host without it, as which, never as zeros', async () => {
    const t = await tree();
    await seedWeb(t);
    const agent = await agentFor(t);

    const none = (unavailableReason: string) => ({
      available: false,
      unavailableReason,
      samples: 0,
      lastSampledAt: null,
      cpu: null,
      memory: null,
      network: null,
      disk: null,
      trend: [],
    });

    expect(
      await read(agent.key, {
        serviceType: 'application',
        serviceId: t.cloudId,
      }),
    ).toMatchObject(
      none(
        'Runs in a Cloud account: Cloudgate collects no container metrics there',
      ),
    );
    expect(
      await read(agent.key, { serviceType: 'compose', serviceId: t.composeId }),
    ).toMatchObject(
      none('Monitoring is not set up on the Server this Service runs on'),
    );
    expect(
      await read(agent.key, {
        serviceType: 'postgres',
        serviceId: t.postgresId,
      }),
    ).toMatchObject(
      none(
        'Monitoring is not set up on the platform host, where this Service runs',
      ),
    );
    // Sampled once, but not in the last hour.
    await ctx.db
      .delete(containerMetric)
      .where(eq(containerMetric.containerName, 'web-app.1.t6ga2k'));
    await seed(t.monitored, 'web-app.1.t6ga2k', [
      { minutesAgo: 120, cpu: 90, memory: [0.5, 'GB', 50] },
    ]);
    expect(
      await read(agent.key, { serviceType: 'application', serviceId: t.webId }),
    ).toMatchObject(none('No samples in this window'));

    expect((await rowsOf(agent.id)).map((row) => [row[0], row[1]])).toEqual([
      ['application', 'succeeded'],
      ['compose', 'succeeded'],
      ['database', 'succeeded'],
      ['application', 'succeeded'],
    ]);
  });

  it("answers a Service never sampled as having no samples, never with another Service's whose name contains its own", async () => {
    const t = await tree();
    await seed(t.monitored, 'myshop.1.k2f9', [
      { minutesAgo: 5, cpu: 99, memory: [900, 'MB', 87.89] },
    ]);
    const agent = await agentFor(t);

    expect(
      await read(agent.key, {
        serviceType: 'application',
        serviceId: t.shopId,
      }),
    ).toMatchObject({
      available: false,
      unavailableReason:
        "No samples are stored for this Service's containers: the monitoring of the Server or platform host it runs on does not collect for it, or has not sampled it yet",
      cpu: null,
      trend: [],
    });
  });

  it("refuses an ungranted Service, another Organization's, and an unknown id, byte-identically", async () => {
    const t = await tree();
    await seedWeb(t);
    await seed(t.monitored, 'worker-app.1.w0rk', [
      { minutesAgo: 5, cpu: 77, memory: [700, 'MB', 68.36] },
    ]);
    const agent = await agentFor(t);

    for (const serviceId of [t.workerId, t.foreignId, 'no-such-service']) {
      expect(
        await callTool(agent.key, { serviceType: 'application', serviceId }),
      ).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: NOT_FOUND_OR_NOT_PERMITTED }],
      });
    }
    expect((await rowsOf(agent.id)).map((row) => row.slice(1, 4))).toEqual([
      ['refused', t.workerId, 'get_service_metrics'],
      ['refused', t.foreignId, 'get_service_metrics'],
      ['refused', 'no-such-service', 'get_service_metrics'],
    ]);
  });

  it('refuses a Caller key, as at every other tool', async () => {
    const t = await tree();
    await seedWeb(t);
    const caller = await agentFor(t, 'agentCaller');

    const res = await request(httpServer)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .set('Authorization', `Bearer ${caller.key}`)
      .set('MCP-Protocol-Version', '2025-06-18')
      .send({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'get_service_metrics',
          arguments: { serviceType: 'application', serviceId: t.webId },
        },
      });
    answers.push(res.text);
    expect(res.status).toBe(403);
    expect(res.text).not.toContain('"cpu"');
    expect((await rowsOf(caller.id)).map((row) => [row[1], row[4]])).toEqual([
      ['refused', 'permission'],
    ]);
  });
});
