import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import type { AddressInfo, Server as TcpServer } from 'node:net';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { auditLog, postgres, uptimeCheck } from '../../src/db/schema';
import { LibsqlService } from '../../src/databases/libsql/libsql.service';
import { MariadbService } from '../../src/databases/mariadb/mariadb.service';
import { MongoService } from '../../src/databases/mongo/mongo.service';
import { MysqlService } from '../../src/databases/mysql/mysql.service';
import { PostgresService } from '../../src/databases/postgres/postgres.service';
import { RedisService } from '../../src/databases/redis/redis.service';
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
 * TCP Uptime checks, a required keyword and the write-only header (spec
 * slice 2), observed where an operator observes them: the Slack webhook
 * on the mocked fetch client, every API response, and the row at rest.
 *
 * The doubles are the Uptime suite's and nothing else is replaced but the machine:
 * `PROBE_TARGET` sends every Domain's host to a stub HTTP server and every TCP
 * dial to a stub listener — recording what was asked for, so a suite can see
 * the address and port a check dials — and the real `probeHttp` / `probeTcp`
 * judge them. `SERVICE_HEALTH_CLOCK` stands still and {@link step} moves it one
 * interval before calling `ProbeScheduler.tick` directly.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const INTERVAL_MS = 30_000;
/** The platform host's address, which a local Service's TCP check dials. */
const PLATFORM_ADDRESS = '203.0.113.7';
const HEADER_VALUE = 'Bearer tok-7c1d9e0f-never-shown';
const ROTATED_VALUE = 'Bearer tok-rotated-2b4a-never-shown';
const KEYWORD = 'all-systems-operational';

/**
 * `ok` answers 200 with the keyword; `fail` a 503; `no-keyword` a 200 page
 * without it (a maintenance page served with a success status). The TCP
 * listener is dialled when `tcp` is `open` and a closed port when `closed`.
 */
type HttpMode = 'ok' | 'fail' | 'no-keyword';
type TcpMode = 'open' | 'closed';

