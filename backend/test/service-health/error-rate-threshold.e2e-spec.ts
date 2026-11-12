import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { REMOTE_CLOUDGATE_DIRECTORY } from '../../src/common/config/cloudgate-directory';
import { withRequestMetrics } from '../../src/common/config/request-metrics';
import {
  application,
  auditLog,
  domain,
  errorRateThreshold,
  incident,
  licenseKey,
  member,
  organizationRole,
} from '../../src/db/schema';
import { FETCH_CLIENT } from '../../src/git-providers/fetch.provider';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { ProbeScheduler } from '../../src/service-health/probe-scheduler.service';
import { RequestMetricsCollector } from '../../src/service-health/request-metrics-collector.service';
import { SERVICE_HEALTH_CLOCK } from '../../src/service-health/service-health.clock';
import { REQUEST_COUNTERS_COMMAND } from '../../src/service-health/traefik-counters';
import { MAIN_TRAEFIK_DIR } from '../../src/settings/traefik-files.service';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { secondOrganizationOwner, signUpMember } from '../utils/test-auth';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

/**
 * The Error-rate threshold (spec slice 4): a breach opens the same
 * Incident, and sends the same `service-incident` Notification, as a failing
 * Uptime check — observed where an operator observes it: the Slack webhook on
 * the mocked fetch client, the health summary, audit rows, and rows gone after
 * a Delete.
 *
 * The doubles are the spec's: `RemoteExecService` answers the counter read
 * with Traefik Prometheus text this suite grows per collection
 * ({@link serve}), `SERVICE_HEALTH_CLOCK` stands still while each collection
 * moves it one refreshRate and calls `RequestMetricsCollector.tick` directly,
 * and `FETCH_CLIENT` catches the Slack webhook. The platform host's
 * traefik.yml (a temp dir behind `MAIN_TRAEFIK_DIR`) keeps request metrics.
 * The collector, the samples, the judgement, the Incident rows, the
 * dispatcher and the Slack strategy all run.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const REFRESH_MS = 60_000;
const TRAEFIK_YML = withRequestMetrics(
  "entryPoints:\n  web:\n    address: ':80'\n  websecure:\n    address: ':443'\n",
);

interface Threshold {
  errorRateThresholdId: string;
  serviceType: string;
  serviceId: string;
  percentage: number;
  windowMinutes: number;
  minRequests: number;
  enabled: boolean;
}

interface IncidentView {
  incidentId: string;
  source: string;
  errorRateThresholdId: string | null;
  openingErrorRate: number | null;
  openingRequests: number | null;
  worstErrorRate: number | null;
  closeReason: string | null;
  closedAt: string | null;
}

interface Summary {
  state: string;
  errorRate: { available: boolean };
  errorRateThreshold: Threshold | null;
  openIncidents: IncidentView[];
  incidents: { items: IncidentView[] };
}

describe('Error-rate threshold Incidents (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let collector: RequestMetricsCollector;
  let traefikDir: string;

  let now = Date.parse('2026-09-25T10:00:00.000Z');
  const clock = { now: () => now };
  const fetchMock = jest.fn();

  /** Cumulative counts per Traefik service name, as Traefik would report. */
  let counts: Map<string, { ok: number; errors: number; slow: number }>;
  const startTime = 1_700_000_000;

  const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
  function prometheusText(): string {
    const lines = [`process_start_time_seconds ${startTime.toExponential()}`];
    for (const [service, c] of counts) {
      for (const [code, requests, slow] of [
        ['200', c.ok, c.slow],
        ['500', c.errors, 0],
      ] as const) {
        const labels = `code="${code}",method="GET",protocol="http",service="${service}"`;
        lines.push(
          `traefik_service_request_duration_seconds_bucket{${labels},le="1.2"} ${requests - slow}`,
          `traefik_service_requests_total{${labels}} ${requests}`,
        );
      }
    }
    return lines.join('\n') + '\n';
  }
  const machine = (command: string) => {
    if (command === REQUEST_COUNTERS_COMMAND) {
      return Promise.resolve(ok(prometheusText()));
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
    traefikDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-ert-'));
    ctx = await createTestApp({
      overrideProviders: [
        { provide: SERVICE_HEALTH_CLOCK, useValue: clock },
        { provide: FETCH_CLIENT, useValue: fetchMock },
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
  let environmentId: string;

  beforeEach(async () => {
    await ctx.resetDb();
    counts = new Map();
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
    fs.rmSync(traefikDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(traefikDir, 'dynamic'), { recursive: true });
    fs.writeFileSync(path.join(traefikDir, 'traefik.yml'), TRAEFIK_YML);

    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    ownerCookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
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

  async function addApplication(appName: string): Promise<string> {
    const res = await request(httpServer)
      .post('/applications')
      .set('Cookie', ownerCookie)
      .send({ name: appName, appName, environmentId });
    expect(res.status).toBe(201);
    return (res.body as { applicationId: string }).applicationId;
  }

  /** Adds a Domain and answers the Traefik service name it is counted under. */
  async function addDomain(applicationId: string, host: string) {
    const res = await request(httpServer)
      .post('/domains')
      .set('Cookie', ownerCookie)
      .send({
        host,
        https: true,
        certificateType: 'letsencrypt',
        applicationId,
      });
    expect(res.status).toBe(201);
    const { domainId } = res.body as { domainId: string };
    const [row] = await ctx.db
      .select({ key: domain.uniqueConfigKey, appName: application.appName })
      .from(domain)
      .innerJoin(
        application,
        eq(application.applicationId, domain.applicationId),
      )
      .where(eq(domain.domainId, domainId));
    return { domainId, name: `${row.appName}-service-${row.key}@file` };
  }

  /**
   * An Application with a Domain whose counters have a baseline read, so the
   * next collection writes its first sample.
   */
  async function servedApplication(appName = 'shop-web') {
    const applicationId = await addApplication(appName);
    const { name } = await addDomain(applicationId, `${appName}.example.com`);
    counts.set(name, { ok: 0, errors: 0, slow: 0 });
    await collect(); // baseline: writes nothing, judges nothing
    return { applicationId, name };
  }

  /**
   * Traefik answers `requests` more requests for `name`, `errors` of them 5xx
   * and `slow` of the others slower than 1.2 s, then one collection runs.
   */
  async function serve(
    name: string,
    requests: number,
    errors: number,
    slow = 0,
  ): Promise<void> {
    const c = counts.get(name) ?? { ok: 0, errors: 0, slow: 0 };
    counts.set(name, {
      ok: c.ok + requests - errors,
      errors: c.errors + errors,
      slow: c.slow + slow,
    });
    await collect();
  }

  async function collect(): Promise<void> {
    now += REFRESH_MS;
    await collector.tick();
  }

  function putThreshold(
    serviceType: string,
    serviceId: string,
    body: Record<string, unknown> = {},
    cookie = ownerCookie,
  ) {
    return request(httpServer)
      .put(`/error-rate-thresholds/${serviceId}?serviceType=${serviceType}`)
      .set('Cookie', cookie)
      .send(body);
  }

  async function watched(body: Record<string, unknown> = {}) {
    await slackChannel('OPTED', { serviceIncident: true });
    const served = await servedApplication();
    const res = await putThreshold('application', served.applicationId, body);
    expect(res.status).toBe(200);
    return { ...served, threshold: res.body as Threshold };
  }

  async function slackChannel(hook: string, flags: Record<string, boolean>) {
    const res = await request(httpServer)
      .post('/notifications/slack')
      .set('Cookie', ownerCookie)
      .send({
        name: hook,
        webhookUrl: `https://hooks.slack.com/services/T/B/${hook}`,
        channel: '#ops',
        ...flags,
      });
    expect(res.status).toBe(201);
  }

  /** The bodies posted to one webhook. Every tick awaits its announcements. */
  function postedTo(hook: string): string[] {
    return fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith(`/${hook}`))
      .map(([, init]) => String((init as { body: string }).body));
  }

  async function summary(
    applicationId: string,
    cookie = ownerCookie,
  ): Promise<Summary> {
    const res = await request(httpServer)
      .get(`/service-health/application/${applicationId}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.body as Summary;
  }

  describe('judgement', () => {
    it('opens exactly one Incident on the first breaching window and closes it once on the first judged-clear one', async () => {
      const { applicationId, name } = await watched({ windowMinutes: 1 });

      await serve(name, 40, 1); // 2.5 %: clear
      expect(postedTo('OPTED')).toEqual([]);

      await serve(name, 40, 5); // 12.5 %: breach
      const opened = postedTo('OPTED');
      expect(opened).toHaveLength(1);
      expect(opened[0]).toContain('Service Incident Opened');
      expect(opened[0]).toContain('shop-web');
      expect(opened[0]).toContain('5 % over 1 minute');
      expect(opened[0]).toContain('12.5 % of 40 requests');

      await serve(name, 40, 20); // 50 %: still breaching, announces nothing
      await serve(name, 40, 8); // 20 %
      expect(postedTo('OPTED')).toHaveLength(1);

      await serve(name, 40, 0); // clear: closes, no run of clears needed
      const sent = postedTo('OPTED');
      expect(sent).toHaveLength(2);
      expect(sent[1]).toContain('Service Incident Closed');
      expect(sent[1]).toContain('Recovered');
      expect(sent[1]).toContain('50 %');

      await serve(name, 40, 0);
      expect(postedTo('OPTED')).toHaveLength(2);

      const health = await summary(applicationId);
      expect(health.openIncidents).toEqual([]);
      expect(health.incidents.items).toHaveLength(1);
      expect(health.incidents.items[0]).toMatchObject({
        source: 'error-rate-threshold',
        openingErrorRate: 0.125,
        openingRequests: 40,
        worstErrorRate: 0.5,
        closeReason: 'recovered',
      });
    });

    it('records the opening rate and request count and tracks the worst rate while open', async () => {
      const { applicationId, name, threshold } = await watched({
        windowMinutes: 1,
      });

      await serve(name, 20, 2); // 10 %
      expect((await summary(applicationId)).openIncidents).toMatchObject([
        {
          source: 'error-rate-threshold',
          errorRateThresholdId: threshold.errorRateThresholdId,
          openingErrorRate: 0.1,
          openingRequests: 20,
          worstErrorRate: 0.1,
          closedAt: null,
        },
      ]);

      await serve(name, 20, 6); // 30 %: worse
      await serve(name, 20, 4); // 20 %: better, but not clear
      const [open] = (await summary(applicationId)).openIncidents;
      expect(open).toMatchObject({
        openingErrorRate: 0.1,
        openingRequests: 20,
        worstErrorRate: 0.3,
      });
      expect((await summary(applicationId)).state).toBe('incident');
    });

    it('sums the trailing window across collections before it is loud enough to judge', async () => {
      const { name } = await watched(); // 5 % over 5 minutes, 20 requests

      await serve(name, 10, 5); // 10 in the window: quiet
      expect(postedTo('OPTED')).toEqual([]);
      await serve(name, 10, 5); // 20 in the window, 50 %: breach
      expect(postedTo('OPTED')).toHaveLength(1);
      expect(postedTo('OPTED')[0]).toContain('50 % of 20 requests');
    });

    it('neither opens nor closes an Incident on a window below the minimum request count', async () => {
      const { applicationId, name } = await watched({
        windowMinutes: 1,
        minRequests: 20,
      });

      await serve(name, 19, 19); // every request failed, but too quiet
      await serve(name, 0, 0); // nobody called at all
      expect(postedTo('OPTED')).toEqual([]);
      expect(await ctx.db.select().from(incident)).toEqual([]);

      await serve(name, 20, 10); // breach
      expect(postedTo('OPTED')).toHaveLength(1);

      await serve(name, 19, 0); // clear, but too quiet to say so
      await serve(name, 0, 0);
      expect(postedTo('OPTED')).toHaveLength(1);
      expect((await summary(applicationId)).openIncidents).toHaveLength(1);
      // A quiet window does not move the worst rate either.
      expect(
        (await summary(applicationId)).openIncidents[0].worstErrorRate,
      ).toBe(0.5);
    });

    it('never opens an Incident on the slow share', async () => {
      const { name } = await watched({ windowMinutes: 1 });
      await serve(name, 40, 0, 40); // every request slow, none failed
      await serve(name, 40, 0, 40);
      expect(postedTo('OPTED')).toEqual([]);
      expect(await ctx.db.select().from(incident)).toEqual([]);
    });
  });

  describe('Stop and turning off', () => {
    it('closes an open Incident once with service-stopped on a Stop, and judges nothing while Stopped', async () => {
      const { applicationId, name } = await watched({ windowMinutes: 1 });
      await serve(name, 20, 10);
      expect(postedTo('OPTED')).toHaveLength(1);

      const stopped = await request(httpServer)
        .post(`/applications/${applicationId}/stop`)
        .set('Cookie', ownerCookie);
      expect(stopped.status).toBe(200);

      const sent = postedTo('OPTED');
      expect(sent).toHaveLength(2);
      expect(sent[1]).toContain('Service Incident Closed');
      expect(sent[1]).toContain('Service stopped');

      // Traefik's 502s for a Stopped Service are collected, but not judged.
      await serve(name, 20, 20);
      await serve(name, 20, 20);
      expect(postedTo('OPTED')).toHaveLength(2);
      const rows = await ctx.db.select().from(incident);
      expect(rows).toHaveLength(1);
      expect(rows[0].closeReason).toBe('service-stopped');
    });

    it('closes an open Incident once with turned-off when the threshold is turned off, and an edit alone closes nothing', async () => {
      const { applicationId, name } = await watched({ windowMinutes: 1 });
      await serve(name, 20, 10);

      const edited = await putThreshold('application', applicationId, {
        windowMinutes: 1,
        percentage: 20,
        minRequests: 10,
      });
      expect(edited.status).toBe(200);
      expect(postedTo('OPTED')).toHaveLength(1);
      expect((await summary(applicationId)).openIncidents).toHaveLength(1);

      const off = await putThreshold('application', applicationId, {
        windowMinutes: 1,
        percentage: 20,
        minRequests: 10,
        enabled: false,
      });
      expect(off.status).toBe(200);
      expect(off.body).toMatchObject({ enabled: false, percentage: 20 });
      const sent = postedTo('OPTED');
      expect(sent).toHaveLength(2);
      expect(sent[1]).toContain('Turned off');

      // Off: not judged.
      await serve(name, 20, 20);
      expect(postedTo('OPTED')).toHaveLength(2);
      expect(await ctx.db.select().from(incident)).toHaveLength(1);
    });
  });

  describe('Delete', () => {
    it('removes the threshold with its open Incident and announces nothing', async () => {
      const { applicationId, name } = await watched({ windowMinutes: 1 });
      await serve(name, 20, 10);
      fetchMock.mockClear();

      const res = await request(httpServer)
        .delete(
          `/error-rate-thresholds/${applicationId}?serviceType=application`,
        )
        .set('Cookie', ownerCookie);
      expect(res.status).toBe(200);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(await ctx.db.select().from(errorRateThreshold)).toEqual([]);
      expect(await ctx.db.select().from(incident)).toEqual([]);
      expect((await summary(applicationId)).errorRateThreshold).toBeNull();
    });

    it("removes a deleted Application's threshold and Incidents and announces nothing", async () => {
      const { applicationId, name } = await watched({ windowMinutes: 1 });
      await serve(name, 20, 10);
      fetchMock.mockClear();

      const res = await request(httpServer)
        .delete(`/applications/${applicationId}`)
        .set('Cookie', ownerCookie);
      expect(res.status).toBe(200);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(await ctx.db.select().from(errorRateThreshold)).toEqual([]);
      expect(await ctx.db.select().from(incident)).toEqual([]);
    });
  });

  describe('configuration', () => {
    it('refuses a threshold on a Database', async () => {
      const created = await request(httpServer)
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
      expect(created.status).toBe(201);
      const { postgresId } = created.body as { postgresId: string };

      const res = await putThreshold('postgres', postgresId);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('Database');
      expect(await ctx.db.select().from(errorRateThreshold)).toEqual([]);
    });

    it('takes the defaults, and can be added to a Service whose Error rate is not available yet', async () => {
      const applicationId = await addApplication('shop-web'); // no Domain

      const res = await putThreshold('application', applicationId);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        serviceType: 'application',
        serviceId: applicationId,
        percentage: 5,
        windowMinutes: 5,
        minRequests: 20,
        enabled: true,
      });
      const got = await request(httpServer)
        .get(`/error-rate-thresholds/${applicationId}?serviceType=application`)
        .set('Cookie', ownerCookie);
      expect(got.status).toBe(200);
      expect(got.body).toEqual(res.body);

      const health = await summary(applicationId);
      expect(health.errorRate.available).toBe(false);
      expect(health.errorRateThreshold).toEqual(res.body);
      // Nothing to judge: the threshold is not watching anything yet.
      expect(health.state).toBe('unchecked');

      const again = await putThreshold('application', applicationId, {
        percentage: 2.5,
      });
      expect(again.status).toBe(200);
      expect(await ctx.db.select().from(errorRateThreshold)).toHaveLength(1);
      expect(again.body).toMatchObject({ percentage: 2.5 });
    });

    it('refuses a window that is not 1, 5, 15 or 30 minutes', async () => {
      const applicationId = await addApplication('shop-web');
      const res = await putThreshold('application', applicationId, {
        windowMinutes: 10,
      });
      expect(res.status).toBe(400);
      expect(await ctx.db.select().from(errorRateThreshold)).toEqual([]);
    });

    it('reads up, in the summary and the Environment row alike, once an enabled threshold has an Error rate to judge', async () => {
      const { applicationId, name } = await watched({ windowMinutes: 1 });
      await serve(name, 40, 0);

      expect((await summary(applicationId)).state).toBe('up');
      const env = await request(httpServer)
        .get(`/environments/${environmentId}/health`)
        .set('Cookie', ownerCookie);
      expect(env.status).toBe(200);
      expect(
        (env.body as { services: { serviceId: string; state: string }[] })
          .services,
      ).toEqual([
        expect.objectContaining({ serviceId: applicationId, state: 'up' }),
      ]);

      await serve(name, 40, 40);
      const breached = await request(httpServer)
        .get(`/environments/${environmentId}/health`)
        .set('Cookie', ownerCookie);
      expect(
        (
          breached.body as {
            services: { state: string; openIncidents: number }[];
          }
        ).services[0],
      ).toMatchObject({ state: 'incident', openIncidents: 1 });
      expect((await summary(applicationId)).state).toBe('incident');
    });
  });

  describe('authorization and audit', () => {
    it('refuses every write to a Member whose role lacks service update, and lets it read', async () => {
      const applicationId = await addApplication('shop-web');
      expect((await putThreshold('application', applicationId)).status).toBe(
        200,
      );
      const ida = await signUpMember(httpServer, ownerCookie);
      const [row] = await ctx.db
        .select({ organizationId: member.organizationId })
        .from(member)
        .where(eq(member.userId, ida.id));
      await ctx.db.insert(licenseKey).values({
        organizationId: row.organizationId,
        key: 'test-license-key',
        status: 'active',
        enableEnterpriseFeatures: true,
      });
      await ctx.db.insert(organizationRole).values({
        organizationId: row.organizationId,
        role: 'reader',
        permission: { service: ['read'] },
      });
      await ctx.db
        .update(member)
        .set({ role: 'reader', accessedServices: [applicationId] })
        .where(
          and(
            eq(member.userId, ida.id),
            eq(member.organizationId, row.organizationId),
          ),
        );

      const writes = [
        () =>
          putThreshold(
            'application',
            applicationId,
            { enabled: false },
            ida.cookie,
          ),
        () =>
          request(httpServer)
            .delete(
              `/error-rate-thresholds/${applicationId}?serviceType=application`,
            )
            .set('Cookie', ida.cookie),
      ];
      for (const write of writes) {
        expect((await write()).status).toBe(403);
      }
      expect(await ctx.db.select().from(errorRateThreshold)).toMatchObject([
        { enabled: true },
      ]);
      const read = await request(httpServer)
        .get(`/error-rate-thresholds/${applicationId}?serviceType=application`)
        .set('Cookie', ida.cookie);
      expect(read.status).toBe(200);
      expect(
        (await summary(applicationId, ida.cookie)).errorRateThreshold,
      ).not.toBeNull();
    });

    it('refuses a Member entitled only to another Service, and reads another Organization’s Service as not found', async () => {
      const ours = await addApplication('shop-web');
      const theirs = await addApplication('shop-blog');
      expect((await putThreshold('application', ours)).status).toBe(200);
      const ida = await signUpMember(httpServer, ownerCookie);
      await ctx.db
        .update(member)
        .set({ accessedServices: [theirs] })
        .where(eq(member.userId, ida.id));

      const read = await request(httpServer)
        .get(`/error-rate-thresholds/${ours}?serviceType=application`)
        .set('Cookie', ida.cookie);
      expect(read.status).toBe(403);
      expect(
        (await putThreshold('application', ours, {}, ida.cookie)).status,
      ).toBe(403);

      const mallory = await secondOrganizationOwner(
        httpServer,
        ctx.db,
        ownerCookie,
      );
      expect(
        (await putThreshold('application', ours, {}, mallory.cookie)).status,
      ).toBe(404);
      expect(await ctx.db.select().from(errorRateThreshold)).toMatchObject([
        { enabled: true, percentage: 5 },
      ]);
    });

    it('leaves an audit row for every put, off/on and delete, keyed on the Service', async () => {
      const applicationId = await addApplication('shop-web');
      for (const body of [
        {},
        { percentage: 10 },
        { enabled: false },
        { enabled: true },
      ]) {
        expect(
          (await putThreshold('application', applicationId, body)).status,
        ).toBe(200);
      }
      const removed = await request(httpServer)
        .delete(
          `/error-rate-thresholds/${applicationId}?serviceType=application`,
        )
        .set('Cookie', ownerCookie);
      expect(removed.status).toBe(200);

      const rows = await ctx.db
        .select({ action: auditLog.action, resourceId: auditLog.resourceId })
        .from(auditLog)
        .where(eq(auditLog.resourceType, 'errorRateThreshold'));
      expect(rows.map((row) => row.action).sort()).toEqual(
        ['delete', 'update', 'update', 'update', 'update'].sort(),
      );
      expect(rows.every((row) => row.resourceId === applicationId)).toBe(true);
    });
  });

  it('closes a threshold Incident the Stop hook missed on the next probe tick', async () => {
    const { applicationId, name } = await watched({ windowMinutes: 1 });
    await serve(name, 20, 10);
    // A Stop written without the hook (a status route, a Stop added later).
    await ctx.db
      .update(application)
      .set({ applicationStatus: 'stopped' })
      .where(eq(application.applicationId, applicationId));

    await ctx.app.get(ProbeScheduler).tick();

    const sent = postedTo('OPTED');
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('Service stopped');
  });
});
