import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  application,
  auditLog,
  incident,
  licenseKey,
  member,
  organizationRole,
  probe,
  uptimeCheck,
} from '../../src/db/schema';
import { FETCH_CLIENT } from '../../src/git-providers/fetch.provider';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { ProbeScheduler } from '../../src/service-health/probe-scheduler.service';
import { PROBE_TARGET } from '../../src/service-health/probe-target.port';
import { SERVICE_HEALTH_CLOCK } from '../../src/service-health/service-health.clock';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { withArgvExec } from '../utils/exec-double';
import {
  freezeOrganization,
  thawOrganization,
} from '../utils/frozen-organization';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { secondOrganizationOwner, signUpMember } from '../utils/test-auth';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

/**
 * An HTTP Uptime check, the Incident it opens and the one Notification each
 * way (spec slice 1), observed where an operator observes them: the
 * Slack webhook on the mocked fetch client, the health summary, audit rows,
 * and rows gone after a Delete.
 *
 * The four doubles are the spec's and nothing else is replaced but the
 * machine: `PROBE_TARGET` sends every Domain's host to a stub server on
 * loopback whose answer the test switches; `FETCH_CLIENT` catches the Slack
 * webhook; `SERVICE_HEALTH_CLOCK` stands still and each {@link step} moves it
 * one interval before calling `ProbeScheduler.tick` directly, so nothing waits
 * in real time; `RemoteExecService` and the Traefik writer stand in for the
 * machine a Stop, a Domain and a Delete touch. The real HTTP transport, the
 * Incident rule, the dispatcher and the Slack strategy all run.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const INTERVAL_MS = 30_000;

type StubMode = 'ok' | 'fail' | 'hang';

describe('Uptime check Incidents (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let scheduler: ProbeScheduler;

  // The stub every Domain's host is sent to.
  let stub: Server;
  let stubPort = 0;
  let mode: StubMode = 'ok';
  let stubHits = 0;

  let now = Date.parse('2026-09-25T10:00:00.000Z');
  const clock = { now: () => now };
  const fetchMock = jest.fn();

  const ok = { stdout: '', stderr: '', exitCode: 0 };
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
  const machine = (command: string) =>
    Promise.resolve(
      isPresenceProbe(command) ? { ...ok, stdout: 'absent' } : ok,
    );

  beforeAll(async () => {
    stub = createServer((_req, res) => {
      stubHits += 1;
      if (mode === 'hang') return; // never answers; the Probe's timeout ends it
      res.statusCode = mode === 'ok' ? 200 : 503;
      res.end(mode === 'ok' ? 'fine' : 'broken');
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
            tcp: () => ({ host: '127.0.0.1', port: stubPort }),
          },
        },
        { provide: SERVICE_HEALTH_CLOCK, useValue: clock },
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

  let ownerCookie: string;

  beforeEach(async () => {
    await ctx.resetDb();
    mode = 'ok';
    stubHits = 0;
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
    ownerCookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
  });

  /** Moves the clock one interval, sets the stub, and runs one tick. */
  async function step(next: StubMode): Promise<void> {
    mode = next;
    now += INTERVAL_MS;
    await scheduler.tick();
  }

  async function steps(next: StubMode, times: number): Promise<void> {
    for (let i = 0; i < times; i++) await step(next);
  }

  /** An Application with one Domain, in a fresh Project, via HTTP only. */
  async function applicationWithDomain(
    cookie = ownerCookie,
    slug = 'shop',
  ): Promise<{ applicationId: string; domainId: string }> {
    const project = await request(httpServer)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: slug });
    expect(project.status).toBe(201);
    const environment = await request(httpServer)
      .post('/environments')
      .set('Cookie', cookie)
      .send({
        name: 'production',
        projectId: (project.body as { projectId: string }).projectId,
      });
    expect(environment.status).toBe(201);
    const application = await request(httpServer)
      .post('/applications')
      .set('Cookie', cookie)
      .send({
        name: 'web',
        appName: `${slug}-web`,
        environmentId: (environment.body as { environmentId: string })
          .environmentId,
      });
    expect(application.status).toBe(201);
    const applicationId = (application.body as { applicationId: string })
      .applicationId;
    return {
      applicationId,
      domainId: await addDomain(applicationId, cookie, `${slug}.example.com`),
    };
  }

  async function addDomain(
    applicationId: string,
    cookie = ownerCookie,
    host = 'shop.example.com',
  ): Promise<string> {
    const res = await request(httpServer)
      .post('/domains')
      .set('Cookie', cookie)
      .send({
        host,
        path: '/health',
        applicationId,
        https: true,
        certificateType: 'letsencrypt',
      });
    expect(res.status).toBe(201);
    return (res.body as { domainId: string }).domainId;
  }

  async function addCheck(
    applicationId: string,
    domainId: string,
    cookie = ownerCookie,
  ): Promise<string> {
    const res = await request(httpServer)
      .post('/uptime-checks')
      .set('Cookie', cookie)
      .send({
        serviceType: 'application',
        serviceId: applicationId,
        domainId,
        intervalSeconds: 30,
        timeoutSeconds: 2,
        downAfter: 3,
      });
    expect(res.status).toBe(201);
    return (res.body as { uptimeCheckId: string }).uptimeCheckId;
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
    return res.body as { serviceIncident: boolean };
  }

  /** The bodies posted to one webhook. Every tick awaits its announcements. */
  function postedTo(hook: string): string[] {
    return fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith(`/${hook}`))
      .map(([, init]) => String((init as { body: string }).body));
  }

  async function health(applicationId: string, cookie = ownerCookie) {
    return request(httpServer)
      .get(`/service-health/application/${applicationId}`)
      .set('Cookie', cookie);
  }

  interface Summary {
    uptimeChecks: {
      uptimeCheckId: string;
      target: { url: string };
      lastProbe: { verdict: string; errorClass: string | null } | null;
      strip: { up: number; down: number }[];
      upShare24h: number | null;
    }[];
    openIncidents: { incidentId: string; openingError: string }[];
    incidents: {
      items: { closeReason: string | null; durationSeconds: number | null }[];
      meta: { totalItems: number };
    };
  }

  /** One Application, one Domain, one check, and a channel that opted in. */
  async function watched() {
    await slackChannel('OPTED', { serviceIncident: true });
    await slackChannel('DEFAULT', { appDeploy: true });
    const { applicationId, domainId } = await applicationWithDomain();
    const uptimeCheckId = await addCheck(applicationId, domainId);
    await step('ok');
    return { applicationId, domainId, uptimeCheckId };
  }

  describe('the Notification', () => {
    it('is off on a channel created without it', async () => {
      expect(
        (await slackChannel('DEFAULT', { appDeploy: true })).serviceIncident,
      ).toBe(false);
    });

    it('stays silent for N-1 downs, sends one opened message on the Nth and nothing more, then one closed message on the first up', async () => {
      const { applicationId } = await watched();

      await steps('fail', 2);
      expect(postedTo('OPTED')).toEqual([]);

      await step('fail');
      const opened = postedTo('OPTED');
      expect(opened).toHaveLength(1);
      for (const fragment of [
        'Service Incident Opened',
        'web',
        'shop',
        'production',
        'https://shop.example.com/health',
        'status 503',
      ]) {
        expect(opened[0]).toContain(fragment);
      }
      // Never the body the app answered with.
      expect(opened[0]).not.toContain('broken');

      await steps('fail', 3);
      expect(postedTo('OPTED')).toHaveLength(1);

      await step('ok');
      const sent = postedTo('OPTED');
      expect(sent).toHaveLength(2);
      expect(sent[1]).toContain('Service Incident Closed');
      expect(sent[1]).toContain('Recovered');

      await steps('ok', 2);
      expect(postedTo('OPTED')).toHaveLength(2);
      // A channel that did not opt in heard nothing at all.
      expect(postedTo('DEFAULT')).toEqual([]);

      const summary = (await health(applicationId)).body as Summary;
      expect(summary.openIncidents).toEqual([]);
      expect(summary.incidents.meta.totalItems).toBe(1);
      expect(summary.incidents.items[0]).toMatchObject({
        closeReason: 'recovered',
        durationSeconds: 4 * 30,
      });
      const [check] = summary.uptimeChecks;
      expect(check.lastProbe).toMatchObject({
        verdict: 'up',
        errorClass: null,
      });
      // 1 + 1 + 2 ups and 6 downs, all inside the last 24 hours.
      expect(check.upShare24h).toBeCloseTo(4 / 10);
      expect(check.strip).toHaveLength(48);
    });

    it('counts a Probe that hangs past its timeout as down', async () => {
      const { applicationId } = await watched();

      await steps('hang', 3);

      expect(postedTo('OPTED')).toHaveLength(1);
      expect(postedTo('OPTED')[0]).toContain('timeout');
      const summary = (await health(applicationId)).body as Summary;
      expect(summary.openIncidents).toMatchObject([
        { openingError: 'timeout' },
      ]);
    });

    it('opens its own Incident for every check that fails in the same tick', async () => {
      await slackChannel('OPTED', { serviceIncident: true });
      const { applicationId, domainId } = await applicationWithDomain();
      const second = await addDomain(
        applicationId,
        ownerCookie,
        'api.example.com',
      );
      await addCheck(applicationId, domainId);
      await addCheck(applicationId, second);
      await step('ok');

      await steps('fail', 3);

      const sent = postedTo('OPTED');
      expect(sent).toHaveLength(2);
      expect(
        sent.some((body) => body.includes('https://shop.example.com/health')),
      ).toBe(true);
      expect(
        sent.some((body) => body.includes('https://api.example.com/health')),
      ).toBe(true);
      const summary = (await health(applicationId)).body as Summary;
      expect(summary.openIncidents).toHaveLength(2);
    });
  });

  describe('Stop and turning off', () => {
    it('closes an open Incident once with service-stopped on a Stop, and probes nothing while Stopped', async () => {
      const { applicationId } = await watched();
      await steps('fail', 3);
      expect(postedTo('OPTED')).toHaveLength(1);

      const stopped = await request(httpServer)
        .post(`/applications/${applicationId}/stop`)
        .set('Cookie', ownerCookie);
      expect(stopped.status).toBe(200);

      const sent = postedTo('OPTED');
      expect(sent).toHaveLength(2);
      expect(sent[1]).toContain('Service Incident Closed');
      expect(sent[1]).toContain('Service stopped');

      const hitsAtStop = stubHits;
      const probesAtStop = await ctx.db.select().from(probe);
      await steps('fail', 4);
      // Nothing was probed while Stopped, and nothing more was announced.
      expect(stubHits).toBe(hitsAtStop);
      expect(await ctx.db.select().from(probe)).toHaveLength(
        probesAtStop.length,
      );
      expect(postedTo('OPTED')).toHaveLength(2);
    });

    it('closes an open Incident once with turned-off when the check is turned off, and an edit alone closes nothing', async () => {
      const { uptimeCheckId, applicationId } = await watched();
      await steps('fail', 3);

      const edited = await request(httpServer)
        .patch(`/uptime-checks/${uptimeCheckId}`)
        .set('Cookie', ownerCookie)
        .send({ downAfter: 5, expectedStatuses: ['2xx', '301'] });
      expect(edited.status).toBe(200);
      expect(postedTo('OPTED')).toHaveLength(1);
      expect(
        ((await health(applicationId)).body as Summary).openIncidents,
      ).toHaveLength(1);
      // The next Probe is judged by the new rule and is still down.
      await step('fail');
      expect(postedTo('OPTED')).toHaveLength(1);

      const off = await request(httpServer)
        .patch(`/uptime-checks/${uptimeCheckId}`)
        .set('Cookie', ownerCookie)
        .send({ enabled: false });
      expect(off.status).toBe(200);

      const sent = postedTo('OPTED');
      expect(sent).toHaveLength(2);
      expect(sent[1]).toContain('Turned off');

      const hits = stubHits;
      await steps('fail', 4);
      // A check that is off is not probed.
      expect(stubHits).toBe(hits);
      expect(postedTo('OPTED')).toHaveLength(2);
    });

    // US26/US7: N downs in a row, counted from the deliberate transition —
    // only a stretch the platform itself did not probe carries a run across.
    it('counts the run of downs afresh after the check is turned off and on', async () => {
      const { uptimeCheckId, applicationId } = await watched();
      await steps('fail', 2);

      for (const enabled of [false, true]) {
        const res = await request(httpServer)
          .patch(`/uptime-checks/${uptimeCheckId}`)
          .set('Cookie', ownerCookie)
          .send({ enabled });
        expect(res.status).toBe(200);
      }

      await step('fail');
      expect(postedTo('OPTED')).toEqual([]);
      expect(
        ((await health(applicationId)).body as Summary).openIncidents,
      ).toEqual([]);

      await steps('fail', 2);
      expect(postedTo('OPTED')).toHaveLength(1);
      expect(
        ((await health(applicationId)).body as Summary).openIncidents,
      ).toHaveLength(1);
    });

    it('counts the run of downs afresh after a Stop and a Start', async () => {
      const { applicationId } = await watched();
      await steps('fail', 2);

      for (const action of ['stop', 'start']) {
        const res = await request(httpServer)
          .post(`/applications/${applicationId}/${action}`)
          .set('Cookie', ownerCookie);
        expect(res.status).toBe(200);
      }

      await step('fail');
      expect(postedTo('OPTED')).toEqual([]);

      await steps('fail', 2);
      expect(postedTo('OPTED')).toHaveLength(1);
    });

    it('counts the run afresh after a Stop the tick saw but no Stop hook ran for', async () => {
      const { applicationId } = await watched();
      await steps('fail', 2);

      await ctx.db
        .update(application)
        .set({ applicationStatus: 'stopped' })
        .where(eq(application.applicationId, applicationId));
      await step('fail');
      await ctx.db
        .update(application)
        .set({ applicationStatus: 'done' })
        .where(eq(application.applicationId, applicationId));

      await step('fail');
      expect(postedTo('OPTED')).toEqual([]);
      await steps('fail', 2);
      expect(postedTo('OPTED')).toHaveLength(1);
    });

    it('carries a run across a stretch the platform did not probe', async () => {
      const { applicationId } = await watched();
      await steps('fail', 2);
      // The backend was down for an hour: no Probes, no transition.
      now += 60 * 60 * 1000;
      await step('fail');
      expect(postedTo('OPTED')).toHaveLength(1);
      expect(
        ((await health(applicationId)).body as Summary).openIncidents,
      ).toHaveLength(1);
    });
  });

  describe('Delete', () => {
    it('removes a check with its Probes and open Incident and announces nothing', async () => {
      const { uptimeCheckId } = await watched();
      await steps('fail', 3);
      fetchMock.mockClear();

      const res = await request(httpServer)
        .delete(`/uptime-checks/${uptimeCheckId}`)
        .set('Cookie', ownerCookie);
      expect(res.status).toBe(200);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(await ctx.db.select().from(uptimeCheck)).toEqual([]);
      expect(await ctx.db.select().from(probe)).toEqual([]);
      expect(await ctx.db.select().from(incident)).toEqual([]);
    });

    it("removes a deleted Application's checks, Probes and Incidents and announces nothing", async () => {
      const { applicationId } = await watched();
      await steps('fail', 3);
      fetchMock.mockClear();

      const res = await request(httpServer)
        .delete(`/applications/${applicationId}`)
        .set('Cookie', ownerCookie);
      expect(res.status).toBe(200);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(await ctx.db.select().from(uptimeCheck)).toEqual([]);
      expect(await ctx.db.select().from(probe)).toEqual([]);
      expect(await ctx.db.select().from(incident)).toEqual([]);
    });

    it('deletes a check with its Domain, and follows a Domain that is edited', async () => {
      const { domainId, applicationId } = await watched();

      const moved = await request(httpServer)
        .patch(`/domains/${domainId}`)
        .set('Cookie', ownerCookie)
        .send({ host: 'moved.example.com' });
      expect(moved.status).toBe(200);
      const [check] = ((await health(applicationId)).body as Summary)
        .uptimeChecks;
      expect(check.target.url).toBe('https://moved.example.com/health');

      const removed = await request(httpServer)
        .delete(`/domains/${domainId}`)
        .set('Cookie', ownerCookie);
      expect(removed.status).toBe(200);

      expect(await ctx.db.select().from(uptimeCheck)).toEqual([]);
    });
  });

  describe('authorization and audit', () => {
    it('refuses a health read naming no Service kind before it looks anything up', async () => {
      const res = await request(httpServer)
        .get('/service-health/volume/anything')
        .set('Cookie', ownerCookie);
      expect(res.status).toBe(400);
    });

    it("refuses a Domain that is not one of the Service's own", async () => {
      const first = await applicationWithDomain(ownerCookie, 'shop');
      const other = await applicationWithDomain(ownerCookie, 'blog');

      const res = await request(httpServer)
        .post('/uptime-checks')
        .set('Cookie', ownerCookie)
        .send({
          serviceType: 'application',
          serviceId: first.applicationId,
          domainId: other.domainId,
        });

      expect(res.status).toBe(400);
      expect(await ctx.db.select().from(uptimeCheck)).toEqual([]);
    });

    it('refuses every health read to a Member entitled only to another Service', async () => {
      const ours = await applicationWithDomain(ownerCookie, 'shop');
      const theirs = await applicationWithDomain(ownerCookie, 'blog');
      const check = await addCheck(ours.applicationId, ours.domainId);
      const ida = await signUpMember(httpServer, ownerCookie);
      await ctx.db
        .update(member)
        .set({ accessedServices: [theirs.applicationId] })
        .where(eq(member.userId, ida.id));

      expect((await health(ours.applicationId, ida.cookie)).status).toBe(403);
      const list = await request(httpServer)
        .get(
          `/uptime-checks?serviceType=application&serviceId=${ours.applicationId}`,
        )
        .set('Cookie', ida.cookie);
      expect(list.status).toBe(403);
      // Nor can she edit the check through its own id.
      const edit = await request(httpServer)
        .patch(`/uptime-checks/${check}`)
        .set('Cookie', ida.cookie)
        .send({ enabled: false });
      expect(edit.status).toBe(403);
      // The Service she is entitled to reads fine.
      expect((await health(theirs.applicationId, ida.cookie)).status).toBe(200);
    });

    it("reads another Organization's Service as not found, even for that Organization's owner", async () => {
      const ours = await applicationWithDomain(ownerCookie, 'shop');
      await addCheck(ours.applicationId, ours.domainId);
      const mallory = await secondOrganizationOwner(
        httpServer,
        ctx.db,
        ownerCookie,
      );

      expect((await health(ours.applicationId, mallory.cookie)).status).toBe(
        404,
      );
      const list = await request(httpServer)
        .get(
          `/uptime-checks?serviceType=application&serviceId=${ours.applicationId}`,
        )
        .set('Cookie', mallory.cookie);
      expect(list.status).toBe(404);
    });

    it('refuses every write to a Member whose role lacks service update, and lets it read', async () => {
      const ours = await applicationWithDomain(ownerCookie, 'shop');
      const check = await addCheck(ours.applicationId, ours.domainId);
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
        .set({ role: 'reader', accessedServices: [ours.applicationId] })
        .where(
          and(
            eq(member.userId, ida.id),
            eq(member.organizationId, row.organizationId),
          ),
        );

      const writes = [
        () =>
          request(httpServer)
            .post('/uptime-checks')
            .set('Cookie', ida.cookie)
            .send({
              serviceType: 'application',
              serviceId: ours.applicationId,
              domainId: ours.domainId,
            }),
        () =>
          request(httpServer)
            .patch(`/uptime-checks/${check}`)
            .set('Cookie', ida.cookie)
            .send({ enabled: false }),
        () =>
          request(httpServer)
            .delete(`/uptime-checks/${check}`)
            .set('Cookie', ida.cookie),
      ];
      for (const write of writes) {
        expect((await write()).status).toBe(403);
      }
      // Nothing was changed on the way to being refused.
      expect(await ctx.db.select().from(uptimeCheck)).toMatchObject([
        { uptimeCheckId: check, enabled: true },
      ]);
      expect((await health(ours.applicationId, ida.cookie)).status).toBe(200);
    });

    it('leaves an audit row for every create, edit, off/on and delete', async () => {
      const ours = await applicationWithDomain(ownerCookie, 'shop');
      const check = await addCheck(ours.applicationId, ours.domainId);
      for (const body of [
        { downAfter: 4 },
        { enabled: false },
        { enabled: true },
      ]) {
        const res = await request(httpServer)
          .patch(`/uptime-checks/${check}`)
          .set('Cookie', ownerCookie)
          .send(body);
        expect(res.status).toBe(200);
      }
      const removed = await request(httpServer)
        .delete(`/uptime-checks/${check}`)
        .set('Cookie', ownerCookie);
      expect(removed.status).toBe(200);

      const rows = await ctx.db
        .select({ action: auditLog.action, resourceId: auditLog.resourceId })
        .from(auditLog)
        .where(eq(auditLog.resourceType, 'uptimeCheck'));
      expect(rows.map((row) => row.action).sort()).toEqual(
        ['create', 'delete', 'update', 'update', 'update'].sort(),
      );
      expect(rows.every((row) => row.resourceId === check)).toBe(true);
    });
  });

  describe('retention', () => {
    it('prunes Probes older than seven days and keeps newer ones and every Incident', async () => {
      const { uptimeCheckId } = await watched();
      await steps('fail', 3);
      const day = 24 * 60 * 60 * 1000;
      await ctx.db.insert(probe).values([
        {
          uptimeCheckId,
          probedAt: new Date(now - 8 * day).toISOString(),
          verdict: 'down',
          errorClass: 'timeout',
        },
        {
          uptimeCheckId,
          probedAt: new Date(now - 6 * day).toISOString(),
          verdict: 'up',
        },
      ]);

      expect(await scheduler.prune()).toBe(1);

      const left = await ctx.db.select().from(probe);
      expect(left).toHaveLength(5);
      expect(await ctx.db.select().from(incident)).toHaveLength(1);
    });
  });

  describe('of a Frozen Organization', () => {
    afterEach(() => jest.restoreAllMocks());

    it('probes nothing while the Organization is frozen, and probes again once it is paid', async () => {
      const { applicationId, domainId } = await applicationWithDomain();
      const uptimeCheckId = await addCheck(applicationId, domainId);
      const [owned] = await ctx.db
        .select({ organizationId: member.organizationId })
        .from(member);
      await freezeOrganization(ctx, owned.organizationId);

      await steps('fail', 4);

      expect(stubHits).toBe(0);
      expect(
        await ctx.db
          .select()
          .from(probe)
          .where(eq(probe.uptimeCheckId, uptimeCheckId)),
      ).toEqual([]);
      expect(await ctx.db.select().from(incident)).toEqual([]);

      await thawOrganization(ctx, owned.organizationId);
      await step('ok');
      expect(stubHits).toBe(1);
    });
  });
});