describe('TCP checks, the keyword and the header (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let scheduler: ProbeScheduler;

  let stub: Server;
  let stubPort = 0;
  let httpMode: HttpMode = 'ok';
  /** The Authorization header of every request the stub received, in order. */
  let receivedAuth: (string | null)[] = [];

  let listener: TcpServer;
  let listenerPort = 0;
  let closedPort = 0;
  let tcpMode: TcpMode = 'open';
  /** Every address a TCP Probe asked for, before the target mapped it. */
  let dials: string[] = [];
  let accepted = 0;

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
    stub = createServer((req, res) => {
      receivedAuth.push(req.headers.authorization ?? null);
      res.statusCode = httpMode === 'fail' ? 503 : 200;
      res.end(
        httpMode === 'ok' ? `<p>${KEYWORD}</p>` : `<p>down for maintenance</p>`,
      );
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    stubPort = (stub.address() as AddressInfo).port;

    listener = createTcpServer((socket) => {
      accepted += 1;
      socket.end();
    });
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
            http: (url: URL) =>
              new URL(`http://127.0.0.1:${stubPort}${url.pathname}`),
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
    stub.closeAllConnections();
    await new Promise((resolve) => stub.close(resolve));
    await new Promise((resolve) => listener.close(resolve));
  });

  let cookie: string;

  beforeEach(async () => {
    await ctx.resetDb();
    httpMode = 'ok';
    tcpMode = 'open';
    receivedAuth = [];
    dials = [];
    accepted = 0;
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
    await slackChannel('OPTED');
  });

  async function step(http: HttpMode, tcp: TcpMode = 'open'): Promise<void> {
    httpMode = http;
    tcpMode = tcp;
    now += INTERVAL_MS;
    await scheduler.tick();
  }

  async function steps(times: number, http: HttpMode, tcp?: TcpMode) {
    for (let i = 0; i < times; i++) await step(http, tcp);
  }

  async function slackChannel(hook: string) {
    const res = await request(httpServer)
      .post('/notifications/slack')
      .set('Cookie', cookie)
      .send({
        name: hook,
        webhookUrl: `https://hooks.slack.com/services/T/B/${hook}`,
        channel: '#ops',
        serviceIncident: true,
      });
    expect(res.status).toBe(201);
  }

  function postedTo(hook = 'OPTED'): string[] {
    return fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith(`/${hook}`))
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
    return (res.body as { postgresId: string }).postgresId;
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

  async function domainOf(applicationId: string): Promise<string> {
    const res = await request(httpServer)
      .post('/domains')
      .set('Cookie', cookie)
      .send({ host: 'shop.example.com', path: '/health', applicationId });
    expect(res.status).toBe(201);
    return (res.body as { domainId: string }).domainId;
  }

  function addCheck(body: Record<string, unknown>) {
    return request(httpServer)
      .post('/uptime-checks')
      .set('Cookie', cookie)
      .send({ intervalSeconds: 30, timeoutSeconds: 2, downAfter: 3, ...body });
  }

  interface CheckView {
    uptimeCheckId: string;
    kind: string;
    tcpTarget: { host: string; port: number; address: string } | null;
    keyword: string | null;
    headerName: string | null;
    hasHeaderValue: boolean;
    lastProbe?: { verdict: string; errorClass: string | null } | null;
  }

  async function summary(
    serviceType: string,
    serviceId: string,
  ): Promise<{ text: string; checks: CheckView[] }> {
    const res = await request(httpServer)
      .get(`/service-health/${serviceType}/${serviceId}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return {
      text: res.text,
      checks: (res.body as { uptimeChecks: CheckView[] }).uptimeChecks,
    };
  }

  describe('a TCP check on a database', () => {
    it('refuses a database without an external port, saying to publish it first', async () => {
      const postgresId = await database();

      const ports = await request(httpServer)
        .get('/uptime-checks/published-ports')
        .query({ serviceType: 'postgres', serviceId: postgresId })
        .set('Cookie', cookie);
      const refused = await addCheck({
        serviceType: 'postgres',
        serviceId: postgresId,
        kind: 'tcp',
        port: 5432,
      });

      expect(ports.status).toBe(200);
      const answer = ports.body as {
        ports: unknown[];
        unavailableReason: string | null;
      };
      expect(answer.ports).toEqual([]);
      expect(answer.unavailableReason).toContain('no external port');
      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.body)).toContain('Publish its port first');
      expect(await ctx.db.select().from(uptimeCheck)).toEqual([]);
    });

    it('dials the external port on the platform host’s address, opens one Incident after three refusals and closes it on the first connect', async () => {
      const postgresId = await database();
      await ctx.db
        .update(postgres)
        .set({ externalPort: 5432 })
        .where(eq(postgres.postgresId, postgresId));

      const ports = await request(httpServer)
        .get('/uptime-checks/published-ports')
        .query({ serviceType: 'postgres', serviceId: postgresId })
        .set('Cookie', cookie);
      expect(ports.body).toEqual({
        host: PLATFORM_ADDRESS,
        ports: [{ port: 5432, label: 'Database' }],
        unavailableReason: null,
      });
      const wrongPort = await addCheck({
        serviceType: 'postgres',
        serviceId: postgresId,
        kind: 'tcp',
        port: 5433,
      });
      expect(wrongPort.status).toBe(400);
      const created = await addCheck({
        serviceType: 'postgres',
        serviceId: postgresId,
        kind: 'tcp',
        port: 5432,
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        kind: 'tcp',
        target: null,
        tcpTarget: {
          host: PLATFORM_ADDRESS,
          port: 5432,
          address: `${PLATFORM_ADDRESS}:5432`,
        },
      });

      await step('ok', 'open');
      expect(dials).toEqual([`${PLATFORM_ADDRESS}:5432`]);
      expect(accepted).toBe(1);

      await steps(2, 'ok', 'closed');
      expect(postedTo()).toEqual([]);
      await step('ok', 'closed');
      const opened = postedTo();
      expect(opened).toHaveLength(1);
      expect(opened[0]).toContain('Service Incident Opened');
      expect(opened[0]).toContain(`${PLATFORM_ADDRESS}:5432`);
      expect(opened[0]).toContain('refused');

      await step('ok', 'open');
      const sent = postedTo();
      expect(sent).toHaveLength(2);
      expect(sent[1]).toContain('Service Incident Closed');
      expect(sent[1]).toContain('Recovered');
      const { checks } = await summary('postgres', postgresId);
      expect(checks[0].lastProbe).toMatchObject({ verdict: 'up' });
    });

    it('closes an open Incident once with service-stopped when the database is Stopped', async () => {
      const postgresId = await database();
      await ctx.db
        .update(postgres)
        .set({ externalPort: 5432 })
        .where(eq(postgres.postgresId, postgresId));
      expect(
        (
          await addCheck({
            serviceType: 'postgres',
            serviceId: postgresId,
            kind: 'tcp',
            port: 5432,
          })
        ).status,
      ).toBe(201);
      await steps(3, 'ok', 'closed');
      expect(postedTo()).toHaveLength(1);

      const stopped = await request(httpServer)
        .post(`/postgres/${postgresId}/stop`)
        .set('Cookie', cookie);
      expect(stopped.status).toBe(200);

      // Announced by the Stop itself, before any tick ran.
      const sent = postedTo();
      expect(sent).toHaveLength(2);
      expect(sent[1]).toContain('Service Incident Closed');
      expect(sent[1]).toContain('Service stopped');

      const dialsAtStop = dials.length;
      await steps(3, 'ok', 'closed');
      expect(dials).toHaveLength(dialsAtStop);
      expect(postedTo()).toHaveLength(2);
    });
  });

  it('wires the Stop hook into every database engine, not only the one exercised above', () => {
    // `incidents` is `@Optional()` on `BaseDatabaseService` so a hand-built
    // engine still compiles; an engine module that forgot to import
    // `ServiceHealthModule` would get `undefined` and close nothing on a Stop.
    const hookOf = (service: object): unknown =>
      (service as { incidents?: unknown }).incidents;
    const engines = [
      LibsqlService,
      MariadbService,
      MongoService,
      MysqlService,
      PostgresService,
      RedisService,
    ];
    const unwired = engines
      .filter((engine) => !hookOf(ctx.app.get(engine, { strict: false })))
      .map((engine) => engine.name);

    expect(unwired).toEqual([]);
  });

  describe('a TCP check on an Application and on a Compose', () => {
    it('dials an Application’s published TCP port, and refuses one it does not publish', async () => {
      const applicationId = await application();
      const none = await addCheck({
        serviceType: 'application',
        serviceId: applicationId,
        kind: 'tcp',
        port: 2222,
      });
      expect(none.status).toBe(400);
      expect(JSON.stringify(none.body)).toContain('publishes no TCP port');

      const published = await request(httpServer)
        .post('/ports')
        .set('Cookie', cookie)
        .send({ applicationId, publishedPort: 2222, targetPort: 22 });
      expect(published.status).toBe(201);
      const created = await addCheck({
        serviceType: 'application',
        serviceId: applicationId,
        kind: 'tcp',
        port: 2222,
      });
      expect(created.status).toBe(201);

      await step('ok', 'open');
      expect(dials).toEqual([`${PLATFORM_ADDRESS}:2222`]);
      expect(accepted).toBe(1);
    });

    it('dials the port a Compose file publishes, not an inner service', async () => {
      const res = await request(httpServer)
        .post('/compose')
        .set('Cookie', cookie)
        .send({
          name: 'cache',
          environmentId: await environment('stack'),
          composeFile: [
            'services:',
            '  redis:',
            '    image: redis:7',
            '    ports:',
            '      - "6380:6379"',
            '  worker:',
            '    image: busybox',
          ].join('\n'),
        });
      expect(res.status).toBe(201);
      const composeId = (res.body as { composeId: string }).composeId;
      // A file entered in the console, which is the file it deploys.
      const raw = await request(httpServer)
        .patch(`/compose/${composeId}`)
        .set('Cookie', cookie)
        .send({ sourceType: 'raw' });
      expect(raw.status).toBe(200);

      const ports = await request(httpServer)
        .get('/uptime-checks/published-ports')
        .query({ serviceType: 'compose', serviceId: composeId })
        .set('Cookie', cookie);
      expect(ports.body).toMatchObject({
        ports: [{ port: 6380, label: 'redis → 6379' }],
      });
      // The container port is an inner service's, and is not dialled.
      const inner = await addCheck({
        serviceType: 'compose',
        serviceId: composeId,
        kind: 'tcp',
        port: 6379,
      });
      expect(inner.status).toBe(400);
      const created = await addCheck({
        serviceType: 'compose',
        serviceId: composeId,
        kind: 'tcp',
        port: 6380,
      });
      expect(created.status).toBe(201);

      await step('ok', 'open');
      expect(dials).toEqual([`${PLATFORM_ADDRESS}:6380`]);
    });

    it('refuses a TCP check on a Compose deployed from a repository, saying why honestly', async () => {
      const res = await request(httpServer)
        .post('/compose')
        .set('Cookie', cookie)
        .send({
          name: 'repo-stack',
          environmentId: await environment('repo'),
          // A repository stack says so: a create with a file and no
          // `sourceType` is stored `raw` (#1338).
          sourceType: 'github',
          // The column's copy is not what a repository Compose deploys.
          composeFile: [
            'services:',
            '  redis:',
            '    image: redis:7',
            '    ports:',
            '      - "6380:6379"',
          ].join('\n'),
        });
      expect(res.status).toBe(201);
      const composeId = (res.body as { composeId: string }).composeId;
      expect((res.body as { sourceType: string }).sourceType).not.toBe('raw');

      const ports = await request(httpServer)
        .get('/uptime-checks/published-ports')
        .query({ serviceType: 'compose', serviceId: composeId })
        .set('Cookie', cookie);
      const reason = (ports.body as { unavailableReason: string })
        .unavailableReason;
      expect(ports.body).toMatchObject({ ports: [] });
      expect(reason).toContain('deployed from a repository');
      // It never claims the repository's file publishes nothing.
      expect(reason).not.toContain('publishes no');

      const refused = await addCheck({
        serviceType: 'compose',
        serviceId: composeId,
        kind: 'tcp',
        port: 6380,
      });
      expect(refused.status).toBe(400);
      expect((refused.body as { message: string }).message).toBe(reason);
    });

    it('refuses a keyword or a header on a TCP check', async () => {
      const postgresId = await database();
      await ctx.db
        .update(postgres)
        .set({ externalPort: 5432 })
        .where(eq(postgres.postgresId, postgresId));

      const res = await addCheck({
        serviceType: 'postgres',
        serviceId: postgresId,
        kind: 'tcp',
        port: 5432,
        keyword: KEYWORD,
      });

      expect(res.status).toBe(400);
    });
  });

  describe('the keyword', () => {
    it('reads a 200 without the keyword as down with keyword missing, and never names the keyword in a Notification', async () => {
      const applicationId = await application();
      const created = await addCheck({
        serviceType: 'application',
        serviceId: applicationId,
        domainId: await domainOf(applicationId),
        keyword: KEYWORD,
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ keyword: KEYWORD });

      await step('ok');
      expect(
        (await summary('application', applicationId)).checks[0],
      ).toMatchObject({ lastProbe: { verdict: 'up', errorClass: null } });

      await steps(3, 'no-keyword');
      expect(
        (await summary('application', applicationId)).checks[0],
      ).toMatchObject({
        lastProbe: { verdict: 'down', errorClass: 'keyword missing' },
      });
      const sent = postedTo();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain('keyword missing');
      expect(sent[0]).not.toContain(KEYWORD);
      expect(sent[0]).not.toContain('maintenance');
    });
  });

  describe('the header', () => {
    it('is sent to the target, stored encrypted, and never in any response or Notification after it is saved', async () => {
      const applicationId = await application();
      const created = await addCheck({
        serviceType: 'application',
        serviceId: applicationId,
        domainId: await domainOf(applicationId),
        headerName: 'Authorization',
        headerValue: HEADER_VALUE,
      });
      expect(created.status).toBe(201);
      const uptimeCheckId = (created.body as CheckView).uptimeCheckId;

      await step('ok');
      expect(receivedAuth).toEqual([HEADER_VALUE]);

      await steps(3, 'fail');
      const responses = [
        created.text,
        (await summary('application', applicationId)).text,
        (
          await request(httpServer)
            .get('/uptime-checks')
            .query({ serviceType: 'application', serviceId: applicationId })
            .set('Cookie', cookie)
        ).text,
        (
          await request(httpServer)
            .patch(`/uptime-checks/${uptimeCheckId}`)
            .set('Cookie', cookie)
            .send({ downAfter: 4 })
        ).text,
      ];
      for (const text of responses) {
        expect(text).not.toContain(HEADER_VALUE);
        expect(text).not.toContain('tok-7c1d9e0f');
        expect(JSON.parse(text)).toBeTruthy();
      }
      expect(created.body).toMatchObject({
        headerName: 'Authorization',
        hasHeaderValue: true,
      });
      expect(created.body).not.toHaveProperty('headerValue');

      const sent = postedTo();
      expect(sent).toHaveLength(1);
      expect(sent[0]).not.toContain('tok-7c1d9e0f');
      expect(sent[0]).not.toContain('Authorization');
      expect(sent[0]).not.toContain('maintenance');

      // At rest: ciphertext, never the value. Audit rows never carry it.
      const [raw] = (
        await ctx.db.execute<{ header_value: string }>(
          sql`select header_value from uptime_check where uptime_check_id = ${uptimeCheckId}`,
        )
      ).rows;
      expect(raw.header_value).not.toContain('tok-7c1d9e0f');
      expect(raw.header_value.length).toBeGreaterThan(0);
      expect(
        JSON.stringify(await ctx.db.select().from(auditLog)),
      ).not.toContain('tok-7c1d9e0f');
    });

    it('is replaced and removed without ever being shown', async () => {
      const applicationId = await application();
      const created = await addCheck({
        serviceType: 'application',
        serviceId: applicationId,
        domainId: await domainOf(applicationId),
        headerName: 'Authorization',
        headerValue: HEADER_VALUE,
      });
      const uptimeCheckId = (created.body as CheckView).uptimeCheckId;
      const patch = (body: Record<string, unknown>) =>
        request(httpServer)
          .patch(`/uptime-checks/${uptimeCheckId}`)
          .set('Cookie', cookie)
          .send(body);

      // An edit that leaves the value out keeps it.
      const kept = await patch({ intervalSeconds: 60 });
      expect(kept.body).toMatchObject({ hasHeaderValue: true });
      await step('ok');
      now += INTERVAL_MS;
      expect(receivedAuth).toEqual([HEADER_VALUE]);

      const replaced = await patch({ headerValue: ROTATED_VALUE });
      expect(replaced.status).toBe(200);
      expect(replaced.body).toMatchObject({
        headerName: 'Authorization',
        hasHeaderValue: true,
      });
      expect(replaced.text).not.toContain('tok-rotated');
      await step('ok');
      now += INTERVAL_MS;
      expect(receivedAuth).toEqual([HEADER_VALUE, ROTATED_VALUE]);

      const removed = await patch({ headerValue: null });
      expect(removed.status).toBe(200);
      expect(removed.body).toMatchObject({
        headerName: 'Authorization',
        hasHeaderValue: false,
      });
      await step('ok');
      now += INTERVAL_MS;
      // A name with no value sends no header at all.
      expect(receivedAuth).toEqual([HEADER_VALUE, ROTATED_VALUE, null]);

      const unnamed = await patch({ headerName: null });
      expect(unnamed.body).toMatchObject({
        headerName: null,
        hasHeaderValue: false,
      });
      const [row] = await ctx.db
        .select({
          headerName: uptimeCheck.headerName,
          headerValue: uptimeCheck.headerValue,
        })
        .from(uptimeCheck);
      expect(row).toEqual({ headerName: null, headerValue: null });

      // A value with no name to send it under is refused.
      const orphan = await patch({ headerValue: ROTATED_VALUE });
      expect(orphan.status).toBe(400);
      expect(orphan.text).not.toContain('tok-rotated');
    });
  });
});
