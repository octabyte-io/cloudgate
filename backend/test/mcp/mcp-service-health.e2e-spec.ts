import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { asc, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  auditLog,
  compose,
  errorRateSample,
  incident,
} from '../../src/db/schema';
import { FETCH_CLIENT } from '../../src/git-providers/fetch.provider';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { ProbeScheduler } from '../../src/service-health/probe-scheduler.service';
import { PROBE_TARGET } from '../../src/service-health/probe-target.port';
import { REQUEST_METRICS_STATE } from '../../src/service-health/request-metrics-state.port';
import { SERVICE_HEALTH_CLOCK } from '../../src/service-health/service-health.clock';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(180_000);

/**
 * A Service's health over MCP (spec stories 79–84): a real Agent
 * key against the real `POST /mcp`, asserting on the answers and the audit
 * rows.
 *
 * The health itself is made the way the health suites make it: an Uptime check probing
 * a stub HTTP server through `PROBE_TARGET`, with a frozen clock and a direct
 * `ProbeScheduler.tick`. Two things are written as rows because producing them
 * through the product is another suite's subject: Error-rate samples (the error-rate
 * collector) and a threshold's Incident plus the history of closed ones
 * (the threshold's judgement and rule). The platform host is told it has request
 * metrics through `REQUEST_METRICS_STATE`, the seam left for a suite.
 *
 * The stub's body, the check's keyword and its header value each carry a
 * marker string no MCP answer may ever contain (story 84).
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const FINALITY =
  'This is an access decision, not a failure. Retrying, or trying another tool or id, will not change it. Tell the operator what you needed.';
const NOT_FOUND_OR_NOT_PERMITTED = `Not found or not permitted. ${FINALITY}`;

/** Never in an MCP answer: the check's header value, keyword, and what the app answered. */
const HEADER_VALUE = 'Bearer hdr-marker-5e8c1a2b9d7f';
const KEYWORD = 'kw-marker-3f6a0c4e8b1d';
const BODY_MARKER = 'body-marker-9a2c7e4f1b6d';

const INTERVAL_MS = 30_000;
const DATABASES = [
  { kind: 'postgres', body: { databaseName: 'd', databaseUser: 'u' } },
  { kind: 'mysql', body: { databaseName: 'd', databaseUser: 'u' } },
  { kind: 'mariadb', body: { databaseName: 'd', databaseUser: 'u' } },
  { kind: 'mongo', body: { databaseUser: 'u' } },
  { kind: 'redis', body: {} },
  { kind: 'libsql', body: { databaseUser: 'u' } },
] as const;

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

type Json = Record<string, unknown>;

interface IncidentAnswer {
  source: string;
  uptimeCheckId: string | null;
  errorRateThresholdId: string | null;
  closedAt: string | null;
}

/** The fields of a tool answer these tests reach into; the rest is compared whole. */
interface Answer {
  uptimeChecks: Array<{ upShare24h: number | null; lastProbe: unknown }>;
  errorRate: unknown;
  errorRateThreshold: unknown;
  openIncidents: IncidentAnswer[];
  recentlyClosedIncidents: IncidentAnswer[];
  services: Array<{ serviceId: string; openIncidents: number }>;
}

