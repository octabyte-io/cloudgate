import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { REMOTE_CLOUDGATE_DIRECTORY } from '../../src/common/config/cloudgate-directory';
import { withRequestMetrics } from '../../src/common/config/request-metrics';
import {
  application,
  compose,
  domain,
  errorRateSample,
  member,
  server,
} from '../../src/db/schema';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { RequestMetricsCollector } from '../../src/service-health/request-metrics-collector.service';
import { SERVICE_HEALTH_CLOCK } from '../../src/service-health/service-health.clock';
import { REQUEST_COUNTERS_COMMAND } from '../../src/service-health/traefik-counters';
import { MAIN_TRAEFIK_DIR } from '../../src/settings/traefik-files.service';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { withArgvExec } from '../utils/exec-double';
import { freezeOrganization } from '../utils/frozen-organization';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { signUpMember } from '../utils/test-auth';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

/**
 * A Service's Error rate (ADR-0027), observed where an operator observes
 * it: the `errorRate` of the health summary, and sample rows gone after a
 * prune or a Delete.
 *
 * The doubles are the spec's: `RemoteExecService` answers the counter read
 * ({@link REQUEST_COUNTERS_COMMAND}) with Traefik Prometheus text this suite
 * scripts per machine — growth, a reset, series for services no Domain names —
 * and `SERVICE_HEALTH_CLOCK` stands still while each {@link collect} moves it
 * one refreshRate and calls `RequestMetricsCollector.tick` directly.
 * `MAIN_TRAEFIK_DIR` points the platform host's traefik.yml at a temp dir, and
 * the Traefik writer stands in for the Domain writes. The parser, the forward
 * index, the delta reader, the sample rows and the read all run.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const REFRESH_MS = 60_000;
const OLD_TRAEFIK_YML =
  "entryPoints:\n  web:\n    address: ':80'\n  websecure:\n    address: ':443'\n";

/** One scripted series: requests so far, of which `fast` took ≤ 1.2 s. */
interface Series {
  service: string;
  code: string;
  requests: number;
  fast?: number;
}

/** What a machine's Traefik serves: its start time and its series. */
interface Counters {
  startTime: number;
  series: Series[];
}

/** The filtered page the read command answers with, as Traefik 3.6 words it. */
function prometheusText({ startTime, series }: Counters): string {
  const lines = [`process_start_time_seconds ${startTime.toExponential()}`];
  for (const s of series) {
    const labels = `code="${s.code}",method="GET",protocol="http",service="${s.service}"`;
    lines.push(
      `traefik_service_request_duration_seconds_bucket{${labels},le="1.2"} ${s.fast ?? s.requests}`,
    );
  }
  for (const s of series) {
    const labels = `code="${s.code}",method="GET",protocol="http",service="${s.service}"`;
    lines.push(`traefik_service_requests_total{${labels}} ${s.requests}`);
  }
  return lines.join('\n') + '\n';
}

interface Totals {
  requests: number;
  errors: number;
  slow: number;
  errorRate: number | null;
  slowShare: number | null;
}

type ErrorRate =
  | { available: false; reason: string; message: string }
  | {
      available: true;
      since: string;
      lastCollectedAt: string;
      totals: Totals;
      series: (Totals & { start: string })[];
      domains: (Totals & { domainId: string; host: string })[];
    };

