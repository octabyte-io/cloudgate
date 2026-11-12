import { createServer as createTcpServer } from 'node:net';
import type { AddressInfo, Server as TcpServer } from 'node:net';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { incident, postgres, probe, uptimeCheck } from '../../src/db/schema';
import { FETCH_CLIENT } from '../../src/git-providers/fetch.provider';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { ProbeScheduler } from '../../src/service-health/probe-scheduler.service';
import { PROBE_TARGET } from '../../src/service-health/probe-target.port';
import { SERVICE_HEALTH_CLOCK } from '../../src/service-health/service-health.clock';
import { SettingsService } from '../../src/settings/settings.service';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

/**
 * A TCP Uptime check whose port its Service no longer publishes: the
 * probe tick turns it off with a stated reason instead of dialling a dead
 * port, closes its open Incident with `port-unpublished`, and never retargets
 * it. Observed where an operator observes it: the Slack webhook on the mocked
 * fetch client, the Health tab's summary, the `PATCH` refusal, and the rows.
 *
 * `tcp-keyword-header.e2e-spec.ts`' doubles: `PROBE_TARGET` sends every TCP
 * dial to a local listener (open) or a closed port, recording what was asked
 * for, and `SERVICE_HEALTH_CLOCK` stands still until {@link step} moves it.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const INTERVAL_MS = 30_000;
const PLATFORM_ADDRESS = '203.0.113.7';

type TcpMode = 'open' | 'closed';

interface CheckView {
  uptimeCheckId: string;
  enabled: boolean;
  disabledReason: string | null;
  tcpTarget: { port: number } | null;
}

describe('A TCP check that loses its port (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let scheduler: ProbeScheduler;

  let listener: TcpServer;
  let listenerPort = 0;
  let closedPort = 0;
  let tcpMode: TcpMode = 'open';
  /** Every address a TCP Probe asked for, before the target mapped it. */
  let dials: string[] = [];

  let now = Date.parse('2026-09-28T10:00:00.000Z');
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
    listener = createTcpServer((socket) => socket.end());
    await new Promise<void>((resolve) =>
      listener.listen(0, '127.0.0.1', resolve),
    );
    listenerPort = (listener.address() as AddressInfo).port;
    const closed = createTcpServer();
    await new Promise<void>((resolve) =>
      closed.listen(0, '127.0.0.1', resolve),
    );
    closedPort = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));

    ctx = await createTestApp({
      overrideProviders: [
        {
          provide: PROBE_TARGET,
          useValue: {
            http: (url: URL) => url,
            tcp: (host: string, port: number) => {
              dials.push(`${host}:${port}`);
              return {
                host: '127.0.0.1',
                port: tcpMode === 'open' ? listenerPort : closedPort,
              };
            },
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
    await new Promise((resolve) => listener.close(resolve));
  });

  let cookie: string;

  beforeEach(async () => {
    await ctx.resetDb();
    tcpMode = 'open';
    dials = [];
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
    await ctx.app
      .get(SettingsService)
      .updateWebServerSettings({ serverIp: PLATFORM_ADDRESS });
    const slack = await request(httpServer)
      .post('/notifications/slack')
      .set('Cookie', cookie)
      .send({
        name: 'OPTED',
        webhookUrl: 'https://hooks.slack.com/services/T/B/OPTED',
        channel: '#ops',
        serviceIncident: true,
      });
    expect(slack.status).toBe(201);
  });

  async function step(tcp: TcpMode = 'open'): Promise<void> {
    tcpMode = tcp;
    now += INTERVAL_MS;
    await scheduler.tick();
  }

  function posted(): string[] {
    return fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/OPTED'))
      .map(([, init]) => String((init as { body: string }).body));
  }

  async function environment(slug: string): Promise<string> {
    const project = await request(httpServer)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: slug });
    expect(project.status).toBe(201);
    const env = await request(httpServer)
      .post('/environments')
      .set('Cookie', cookie)
      .send({
        name: 'production',
        projectId: (project.body as { projectId: string }).projectId,
      });
    expect(env.status).toBe(201);
    return (env.body as { environmentId: string }).environmentId;
  }

  async function application(): Promise<string> {
    const res = await request(httpServer)
      .post('/applications')
      .set('Cookie', cookie)
      .send({
        name: 'web',
        appName: 'shop-web',
        environmentId: await environment('shop'),
      });
    expect(res.status).toBe(201);
    return (res.body as { applicationId: string }).applicationId;
  }

  async function publish(
    applicationId: string,
    publishedPort: number,
  ): Promise<string> {
    const res = await request(httpServer)
      .post('/ports')
      .set('Cookie', cookie)
      .send({ applicationId, publishedPort, targetPort: 22 });
    expect(res.status).toBe(201);
    return (res.body as { portId: string }).portId;
  }

  async function database(): Promise<string> {
    const res = await request(httpServer)
      .post('/postgres')
      .set('Cookie', cookie)
      .send({
        name: 'orders-db',
        databaseName: 'orders',
        databaseUser: 'orders',
        environmentId: await environment('data'),
      });
    expect(res.status).toBe(201);
    const postgresId = (res.body as { postgresId: string }).postgresId;
    await setExternalPort(postgresId, 5432);
    return postgresId;
  }

  async function setExternalPort(postgresId: string, port: number | null) {
    await ctx.db
      .update(postgres)
      .set({ externalPort: port })
      .where(eq(postgres.postgresId, postgresId));
  }

  async function tcpCheck(
    serviceType: string,
    serviceId: string,
    port: number,
  ): Promise<string> {
    const res = await request(httpServer)
      .post('/uptime-checks')
      .set('Cookie', cookie)
      .send({
        serviceType,
        serviceId,
        kind: 'tcp',
        port,
        intervalSeconds: 30,
        timeoutSeconds: 2,
        downAfter: 3,
      });
    expect(res.status).toBe(201);
    return (res.body as { uptimeCheckId: string }).uptimeCheckId;
  }

  function patchCheck(uptimeCheckId: string, body: Record<string, unknown>) {
    return request(httpServer)
      .patch(`/uptime-checks/${uptimeCheckId}`)
      .set('Cookie', cookie)
      .send(body);
  }

  async function checksOf(
    serviceType: string,
    serviceId: string,
  ): Promise<CheckView[]> {
    const res = await request(httpServer)
      .get(`/service-health/${serviceType}/${serviceId}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return (res.body as { uptimeChecks: CheckView[] }).uptimeChecks;
  }

  async function probesOf(uptimeCheckId: string) {
    return ctx.db
      .select()
      .from(probe)
      .where(eq(probe.uptimeCheckId, uptimeCheckId));
  }

  describe('an Application’s port row', () => {
    it('turns the check off with the reason, and records no Probe, when the port row is removed', async () => {
      const applicationId = await application();
      const portId = await publish(applicationId, 2222);
      const checkId = await tcpCheck('application', applicationId, 2222);
      await step();
      expect(dials).toEqual([`${PLATFORM_ADDRESS}:2222`]);

      const removed = await request(httpServer)
        .delete(`/ports/${portId}`)
        .set('Cookie', cookie);
      expect(removed.status).toBe(200);
      await step();

      // The dead port was not dialled, and nothing — up or down — recorded.
      expect(dials).toHaveLength(1);
      expect(await probesOf(checkId)).toHaveLength(1);
      const [view] = await checksOf('application', applicationId);
      expect(view.enabled).toBe(false);
      expect(view.disabledReason).toContain(
        'Port 2222 is no longer published by this Service',
      );
      // Never retargeted.
      expect(view.tcpTarget?.port).toBe(2222);

      await step();
      expect(dials).toHaveLength(1);
      // No Incident was open, so there was nothing to announce.
      expect(posted()).toEqual([]);
    });

    it('turns the check off when the port row is re-numbered, never following it', async () => {
      const applicationId = await application();
      const portId = await publish(applicationId, 2222);
      const checkId = await tcpCheck('application', applicationId, 2222);

      const renumbered = await request(httpServer)
        .patch(`/ports/${portId}`)
        .set('Cookie', cookie)
        .send({ publishedPort: 2223 });
      expect(renumbered.status).toBe(200);
      await step();

      expect(dials).toEqual([]);
      expect(await probesOf(checkId)).toEqual([]);
      const [row] = await ctx.db
        .select()
        .from(uptimeCheck)
        .where(eq(uptimeCheck.uptimeCheckId, checkId));
      expect(row).toMatchObject({ enabled: false, port: 2222 });
      expect(row.disabledReason).toContain('Port 2222');
    });
  });

  it('turns off a check on a raw Compose whose file no longer publishes the port', async () => {
    const file = (ports: string[]) =>
      [
        'services:',
        '  redis:',
        '    image: redis:7',
        ...(ports.length
          ? ['    ports:', ...ports.map((p) => `      - "${p}"`)]
          : []),
      ].join('\n');
    const created = await request(httpServer)
      .post('/compose')
      .set('Cookie', cookie)
      .send({
        name: 'cache',
        environmentId: await environment('stack'),
        composeFile: file(['6380:6379']),
      });
    expect(created.status).toBe(201);
    const composeId = (created.body as { composeId: string }).composeId;
    const raw = await request(httpServer)
      .patch(`/compose/${composeId}`)
      .set('Cookie', cookie)
      .send({ sourceType: 'raw' });
    expect(raw.status).toBe(200);
    const checkId = await tcpCheck('compose', composeId, 6380);
    await step();
    expect(dials).toEqual([`${PLATFORM_ADDRESS}:6380`]);

    const saved = await request(httpServer)
      .patch(`/compose/${composeId}`)
      .set('Cookie', cookie)
      .send({ composeFile: file(['6381:6379']) });
    expect(saved.status).toBe(200);
    await step();

    expect(dials).toHaveLength(1);
    expect(await probesOf(checkId)).toHaveLength(1);
    const [view] = await checksOf('compose', composeId);
    expect(view).toMatchObject({ enabled: false });
    expect(view.disabledReason).toContain('Port 6380');
  });

  describe('a database’s external port', () => {
    it('closes an open Incident with port-unpublished when the external port is withdrawn, and the close says the port is no longer published', async () => {
      const postgresId = await database();
      const checkId = await tcpCheck('postgres', postgresId, 5432);
      await step('closed');
      await step('closed');
      await step('closed');
      const opened = posted();
      expect(opened).toHaveLength(1);
      expect(opened[0]).toContain('Service Incident Opened');

      await setExternalPort(postgresId, null);
      await step('closed');

      expect(await probesOf(checkId)).toHaveLength(3);
      const [closed] = await ctx.db
        .select()
        .from(incident)
        .where(eq(incident.uptimeCheckId, checkId));
      expect(closed.closedAt).not.toBeNull();
      expect(closed.closeReason).toBe('port-unpublished');
      const sent = posted();
      expect(sent).toHaveLength(2);
      expect(sent[1]).toContain('Service Incident Closed');
      expect(sent[1]).toContain('Port no longer published');

      // Announced exactly twice: later ticks announce nothing more.
      await step('closed');
      expect(posted()).toHaveLength(2);
    });

    it('refuses turning the check back on without re-aiming it, naming the published ports; re-aimed and on, it clears the reason and probes again', async () => {
      const postgresId = await database();
      const checkId = await tcpCheck('postgres', postgresId, 5432);
      await setExternalPort(postgresId, 5433);
      await step();
      expect(dials).toEqual([]);

      const refused = await patchCheck(checkId, { enabled: true });
      expect(refused.status).toBe(400);
      expect((refused.body as { message: string }).message).toBe(
        'Port 5432 is not one of this Service’s published TCP ports (5433)',
      );
      const [still] = await checksOf('postgres', postgresId);
      expect(still.enabled).toBe(false);
      expect(still.disabledReason).toContain('Port 5432');

      const reaimed = await patchCheck(checkId, { port: 5433, enabled: true });
      expect(reaimed.status).toBe(200);
      expect(reaimed.body).toMatchObject({
        enabled: true,
        disabledReason: null,
        tcpTarget: { port: 5433 },
      });
      await step();
      expect(dials).toEqual([`${PLATFORM_ADDRESS}:5433`]);
      expect(await probesOf(checkId)).toHaveLength(1);
    });

    it('does not judge a Stopped database for a lost port: the Stop skip comes first', async () => {
      const postgresId = await database();
      const checkId = await tcpCheck('postgres', postgresId, 5432);
      const stopped = await request(httpServer)
        .post(`/postgres/${postgresId}/stop`)
        .set('Cookie', cookie);
      expect(stopped.status).toBe(200);
      await setExternalPort(postgresId, null);
      await step();

      const [row] = await ctx.db
        .select()
        .from(uptimeCheck)
        .where(eq(uptimeCheck.uptimeCheckId, checkId));
      expect(row).toMatchObject({ enabled: true, disabledReason: null });
      expect(dials).toEqual([]);
    });
  });

  it('leaves an operator’s own turn-off without a reason', async () => {
    const postgresId = await database();
    const checkId = await tcpCheck('postgres', postgresId, 5432);

    const off = await patchCheck(checkId, { enabled: false });

    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ enabled: false, disabledReason: null });
  });
});