describe('MCP Service health reads (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let scheduler: ProbeScheduler;

  let stub: Server;
  let stubPort = 0;
  let failing = false;
  let receivedAuth: (string | null)[] = [];

  let now = Date.parse('2026-09-25T10:00:00.000Z');
  const clock = { now: () => now };

  const ok = { stdout: '', stderr: '', exitCode: 0 };
  const machine = (command: string) =>
    Promise.resolve(
      isPresenceProbe(command) ? { ...ok, stdout: 'absent' } : ok,
    );
  const execMock = withArgvExec({
    execAsync: jest.fn<Promise<typeof ok>, [string]>(),
    execAsyncRemote: jest.fn<Promise<typeof ok>, [string, string]>(),
  });
  const traefikWriterMock = {
    loadOrCreateConfig: jest.fn(),
    writeConfig: jest.fn(),
    removeConfig: jest.fn(),
    writeCertificate: jest.fn(),
    removeCertificate: jest.fn(),
  };
  const fetchMock = jest.fn();

  /** Every MCP answer text of the current test, for the leak check. */
  let answers: string[] = [];

  beforeAll(async () => {
    stub = createServer((req, res) => {
      receivedAuth.push(req.headers.authorization ?? null);
      res.statusCode = failing ? 503 : 200;
      res.end(
        failing
          ? `<p>${BODY_MARKER} upstream exploded</p>`
          : `<p>${BODY_MARKER} ${KEYWORD}</p>`,
      );
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    stubPort = (stub.address() as AddressInfo).port;

    ctx = await createTestApp({
      overrideProviders: [
        {
          provide: PROBE_TARGET,
          useValue: {
            http: (url: URL) =>
              new URL(`http://127.0.0.1:${stubPort}${url.pathname}`),
            tcp: () => ({ host: '127.0.0.1', port: 1 }),
          },
        },
        { provide: SERVICE_HEALTH_CLOCK, useValue: clock },
        {
          provide: REQUEST_METRICS_STATE,
          useValue: { isEnabled: () => Promise.resolve(true) },
        },
        { provide: FETCH_CLIENT, useValue: fetchMock },
        { provide: RemoteExecService, useValue: execMock },
        { provide: TraefikWriterService, useValue: traefikWriterMock },
      ],
    });
    httpServer = ctx.app.getHttpServer() as App;
    scheduler = ctx.app.get(ProbeScheduler);
  });

  afterAll(async () => {
    await ctx.teardown();
    stub.closeAllConnections();
    await new Promise((resolve) => stub.close(resolve));
  });

  let cookie: string;

  beforeEach(async () => {
    await ctx.resetDb();
    failing = false;
    receivedAuth = [];
    answers = [];
    fetchMock.mockReset().mockResolvedValue({ ok: true, statusText: 'OK' });
    execMock.execAsync.mockReset().mockImplementation(machine);
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_serverId, command) => machine(command));
    traefikWriterMock.loadOrCreateConfig
      .mockReset()
      .mockResolvedValue({ http: { routers: {}, services: {} } });
    traefikWriterMock.writeConfig.mockReset().mockResolvedValue(undefined);
    traefikWriterMock.removeConfig.mockReset().mockResolvedValue(undefined);

    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
  });

  afterEach(() => {
    // Story 84, over every answer the test read.
    expect(answers.length).toBeGreaterThan(0);
    for (const text of answers) {
      for (const leak of [HEADER_VALUE, 'hdr-marker', KEYWORD, BODY_MARKER]) {
        expect(text).not.toContain(leak);
      }
    }
  });

  async function post(path: string, body: Json): Promise<Json> {
    const res = await request(httpServer)
      .post(path)
      .set('Cookie', cookie)
      .send(body);
    expect(res.status).toBe(201);
    return res.body as Json;
  }

  /**
   * One Environment holding an Application, a Compose, one database of each
   * engine and an ungranted Worker.
   */
  async function tree() {
    const project = await post('/projects', { name: 'shop' });
    const env = await post('/environments', {
      name: 'production',
      projectId: project.projectId,
    });
    const environmentId = env.environmentId as string;
    const app = await post('/applications', {
      name: 'Web',
      appName: 'web-app',
      environmentId,
    });
    const worker = await post('/applications', {
      name: 'Worker',
      appName: 'worker-app',
      environmentId,
    });
    const stack = await post('/compose', {
      name: 'Stack',
      appName: 'stack-app',
      environmentId,
    });
    const databases: Array<{ kind: string; id: string }> = [];
    for (const { kind, body } of DATABASES) {
      const created = await post(`/${kind}`, {
        name: kind,
        appName: `${kind}-db`,
        environmentId,
        ...body,
      });
      databases.push({ kind, id: created[`${kind}Id`] as string });
    }
    return {
      projectId: project.projectId as string,
      environmentId,
      applicationId: app.applicationId as string,
      workerId: worker.applicationId as string,
      composeId: stack.composeId as string,
      databases,
    };
  }

  type Tree = Awaited<ReturnType<typeof tree>>;

  async function agentFor(
    t: Tree,
    accessedServices: string[],
    role = 'agentReader',
  ): Promise<{ id: string; key: string }> {
    const body = await post('/agents', {
      name: `bot-${accessedServices.length}-${role}`,
      role,
      grant: {
        accessedProjects: [t.projectId],
        accessedEnvironments: [t.environmentId],
        accessedServices,
      },
    });
    return {
      id: (body.agent as { id: string }).id,
      key: body.key as string,
    };
  }

  const granted = (t: Tree) => [
    t.applicationId,
    t.composeId,
    ...t.databases.map((database) => database.id),
  ];

  async function callTool(
    key: string,
    name: string,
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
        params: { name, arguments: args },
      });
    expect(res.status).toBe(200);
    answers.push(res.text);
    return (res.body as { result: ToolResult }).result;
  }

  async function read(
    key: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<Answer> {
    const result = await callTool(key, name, args);
    expect(result.isError).toBeFalsy();
    return JSON.parse(result.content[0].text) as Answer;
  }

  async function step(fail: boolean): Promise<void> {
    failing = fail;
    now += INTERVAL_MS;
    await scheduler.tick();
  }

  /**
   * The Application's health: an HTTP check with a keyword and a header on
   * its Domain, failed into an open Incident; a threshold with an open
   * Incident of its own; twelve closed Incidents; and an hour of samples.
   * The Compose gets a TCP check on its published port and nothing else.
   */
  async function sicken(t: Tree) {
    const domain = await post('/domains', {
      host: 'shop.example.com',
      path: '/health',
      applicationId: t.applicationId,
    });
    const check = await post('/uptime-checks', {
      serviceType: 'application',
      serviceId: t.applicationId,
      kind: 'http',
      domainId: domain.domainId,
      intervalSeconds: 30,
      timeoutSeconds: 2,
      downAfter: 3,
      keyword: KEYWORD,
      headerName: 'Authorization',
      headerValue: HEADER_VALUE,
    });
    const uptimeCheckId = check.uptimeCheckId as string;

    // History first, so the Probes below are the latest: twelve closed,
    // each a minute apart, the newest closed last.
    await ctx.db.insert(incident).values(
      Array.from({ length: 12 }, (_, i) => ({
        uptimeCheckId,
        openedAt: new Date(now - (60 - i) * 60_000).toISOString(),
        closedAt: new Date(now - (59 - i) * 60_000).toISOString(),
        openingError: 'status 502',
        closeReason: 'recovered' as const,
      })),
    );

    await step(false);
    await step(true);
    await step(true);
    await step(true);

    const threshold = await request(httpServer)
      .put(`/error-rate-thresholds/${t.applicationId}`)
      .query({ serviceType: 'application' })
      .set('Cookie', cookie)
      .send({ percentage: 5, windowMinutes: 5, minRequests: 20 });
    expect(threshold.status).toBe(200);
    const errorRateThresholdId = (threshold.body as Json)
      .errorRateThresholdId as string;
    await ctx.db.insert(incident).values({
      errorRateThresholdId,
      openedAt: new Date(now - 30_000).toISOString(),
      openingErrorRate: 0.25,
      openingRequests: 40,
      worstErrorRate: 0.5,
    });

    await ctx.db.insert(errorRateSample).values(
      [60, 30].map((minutesAgo) => ({
        domainId: domain.domainId as string,
        collectedAt: new Date(now - minutesAgo * 60_000).toISOString(),
        requests: 50,
        errors: 5,
        slow: 10,
      })),
    );

    await ctx.db
      .update(compose)
      .set({
        // A file entered in the console: a repository Compose's published
        // ports are not read.
        sourceType: 'raw',
        composeFile:
          'services:\n  db:\n    image: redis\n    ports:\n      - "6380:6379"\n',
      })
      .where(eq(compose.composeId, t.composeId));
    const tcp = await post('/uptime-checks', {
      serviceType: 'compose',
      serviceId: t.composeId,
      kind: 'tcp',
      port: 6380,
      intervalSeconds: 30,
      timeoutSeconds: 2,
      downAfter: 3,
    });

    return {
      domainId: domain.domainId as string,
      uptimeCheckId,
      errorRateThresholdId,
      tcpCheckId: tcp.uptimeCheckId as string,
    };
  }

  async function rowsOf(agentId: string) {
    return (
      await ctx.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.userId, agentId))
        .orderBy(asc(auditLog.createdAt))
    ).map((row) => [
      row.resourceType,
      row.outcome,
      row.resourceId,
      (JSON.parse(row.metadata ?? '{}') as { tool?: string }).tool,
    ]);
  }

  it("answers an Application's checks, Error rate, threshold and Incidents, with the header name only, no keyword, no body and no raw Probe", async () => {
    const t = await tree();
    const s = await sicken(t);
    const agent = await agentFor(t, granted(t));
    // The header and keyword were real: the stub was sent the value.
    expect(receivedAuth).toContain(HEADER_VALUE);

    const health = await read(agent.key, 'get_service_health', {
      serviceType: 'application',
      serviceId: t.applicationId,
    });

    expect(Object.keys(health).sort()).toEqual([
      'errorRate',
      'errorRateThreshold',
      'openIncidents',
      'recentlyClosedIncidents',
      'serviceId',
      'serviceType',
      'state',
      'uptimeChecks',
    ]);
    expect(health).toMatchObject({
      serviceType: 'application',
      serviceId: t.applicationId,
      state: 'incident',
    });
    expect(health.uptimeChecks).toEqual([
      {
        uptimeCheckId: s.uptimeCheckId,
        kind: 'http',
        enabled: true,
        // Only a TCP check Cloudgate turned off for a lost port has one.
        disabledReason: null,
        intervalSeconds: 30,
        timeoutSeconds: 2,
        expectedStatuses: ['2xx'],
        downAfter: 3,
        headerName: 'Authorization',
        hasHeaderValue: true,
        hasKeyword: true,
        // The background tick may have probed once before the first step,
        // so the share is held to the Health tab's answer below.
        upShare24h: expect.any(Number) as number,
        createdAt: expect.any(String) as string,
        target: {
          domainId: s.domainId,
          host: 'shop.example.com',
          path: '/health',
          https: false,
          url: 'http://shop.example.com/health',
        },
        tcpTarget: null,
        lastProbe: {
          probedAt: new Date(now).toISOString(),
          verdict: 'down',
          latencyMs: expect.any(Number) as number,
          errorClass: 'status 503',
        },
      },
    ]);
    const twin = await request(httpServer)
      .get(`/service-health/application/${t.applicationId}`)
      .set('Cookie', cookie);
    expect(twin.status).toBe(200);
    const twinCheck = (twin.body as Answer).uptimeChecks[0];
    expect(health.uptimeChecks[0].upShare24h).toBe(twinCheck.upShare24h);
    expect(health.uptimeChecks[0].upShare24h).toBeLessThan(1);
    expect(health.uptimeChecks[0].lastProbe).toEqual(twinCheck.lastProbe);

    expect(health.errorRate).toEqual({
      available: true,
      unavailableReason: null,
      since: expect.any(String) as string,
      // The background collector may add a zero-request row at `now`.
      lastCollectedAt: expect.any(String) as string,
      totals: {
        requests: 100,
        errors: 10,
        slow: 20,
        errorRate: 0.1,
        slowShare: 0.2,
      },
      domains: [
        {
          domainId: s.domainId,
          host: 'shop.example.com',
          requests: 100,
          errors: 10,
          slow: 20,
          errorRate: 0.1,
          slowShare: 0.2,
        },
      ],
    });
    expect(health.errorRateThreshold).toEqual({
      errorRateThresholdId: s.errorRateThresholdId,
      percentage: 5,
      windowMinutes: 5,
      minRequests: 20,
      enabled: true,
      createdAt: expect.any(String) as string,
    });

    // The two open ones, newest first: the check's, then the threshold's.
    expect(health.openIncidents).toEqual([
      {
        incidentId: expect.any(String) as string,
        source: 'uptime-check',
        uptimeCheckId: s.uptimeCheckId,
        errorRateThresholdId: null,
        openedAt: new Date(now).toISOString(),
        closedAt: null,
        durationSeconds: null,
        openingError: 'status 503',
        openingErrorRate: null,
        openingRequests: null,
        worstErrorRate: null,
        closeReason: null,
      },
      {
        incidentId: expect.any(String) as string,
        source: 'error-rate-threshold',
        uptimeCheckId: null,
        errorRateThresholdId: s.errorRateThresholdId,
        openedAt: new Date(now - 30_000).toISOString(),
        closedAt: null,
        durationSeconds: null,
        openingError: null,
        openingErrorRate: 0.25,
        openingRequests: 40,
        worstErrorRate: 0.5,
        closeReason: null,
      },
    ]);

    // The ten most recently closed of twelve, newest closed first.
    const closed = health.recentlyClosedIncidents;
    expect(closed).toHaveLength(10);
    expect(closed.map((one) => one.closedAt)).toEqual(
      Array.from({ length: 10 }, (_, i) =>
        new Date(now - INTERVAL_MS * 4 - (48 + i) * 60_000).toISOString(),
      ),
    );
    expect(closed[0]).toMatchObject({
      source: 'uptime-check',
      closeReason: 'recovered',
      durationSeconds: 60,
      openingError: 'status 502',
    });

    const text = answers.join('\n');
    expect(text).not.toContain('strip');
    expect(text).not.toContain('probes');
    expect(text).not.toContain('"keyword"');
  });

  it('answers every Service kind, each by its own audit kind, and a Compose TCP check by its address', async () => {
    const t = await tree();
    const s = await sicken(t);
    const agent = await agentFor(t, granted(t), 'agentOperator');

    const stack = await read(agent.key, 'get_service_health', {
      serviceType: 'compose',
      serviceId: t.composeId,
    });
    expect(stack).toMatchObject({
      serviceType: 'compose',
      errorRate: {
        available: false,
        unavailableReason: 'No Domain',
        totals: null,
        domains: [],
      },
      errorRateThreshold: null,
      openIncidents: [],
      recentlyClosedIncidents: [],
    });
    expect(stack.uptimeChecks).toEqual([
      expect.objectContaining({
        uptimeCheckId: s.tcpCheckId,
        kind: 'tcp',
        target: null,
        tcpTarget: expect.objectContaining({ port: 6380 }) as unknown,
        headerName: null,
        hasHeaderValue: false,
        hasKeyword: false,
      }),
    ]);

    for (const { kind, id } of t.databases) {
      expect(
        await read(agent.key, 'get_service_health', {
          serviceType: kind,
          serviceId: id,
        }),
      ).toEqual({
        serviceType: kind,
        serviceId: id,
        state: 'unchecked',
        uptimeChecks: [],
        errorRate: {
          available: false,
          unavailableReason: 'Databases have no Error rate',
          since: null,
          lastCollectedAt: null,
          totals: null,
          domains: [],
        },
        errorRateThreshold: null,
        openIncidents: [],
        recentlyClosedIncidents: [],
      });
    }

    expect(await rowsOf(agent.id)).toEqual([
      ['compose', 'succeeded', t.composeId, 'get_service_health'],
      ...t.databases.map(({ id }) => [
        'database',
        'succeeded',
        id,
        'get_service_health',
      ]),
    ]);
  });

  it('counts open Incidents from checks and thresholds alike in get_service and get_environment', async () => {
    const t = await tree();
    const s = await sicken(t);
    const agent = await agentFor(t, granted(t));

    const web = await read(agent.key, 'get_service', {
      serviceType: 'application',
      serviceId: t.applicationId,
    });
    expect(
      web.openIncidents.map((one) => [
        one.source,
        one.uptimeCheckId ?? one.errorRateThresholdId,
        one.closedAt,
      ]),
    ).toEqual([
      ['uptime-check', s.uptimeCheckId, null],
      ['error-rate-threshold', s.errorRateThresholdId, null],
    ]);
    const orders = await read(agent.key, 'get_service', {
      serviceType: 'postgres',
      serviceId: t.databases[0].id,
    });
    expect(orders.openIncidents).toEqual([]);

    const env = await read(agent.key, 'get_environment', {
      environmentId: t.environmentId,
    });
    expect(
      Object.fromEntries(
        env.services.map((one) => [one.serviceId, one.openIncidents]),
      ),
    ).toEqual(
      Object.fromEntries(
        granted(t).map((id) => [id, id === t.applicationId ? 2 : 0]),
      ),
    );

    // Recovery closes the check's; the threshold's stays open and counted.
    await step(false);
    const after = await read(agent.key, 'get_environment', {
      environmentId: t.environmentId,
    });
    expect(
      after.services.find((one) => one.serviceId === t.applicationId)
        ?.openIncidents,
    ).toBe(1);
  });

  it('refuses an Agent entitled only to another Service, byte-identically to an unknown id', async () => {
    const t = await tree();
    await sicken(t);
    const agent = await agentFor(t, [t.workerId]);

    for (const serviceId of [t.applicationId, 'no-such-service']) {
      for (const tool of ['get_service_health', 'get_service']) {
        const refused = await callTool(agent.key, tool, {
          serviceType: 'application',
          serviceId,
        });
        expect(refused).toMatchObject({
          isError: true,
          content: [{ type: 'text', text: NOT_FOUND_OR_NOT_PERMITTED }],
        });
      }
    }
    // Its own Service reads, with nothing to report.
    expect(
      await read(agent.key, 'get_service_health', {
        serviceType: 'application',
        serviceId: t.workerId,
      }),
    ).toMatchObject({ state: 'unchecked', openIncidents: [] });

    expect(
      (await rowsOf(agent.id)).map(([, outcome, resourceId, tool]) => [
        outcome,
        resourceId,
        tool,
      ]),
    ).toEqual([
      ['refused', t.applicationId, 'get_service_health'],
      ['refused', t.applicationId, 'get_service'],
      ['refused', 'no-such-service', 'get_service_health'],
      ['refused', 'no-such-service', 'get_service'],
      ['succeeded', t.workerId, 'get_service_health'],
    ]);
  });
});