describe('Service Error rate (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let collector: RequestMetricsCollector;
  let traefikDir: string;

  let now = Date.parse('2026-09-25T10:00:00.000Z');
  const clock = { now: () => now };

  /** Each machine's Traefik, by Server id; `null` is the platform host. */
  let traefik: Map<string | null, Counters | 'down'>;

  const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
  const machine = (serverId: string | null, command: string) => {
    if (command === REQUEST_COUNTERS_COMMAND) {
      const counters = traefik.get(serverId);
      // `grep` finds no start time when wget got nothing: exit 1, a throw.
      if (!counters || counters === 'down') {
        return Promise.reject(new Error('Command failed: grep exited 1'));
      }
      return Promise.resolve(ok(prometheusText(counters)));
    }
    return Promise.resolve(isPresenceProbe(command) ? ok('absent') : ok(''));
  };
  const execMock = withArgvExec({
    execAsync: jest.fn<Promise<ExecResult>, [string]>(),
    execAsyncRemote: jest.fn<Promise<ExecResult>, [string, string]>(),
  });
  const traefikWriterMock = {
    loadOrCreateConfig: jest.fn(),
    writeConfig: jest.fn(),
    removeConfig: jest.fn(),
    writeCertificate: jest.fn(),
    removeCertificate: jest.fn(),
  };

  beforeAll(async () => {
    traefikDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-er-'));
    ctx = await createTestApp({
      overrideProviders: [
        { provide: SERVICE_HEALTH_CLOCK, useValue: clock },
        { provide: RemoteExecService, useValue: execMock },
        { provide: TraefikWriterService, useValue: traefikWriterMock },
        {
          provide: MAIN_TRAEFIK_DIR,
          useValue: (serverId?: string | null) =>
            serverId ? `${REMOTE_CLOUDGATE_DIRECTORY}/traefik` : traefikDir,
        },
      ],
    });
    httpServer = ctx.app.getHttpServer() as App;
    collector = ctx.app.get(RequestMetricsCollector);
  });

  afterAll(async () => {
    await ctx.teardown();
    fs.rmSync(traefikDir, { recursive: true, force: true });
  });

  let ownerCookie: string;
  let organizationId: string;
  let environmentId: string;

  beforeEach(async () => {
    await ctx.resetDb();
    traefik = new Map();
    execMock.execAsync
      .mockReset()
      .mockImplementation((command) => machine(null, command));
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((serverId, command) => machine(serverId, command));
    traefikWriterMock.loadOrCreateConfig
      .mockReset()
      .mockResolvedValue({ http: { routers: {}, services: {} } });
    traefikWriterMock.writeConfig.mockReset().mockResolvedValue(undefined);
    traefikWriterMock.removeConfig.mockReset().mockResolvedValue(undefined);
    // The platform host's Traefik keeps no request metrics until a test says so.
    fs.rmSync(traefikDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(traefikDir, 'dynamic'), { recursive: true });
    fs.writeFileSync(path.join(traefikDir, 'traefik.yml'), OLD_TRAEFIK_YML);

    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    ownerCookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const orgs = await request(httpServer)
      .get('/organizations/active')
      .set('Cookie', ownerCookie);
    organizationId = (orgs.body as { id: string }).id;
    const project = await request(httpServer)
      .post('/projects')
      .set('Cookie', ownerCookie)
      .send({ name: 'shop' });
    const environment = await request(httpServer)
      .post('/environments')
      .set('Cookie', ownerCookie)
      .send({
        name: 'production',
        projectId: (project.body as { projectId: string }).projectId,
      });
    expect(environment.status).toBe(201);
    environmentId = (environment.body as { environmentId: string })
      .environmentId;
  });

  /** A remote Server, its request metrics on or off. */
  async function addServer(name: string, requestMetricsEnabled = true) {
    const [row] = await ctx.db
      .insert(server)
      .values({
        name,
        ipAddress: '203.0.113.20',
        port: 22,
        organizationId,
        requestMetricsEnabled,
      })
      .returning();
    return row.serverId;
  }

  async function addApplication(
    appName: string,
    serverId?: string,
  ): Promise<string> {
    const res = await request(httpServer)
      .post('/applications')
      .set('Cookie', ownerCookie)
      .send({ name: appName, appName, environmentId, serverId });
    expect(res.status).toBe(201);
    return (res.body as { applicationId: string }).applicationId;
  }

  async function addCompose(
    appName: string,
    serverId?: string,
    composeType: 'docker-compose' | 'stack' = 'docker-compose',
  ): Promise<string> {
    const res = await request(httpServer)
      .post('/compose')
      .set('Cookie', ownerCookie)
      .send({ name: appName, appName, environmentId, serverId, composeType });
    expect(res.status).toBe(201);
    return (res.body as { composeId: string }).composeId;
  }

  /** Adds a Domain and answers the Traefik service name(s) it is counted under. */
  async function addDomain(
    parent: { applicationId: string } | { composeId: string },
    host: string,
  ): Promise<{ domainId: string; names: string[] }> {
    const res = await request(httpServer)
      .post('/domains')
      .set('Cookie', ownerCookie)
      .send({
        host,
        https: true,
        certificateType: 'letsencrypt',
        ...parent,
        ...('composeId' in parent
          ? { serviceName: 'web', domainType: 'compose' }
          : {}),
      });
    expect(res.status).toBe(201);
    const { domainId } = res.body as { domainId: string };
    const [row] = await ctx.db
      .select({
        key: domain.uniqueConfigKey,
        appName: application.appName,
        composeAppName: compose.appName,
        composeType: compose.composeType,
      })
      .from(domain)
      .leftJoin(
        application,
        eq(application.applicationId, domain.applicationId),
      )
      .leftJoin(compose, eq(compose.composeId, domain.composeId))
      .where(eq(domain.domainId, domainId));
    // Written out rather than built with the product's builders, so a builder
    // that drifts from what Traefik reports reds here.
    // A stack is routed by the file provider, like an Application.
    const names = row.appName
      ? [`${row.appName}-service-${row.key}@file`]
      : row.composeType === 'stack'
        ? [`${row.composeAppName}-service-${row.key}@file`]
        : [
            `${row.composeAppName}-${row.key}-web@docker`,
            `${row.composeAppName}-${row.key}-websecure@docker`,
          ];
    return { domainId, names };
  }

  /** Moves the clock one refreshRate and runs one collection tick. */
  async function collect(): Promise<void> {
    now += REFRESH_MS;
    await collector.tick();
  }

  async function errorRateOf(
    serviceType: string,
    serviceId: string,
    cookie = ownerCookie,
  ): Promise<ErrorRate> {
    const res = await request(httpServer)
      .get(`/service-health/${serviceType}/${serviceId}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return (res.body as { errorRate: ErrorRate }).errorRate;
  }

  function available(rate: ErrorRate) {
    if (!rate.available) throw new Error(`unavailable: ${rate.message}`);
    return rate;
  }

  it('sums the deltas of every Domain of a Service, handles a Traefik restart as a reset, and ignores unknown services', async () => {
    const edge = await addServer('edge');
    const web = await addApplication('shop-web', edge);
    const a = await addDomain({ applicationId: web }, 'shop.example.com');
    const b = await addDomain({ applicationId: web }, 'www.shop.example.com');
    const stack = await addCompose('shop-stack', edge);
    const c = await addDomain({ composeId: stack }, 'api.shop.example.com');
    const unknown = [
      // The dashboard's own service, and a removed Domain's lingering series.
      { service: 'cloudgate-service-app@file', code: '500', requests: 0 },
      { service: 'shop-web-service-999@file', code: '500', requests: 0 },
    ];
    const t0 = 1_790_000_000;

    // The first read after the backend starts is a baseline only.
    traefik.set(edge, {
      startTime: t0,
      series: [
        { service: a.names[0], code: '200', requests: 100 },
        { service: b.names[0], code: '200', requests: 50 },
        { service: c.names[0], code: '200', requests: 7 },
        ...unknown,
      ],
    });
    await collect();
    expect(await errorRateOf('application', web)).toEqual({
      available: false,
      reason: 'no-samples',
      message: 'No samples yet',
    });
    expect(execMock.execAsyncRemote).toHaveBeenCalledWith(
      edge,
      REQUEST_COUNTERS_COMMAND,
    );

    // Growth: a +60 (+10 of them 502, a series new since the baseline, 2 of
    // them slow), b +30 (+20 of them 500), and 1000 5xx no Domain names.
    traefik.set(edge, {
      startTime: t0,
      series: [
        { service: a.names[0], code: '200', requests: 150, fast: 148 },
        { service: a.names[0], code: '502', requests: 10 },
        { service: b.names[0], code: '200', requests: 60 },
        { service: b.names[0], code: '500', requests: 20 },
        { service: c.names[0], code: '200', requests: 12 },
        { service: c.names[1], code: '503', requests: 5 },
        ...unknown.map((s) => ({ ...s, requests: 1000 })),
      ],
    });
    await collect();
    let rate = available(await errorRateOf('application', web));
    expect(rate.totals).toEqual({
      requests: 90,
      errors: 30,
      slow: 2,
      errorRate: 30 / 90,
      slowShare: 2 / 90,
    });
    expect(
      rate.domains.map(({ host, requests, errors }) => ({
        host,
        requests,
        errors,
      })),
    ).toEqual([
      { host: 'shop.example.com', requests: 60, errors: 10 },
      { host: 'www.shop.example.com', requests: 30, errors: 20 },
    ]);
    // A Compose Domain's web and websecure services sum as its one Domain.
    const composeRate = available(await errorRateOf('compose', stack));
    expect(composeRate.totals).toMatchObject({ requests: 10, errors: 5 });

    // Traefik restarts: every series is gone, and a's comes back at 4.
    traefik.set(edge, {
      startTime: t0 + 120,
      series: [{ service: a.names[0], code: '200', requests: 4 }],
    });
    await collect();
    // And a counter that falls under the same start time is a reset too.
    traefik.set(edge, {
      startTime: t0 + 120,
      series: [{ service: a.names[0], code: '200', requests: 1 }],
    });
    await collect();

    rate = available(await errorRateOf('application', web));
    expect(rate.totals).toMatchObject({ requests: 95, errors: 30 });
    const samples = await ctx.db.select().from(errorRateSample);
    for (const sample of samples) {
      expect(sample.requests).toBeGreaterThanOrEqual(0);
      expect(sample.errors).toBeGreaterThanOrEqual(0);
      expect(sample.slow).toBeGreaterThanOrEqual(0);
    }
    // One row per indexed Domain per collection after the baseline, zeros kept.
    expect(samples).toHaveLength(3 * 3);
    // The chart holds exactly the totals, and no bucket reads above 100 %.
    const charted = rate.series.reduce((sum, b) => sum + b.requests, 0);
    expect(charted).toBe(95);
    for (const bucket of rate.series) {
      if (bucket.errorRate !== null) {
        expect(bucket.errorRate).toBeLessThanOrEqual(1);
      }
    }
    expect(rate.lastCollectedAt).toBe(new Date(now).toISOString());
  });

  it("reads the platform host's counters through the local shell once its traefik.yml carries them", async () => {
    const web = await addApplication('shop-web');
    const a = await addDomain({ applicationId: web }, 'shop.example.com');
    traefik.set(null, {
      startTime: 1,
      series: [{ service: a.names[0], code: '200', requests: 1 }],
    });

    await collect();
    await collect();
    expect(await errorRateOf('application', web)).toEqual({
      available: false,
      reason: 'metrics-not-enabled',
      message: 'Request metrics not enabled on this Server',
    });
    expect(execMock.execAsync).not.toHaveBeenCalledWith(
      REQUEST_COUNTERS_COMMAND,
    );

    fs.writeFileSync(
      path.join(traefikDir, 'traefik.yml'),
      withRequestMetrics(OLD_TRAEFIK_YML),
    );
    await collect(); // baseline
    traefik.set(null, {
      startTime: 1,
      series: [
        { service: a.names[0], code: '200', requests: 9 },
        { service: a.names[0], code: '504', requests: 2 },
      ],
    });
    await collect();

    expect(execMock.execAsync).toHaveBeenCalledWith(REQUEST_COUNTERS_COMMAND);
    expect(available(await errorRateOf('application', web)).totals).toEqual({
      requests: 10,
      errors: 2,
      slow: 0,
      errorRate: 0.2,
      slowShare: 0,
    });
  });

  it('counts a stack Compose Domain under its file-provider service', async () => {
    const edge = await addServer('edge');
    const stack = await addCompose('shop-swarm', edge, 'stack');
    const s = await addDomain({ composeId: stack }, 'swarm.shop.example.com');
    expect(s.names).toEqual([
      expect.stringMatching(/^shop-swarm-service-\d+@file$/),
    ]);

    traefik.set(edge, {
      startTime: 1,
      series: [{ service: s.names[0], code: '200', requests: 10 }],
    });
    await collect(); // baseline
    traefik.set(edge, {
      startTime: 1,
      series: [
        { service: s.names[0], code: '200', requests: 16 },
        { service: s.names[0], code: '502', requests: 2 },
      ],
    });
    await collect();

    expect(available(await errorRateOf('compose', stack)).totals).toMatchObject(
      { requests: 8, errors: 2 },
    );
  });

  it('writes nothing for a read that fails, and spans the gap with the next good one', async () => {
    const edge = await addServer('edge');
    const web = await addApplication('shop-web', edge);
    const a = await addDomain({ applicationId: web }, 'shop.example.com');

    traefik.set(edge, {
      startTime: 1,
      series: [{ service: a.names[0], code: '200', requests: 10 }],
    });
    await collect();
    traefik.set(edge, 'down');
    await collect();
    expect(await ctx.db.select().from(errorRateSample)).toEqual([]);

    traefik.set(edge, {
      startTime: 1,
      series: [{ service: a.names[0], code: '200', requests: 25 }],
    });
    await collect();
    expect(
      available(await errorRateOf('application', web)).totals,
    ).toMatchObject({ requests: 15, errors: 0, errorRate: 0 });
  });

  it('collects at the Server’s own refreshRate', async () => {
    const edge = await addServer('edge');
    const web = await addApplication('shop-web', edge);
    const a = await addDomain({ applicationId: web }, 'shop.example.com');
    traefik.set(edge, {
      startTime: 1,
      series: [{ service: a.names[0], code: '200', requests: 1 }],
    });
    const reads = () =>
      execMock.execAsyncRemote.mock.calls.filter(
        ([, command]) => command === REQUEST_COUNTERS_COMMAND,
      ).length;

    await collector.tick();
    expect(reads()).toBe(1);
    now += 30_000;
    await collector.tick();
    expect(reads()).toBe(1);
    now += 30_000;
    await collector.tick();
    expect(reads()).toBe(2);
  });

  it("reads nothing from a Frozen Organization's Server", async () => {
    const edge = await addServer('edge');
    const web = await addApplication('shop-web', edge);
    const a = await addDomain({ applicationId: web }, 'shop.example.com');
    traefik.set(edge, {
      startTime: 1,
      series: [{ service: a.names[0], code: '200', requests: 1 }],
    });
    await freezeOrganization(ctx, organizationId);
    execMock.execAsyncRemote.mockClear();

    await collect();
    await collect();

    expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it('returns each unavailable reason verbatim, and none of them as 0 %', async () => {
    const edge = await addServer('edge');
    const dark = await addServer('dark', false);

    const database = await request(httpServer)
      .post('/postgres')
      .set('Cookie', ownerCookie)
      .send({
        name: 'Main DB',
        appName: 'main-db',
        databaseName: 'shop',
        databaseUser: 'shop_user',
        databasePassword: 'sup3rS3cret',
        environmentId,
      });
    expect(database.status).toBe(201);
    const bare = await addApplication('shop-bare', edge);
    const unlit = await addApplication('shop-unlit', dark);
    await addDomain({ applicationId: unlit }, 'unlit.shop.example.com');
    const fresh = await addApplication('shop-fresh', edge);
    const f = await addDomain(
      { applicationId: fresh },
      'fresh.shop.example.com',
    );
    traefik.set(edge, {
      startTime: 1,
      series: [{ service: f.names[0], code: '500', requests: 3 }],
    });
    traefik.set(dark, {
      startTime: 1,
      series: [
        { service: 'shop-unlit-service-1@file', code: '500', requests: 3 },
      ],
    });
    await collect(); // a baseline on edge: still no samples

    const cases: [string, string, string, string][] = [
      [
        'postgres',
        (database.body as { postgresId: string }).postgresId,
        'database',
        'Databases have no Error rate',
      ],
      ['application', bare, 'no-domain', 'No Domain'],
      [
        'application',
        unlit,
        'metrics-not-enabled',
        'Request metrics not enabled on this Server',
      ],
      ['application', fresh, 'no-samples', 'No samples yet'],
    ];
    for (const [serviceType, serviceId, reason, message] of cases) {
      const rate = await errorRateOf(serviceType, serviceId);
      expect(rate).toEqual({ available: false, reason, message });
      expect(JSON.stringify(rate)).not.toMatch(/errorRate|"0"|:0\b/);
    }
    // The Server without request metrics was never read.
    expect(execMock.execAsyncRemote).not.toHaveBeenCalledWith(
      dark,
      REQUEST_COUNTERS_COMMAND,
    );
  });

  it('refuses the Error rate to a Member entitled only to another Service', async () => {
    const edge = await addServer('edge');
    const ours = await addApplication('shop-web', edge);
    const a = await addDomain({ applicationId: ours }, 'shop.example.com');
    const theirs = await addApplication('shop-blog', edge);
    traefik.set(edge, {
      startTime: 1,
      series: [{ service: a.names[0], code: '500', requests: 3 }],
    });
    await collect();
    await collect();

    const ida = await signUpMember(httpServer, ownerCookie);
    await ctx.db
      .update(member)
      .set({ accessedServices: [theirs] })
      .where(eq(member.userId, ida.id));

    const refused = await request(httpServer)
      .get(`/service-health/application/${ours}`)
      .set('Cookie', ida.cookie);
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).not.toContain('errorRate');
    // The Service she is entitled to reads, with its own reason.
    expect(await errorRateOf('application', theirs, ida.cookie)).toMatchObject({
      reason: 'no-domain',
    });
  });

  it('prunes samples older than seven days', async () => {
    const edge = await addServer('edge');
    const web = await addApplication('shop-web', edge);
    const a = await addDomain({ applicationId: web }, 'shop.example.com');
    traefik.set(edge, {
      startTime: 1,
      series: [{ service: a.names[0], code: '200', requests: 1 }],
    });
    await collect();
    await collect();
    const [old] = await ctx.db.select().from(errorRateSample);

    now += 7 * 24 * 60 * 60 * 1000 - 1;
    expect(await collector.prune()).toBe(0);
    now += 2;
    expect(await collector.prune()).toBe(1);
    expect(
      await ctx.db
        .select()
        .from(errorRateSample)
        .where(eq(errorRateSample.errorRateSampleId, old.errorRateSampleId)),
    ).toEqual([]);
  });

  it('leaves no sample rows after a Service Delete', async () => {
    const edge = await addServer('edge');
    const web = await addApplication('shop-web', edge);
    const a = await addDomain({ applicationId: web }, 'shop.example.com');
    traefik.set(edge, {
      startTime: 1,
      series: [{ service: a.names[0], code: '200', requests: 1 }],
    });
    await collect();
    await collect();
    expect(await ctx.db.select().from(errorRateSample)).toHaveLength(1);

    const res = await request(httpServer)
      .delete(`/applications/${web}`)
      .set('Cookie', ownerCookie);
    expect(res.status).toBe(200);

    expect(await ctx.db.select().from(errorRateSample)).toEqual([]);
  });
});
