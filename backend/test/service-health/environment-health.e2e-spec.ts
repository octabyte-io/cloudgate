import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  application,
  licenseKey,
  member,
  organizationRole,
} from '../../src/db/schema';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ServiceHealthRow } from '../../src/service-health/environment-health.service';
import { ProbeScheduler } from '../../src/service-health/probe-scheduler.service';
import { PROBE_TARGET } from '../../src/service-health/probe-target.port';
import { SERVICE_HEALTH_CLOCK } from '../../src/service-health/service-health.clock';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { secondOrganizationOwner, signUpMember } from '../utils/test-auth';

jest.setTimeout(120_000);

/**
 * `GET /environments/:id/health` (spec slice 5): the Services
 * table's Health column in one request — each Service's open-Incident flag and
 * worst current state — answered only about the Services the caller is
 * entitled to, by the same scope as the Environment read's `services`.
 *
 * The states are reached the way an operator reaches them: real Probes against
 * a stub whose answer depends on the Domain's path (`/fail…` answers 503),
 * a clock that stands still and a direct `ProbeScheduler.tick`, as the Uptime
 * suite does. Only a Stop is written straight to the row, because what is
 * under test is how a Stopped Service reads, not how it gets Stopped.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const INTERVAL_MS = 30_000;

describe('Environment health (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let scheduler: ProbeScheduler;

  let stub: Server;
  let stubPort = 0;
  let now = Date.parse('2026-09-25T10:00:00.000Z');
  const clock = { now: () => now };

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

  beforeAll(async () => {
    stub = createServer((req, res) => {
      res.statusCode = req.url?.startsWith('/fail') ? 503 : 200;
      res.end();
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
  let environmentId: string;
  let hosts = 0;

  beforeEach(async () => {
    await ctx.resetDb();
    execMock.execAsync.mockReset().mockResolvedValue(ok);
    execMock.execAsyncRemote.mockReset().mockResolvedValue(ok);
    traefikWriterMock.loadOrCreateConfig
      .mockReset()
      .mockResolvedValue({ http: { routers: {}, services: {} } });
    traefikWriterMock.writeConfig.mockReset().mockResolvedValue(undefined);

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
    expect(project.status).toBe(201);
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

  async function tick(times = 1): Promise<void> {
    for (let i = 0; i < times; i++) {
      now += INTERVAL_MS;
      await scheduler.tick();
    }
  }

  async function addApplication(name: string): Promise<string> {
    const res = await request(httpServer)
      .post('/applications')
      .set('Cookie', ownerCookie)
      .send({ name, appName: `shop-${name}`, environmentId });
    expect(res.status).toBe(201);
    return (res.body as { applicationId: string }).applicationId;
  }

  /** A Domain on `path` and an HTTP check on it; `/fail…` answers 503. */
  async function watch(
    applicationId: string,
    path: string,
    rule: { downAfter?: number; enabled?: boolean } = {},
  ): Promise<string> {
    const domain = await request(httpServer)
      .post('/domains')
      .set('Cookie', ownerCookie)
      .send({
        host: `site-${(hosts += 1)}.example.com`,
        path,
        applicationId,
        https: false,
      });
    expect(domain.status).toBe(201);
    const check = await request(httpServer)
      .post('/uptime-checks')
      .set('Cookie', ownerCookie)
      .send({
        serviceType: 'application',
        serviceId: applicationId,
        domainId: (domain.body as { domainId: string }).domainId,
        intervalSeconds: 30,
        timeoutSeconds: 2,
        downAfter: rule.downAfter ?? 3,
        enabled: rule.enabled ?? true,
      });
    expect(check.status).toBe(201);
    return (check.body as { uptimeCheckId: string }).uptimeCheckId;
  }

  function environmentHealth(cookie = ownerCookie) {
    return request(httpServer)
      .get(`/environments/${environmentId}/health`)
      .set('Cookie', cookie);
  }

  function rowsOf(body: unknown): ServiceHealthRow[] {
    return (body as { services: ServiceHealthRow[] }).services;
  }

  it('answers every Service with its open-Incident flag and worst current state', async () => {
    const failing = await addApplication('failing');
    const flaky = await addApplication('flaky');
    const fine = await addApplication('fine');
    const stopped = await addApplication('stopped');
    const off = await addApplication('off');
    const bare = await addApplication('bare');
    await watch(failing, '/fail');
    await watch(flaky, '/fail', { downAfter: 5 });
    await watch(fine, '/ok');
    await watch(stopped, '/ok');
    await watch(off, '/fail', { enabled: false });

    // Three downs: `failing` (down after 3) opens an Incident, `flaky` (down
    // after 5) has only been down. `fine` and `stopped` are up.
    await tick(3);
    const openedAt = new Date(now).toISOString();
    await ctx.db
      .update(application)
      .set({ applicationStatus: 'stopped' })
      .where(eq(application.applicationId, stopped));
    // Added after the ticks, so it has not been probed yet — and a Service
    // with one up and one unprobed check cannot yet claim to be up.
    const late = await addApplication('late');
    await watch(late, '/ok');
    await watch(fine, '/ok-too');

    const res = await environmentHealth();

    expect(res.status).toBe(200);
    expect((res.body as { environmentId: string }).environmentId).toBe(
      environmentId,
    );
    const byId = new Map(rowsOf(res.body).map((row) => [row.serviceId, row]));
    expect(byId.size).toBe(7);
    expect(byId.get(failing)).toEqual({
      serviceType: 'application',
      serviceId: failing,
      state: 'incident',
      openIncident: true,
      openIncidents: 1,
      openSince: openedAt,
    });
    const quiet = { openIncident: false, openIncidents: 0, openSince: null };
    expect(byId.get(flaky)).toMatchObject({ state: 'down', ...quiet });
    expect(byId.get(fine)).toMatchObject({ state: 'pending', ...quiet });
    expect(byId.get(late)).toMatchObject({ state: 'pending', ...quiet });
    // Its last verdict was up, but a Stopped Service is not probed.
    expect(byId.get(stopped)).toMatchObject({ state: 'unchecked', ...quiet });
    // A check turned off watches nothing, whatever it would answer.
    expect(byId.get(off)).toMatchObject({ state: 'unchecked', ...quiet });
    expect(byId.get(bare)).toMatchObject({ state: 'unchecked', ...quiet });

    // The Overview's fact line reads the one Service's own summary, and it
    // says what the column says, by the same rule.
    for (const [serviceId, row] of byId) {
      const summary = await request(httpServer)
        .get(`/service-health/application/${serviceId}`)
        .set('Cookie', ownerCookie);
      expect(summary.status).toBe(200);
      expect((summary.body as { state: string }).state).toBe(row.state);
    }

    // Once every check has been probed, `fine` reads up; `failing` recovers
    // only when its stub does, so it stays the worst.
    await tick();
    const after = new Map(
      rowsOf((await environmentHealth()).body).map((row) => [
        row.serviceId,
        row.state,
      ]),
    );
    expect(after.get(fine)).toBe('up');
    expect(after.get(late)).toBe('up');
    expect(after.get(failing)).toBe('incident');
  });

  it('answers a Member only the Services they are entitled to', async () => {
    const theirs = await addApplication('theirs');
    const hidden = await addApplication('hidden');
    await watch(theirs, '/ok');
    await watch(hidden, '/fail');
    await tick(3);

    const ida = await signUpMember(httpServer, ownerCookie);
    // The Environment and nothing in it: the read answers, and names nothing.
    await ctx.db
      .update(member)
      .set({ accessedEnvironments: [environmentId], accessedServices: [] })
      .where(eq(member.userId, ida.id));
    const none = await environmentHealth(ida.cookie);
    expect(none.status).toBe(200);
    expect(rowsOf(none.body)).toEqual([]);

    await ctx.db
      .update(member)
      .set({ accessedServices: [theirs] })
      .where(eq(member.userId, ida.id));
    const one = await environmentHealth(ida.cookie);

    expect(one.status).toBe(200);
    expect(rowsOf(one.body)).toEqual([
      expect.objectContaining({ serviceId: theirs, state: 'up' }),
    ]);
    // Not even the other Service's id, let alone that it is failing.
    expect(JSON.stringify(one.body)).not.toContain(hidden);
  });

  it('refuses a Member without the Environment, and a role without service read', async () => {
    const app = await addApplication('web');
    const ida = await signUpMember(httpServer, ownerCookie);
    await ctx.db
      .update(member)
      .set({ accessedServices: [app] })
      .where(eq(member.userId, ida.id));
    expect((await environmentHealth(ida.cookie)).status).toBe(403);

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
      role: 'no-service',
      permission: { environment: ['read'] },
    });
    await ctx.db
      .update(member)
      .set({
        role: 'no-service',
        accessedEnvironments: [environmentId],
        accessedServices: [app],
      })
      .where(
        and(
          eq(member.userId, ida.id),
          eq(member.organizationId, row.organizationId),
        ),
      );
    expect((await environmentHealth(ida.cookie)).status).toBe(403);
  });

  it("reads another Organization's Environment as not found", async () => {
    await watch(await addApplication('web'), '/ok');
    const mallory = await secondOrganizationOwner(
      httpServer,
      ctx.db,
      ownerCookie,
    );

    const res = await environmentHealth(mallory.cookie);

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('application');
  });
});
