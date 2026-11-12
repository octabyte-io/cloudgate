import request from 'supertest';
import { App } from 'supertest/types';
import * as schema from '../../src/db/schema';
import { MonitoringService } from '../../src/monitoring/monitoring.service';
import { NotificationDispatcherService } from '../../src/notifications/dispatcher.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { defaultWebServerMetricsConfig } from '../../src/settings/settings.schema';
import { SettingsService } from '../../src/settings/settings.service';
import { signUpMember } from '../utils/test-auth';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * `GET /settings/web-server` is the one route on the `web_server_settings`
 * singleton that any authenticated user may call — every *write* to that row
 * takes instance authority (H-63, ADR-0013), and the read deliberately did not
 * move because a plain member's Monitoring screen reads the host's sampling
 * configuration off it.
 *
 * That row carried **two** secrets, and `stripSshPrivateKey` projected out one;
 * an earlier change has since dropped the SSH key's column, so the one left is this.
 * `metricsConfig.server.token` is a live shared credential: possession of it is
 * the *whole* of `POST /notifications/receive`'s authentication, and the
 * copy on this row authenticates `receiveServerThreshold`'s **instance-wide**
 * branch — `dispatch(null, …)`, which fans the alert out to every organization's
 * channels rather than one. So the leak was a full member → instance-wide alert
 * injection: read the singleton, present the token to an unauthenticated route,
 * write arbitrary text into every tenant's Slack.
 *
 * **This is the API-exposure half of the at-rest change, and that change's own
 * precedent says so** — encrypting the column protected a `pg_dump`, a replica
 * and a backup, and said outright that at-rest encryption is orthogonal to what
 * the API hands out. `metrics-config-at-rest.e2e-spec.ts` is the at-rest half and
 * asserts the token survives the round trip *into the row*; this file asserts it
 * never comes back out of it.
 *
 * **Why the attack is asserted over every string in the response rather than one
 * field.** A test that only asserts `metricsConfig.server.token === undefined`
 * passes against a projection that moved the value somewhere else in the body —
 * which is exactly the class of mistake `stripSshPrivateKey` made in the other
 * direction. So the member harvests every string the response contains and
 * presents each one to the receive route, and the dispatcher is asserted never to
 * have been reached. The positive control below presents the *real* token, taken
 * from the database, and proves the chain is live: without it the whole describe
 * would pass on a receive route that refused everybody.
 */
const TOKEN = 'instance-wide-metrics-token';

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** An `apiUpdateWebServerMonitoring`-shaped body for POST /admin/setup-monitoring. */
function setupBody(overrides: { token?: string | null; cpu?: number } = {}): {
  metricsConfig: Record<string, unknown>;
} {
  const server: Record<string, unknown> = {
    // Long enough that no interval this suite registers can fire inside it.
    refreshRate: 3600,
    port: 4500,
    urlCallback: 'http://cloudgate.example.com/api/notifications/receive',
    retentionDays: 3,
    cronJob: '0 0 * * *',
    thresholds: { cpu: overrides.cpu ?? 80, memory: 85 },
  };
  // `null` is this helper's "omit the key entirely", which is the console's
  // shape for "keep whatever token is stored".
  if (overrides.token !== null) server.token = overrides.token ?? TOKEN;
  return {
    metricsConfig: {
      server,
      containers: { refreshRate: 3600, services: { include: [], exclude: [] } },
    },
  };
}

/** The alert an external metrics agent posts when a threshold is breached. */
const alert = (token: string) => ({
  ServerType: 'Cloudgate',
  Type: 'CPU',
  Value: 99,
  Threshold: 80,
  Message: 'attacker-controlled alert text',
  Timestamp: '2026-09-07T12:00:00.000Z',
  Token: token,
});

/**
 * Every string anywhere in a JSON response — the shape the attack is asserted
 * over, so a projection that merely *relocated* the token cannot pass.
 */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(stringsIn);
  }
  return [];
}

describe('The web-server settings singleton never serves its secrets (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let settings: SettingsService;
  let monitoring: MonitoringService;

  const dispatcher = { dispatch: jest.fn() };
  const remoteExec = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
    execFileAsync: jest.fn(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: remoteExec },
        { provide: NotificationDispatcherService, useValue: dispatcher },
      ],
    });
    httpServer = ctx.app.getHttpServer() as App;
    settings = ctx.app.get(SettingsService);
    monitoring = ctx.app.get(MonitoringService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    jest.clearAllMocks();
  });

  afterEach(() => {
    monitoring.unregisterServer(null);
  });

  async function signUpOwner(): Promise<string> {
    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    return res.headers['set-cookie'];
  }

  /**
   * Seed the token **through the column rather than through the route**: the
   * write registers the host's collection intervals as a side effect, and the
   * disclosure this file is about does not depend on them existing.
   */
  async function storeToken(token: string): Promise<void> {
    await settings.updateWebServerSettings({
      metricsConfig: {
        ...defaultWebServerMetricsConfig,
        server: { ...defaultWebServerMetricsConfig.server, token },
      },
    });
  }

  const storedToken = async (): Promise<string> => {
    const [row] = await ctx.db.select().from(schema.webServerSettings);
    return row.metricsConfig.server.token;
  };

  describe('a plain member reading GET /settings/web-server', () => {
    it('is not handed the instance-wide metrics token, and is told a token is set', async () => {
      const ownerCookie = await signUpOwner();
      const member = await signUpMember(httpServer, ownerCookie);
      await storeToken(TOKEN);

      const res = await request(httpServer)
        .get('/settings/web-server')
        .set('Cookie', member.cookie);

      // The route stays open to a member — this is a projection, not a gate,
      // and the Monitoring screen's "is this host being sampled" switch is what
      // the member legitimately reads here.
      expect(res.status).toBe(200);
      const row = res.body as {
        metricsConfig: {
          server: Record<string, unknown>;
          containers: unknown;
        };
      };

      // The token is gone, and the one fact the switch needs stands where it
      // stood — ADR 0019's rule, applied at the depth this secret lives at.
      expect(row.metricsConfig.server).not.toHaveProperty('token');
      expect(row.metricsConfig.server.hasToken).toBe(true);
      // Everything else the screen reads off the config is untouched.
      expect(row.metricsConfig.server.retentionDays).toBe(
        defaultWebServerMetricsConfig.server.retentionDays,
      );
      expect(row.metricsConfig.containers).toEqual(
        defaultWebServerMetricsConfig.containers,
      );
      expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    });

    it('says no token is set on an instance nobody has set monitoring up on', async () => {
      const ownerCookie = await signUpOwner();
      const member = await signUpMember(httpServer, ownerCookie);

      const res = await request(httpServer)
        .get('/settings/web-server')
        .set('Cookie', member.cookie);

      expect(res.status).toBe(200);
      const server = (
        res.body as { metricsConfig: { server: Record<string, unknown> } }
      ).metricsConfig.server;
      // `defaultWebServerMetricsConfig` ships `token: ''`, which is what
      // "never set up" means to `MonitoringService.registerTarget` and to
      // `authenticatesMetricsAgent`. Empty must read as *false* and not
      // as "a token exists whose value we withheld".
      expect(server).not.toHaveProperty('token');
      expect(server.hasToken).toBe(false);
    });

    it('cannot turn the response into an instance-wide alert', async () => {
      const ownerCookie = await signUpOwner();
      const member = await signUpMember(httpServer, ownerCookie);
      await storeToken(TOKEN);

      const res = await request(httpServer)
        .get('/settings/web-server')
        .set('Cookie', member.cookie);
      expect(res.status).toBe(200);

      const harvested = stringsIn(res.body);
      // The premise: there *is* something to harvest, so an empty response
      // cannot be what makes this pass.
      expect(harvested.length).toBeGreaterThan(0);

      for (const candidate of harvested) {
        const attack = await request(httpServer)
          .post('/notifications/receive')
          .send(alert(candidate));
        expect(attack.status).toBe(400);
      }

      // The harm, asserted where it would land: `receiveServerThreshold`'s
      // Cloudgate branch dispatches with `organizationId: null`, which is every
      // organization's channels on the instance.
      expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('positive control: the real token does reach every organization', async () => {
      // Without this the describe above would pass against a receive route that
      // refused everybody, a broken dispatcher, or a token that was never
      // stored. This is the attack, run with the value the member could not get.
      await signUpOwner();
      await storeToken(TOKEN);

      const accepted = await request(httpServer)
        .post('/notifications/receive')
        .send(alert(TOKEN));

      expect(accepted.status).toBe(204);
      expect(dispatcher.dispatch).toHaveBeenCalledWith(null, {
        type: 'server-threshold',
        serverName: 'Cloudgate',
        metric: 'CPU',
        value: 99,
        threshold: 80,
        message: 'attacker-controlled alert text',
        timestamp: '2026-09-07T12:00:00.000Z',
      });
    });
  });

  describe('the setup modal round-trips without the value', () => {
    it('keeps the stored token when the write omits it', async () => {
      // This is what made a bare presence flag a *breaking* change rather than
      // a projection: `toMetricsConfig` re-submitted `stored.token` unchanged so
      // that saving a threshold tweak would not rotate a value an operator may
      // have configured an external agent with. The console can no longer read
      // that value, so the route keeps it — `updateSlackSchema.partial()` and
      // `defined()` are the same contract on the notification credentials.
      const ownerCookie = await signUpOwner();
      await storeToken(TOKEN);

      const res = await request(httpServer)
        .post('/admin/setup-monitoring')
        .set('Cookie', ownerCookie)
        .send(setupBody({ token: null, cpu: 55 }));

      expect(res.status).toBe(200);
      expect(await storedToken()).toBe(TOKEN);
      // The rest of the write landed, so "keep the token" is not "ignore the body".
      const [row] = await ctx.db.select().from(schema.webServerSettings);
      expect(row.metricsConfig.server.thresholds.cpu).toBe(55);
      // And the answer carries no more than the read does.
      expect(JSON.stringify(res.body)).not.toContain(TOKEN);
      expect(
        (res.body as { metricsConfig: { server: Record<string, unknown> } })
          .metricsConfig.server.hasToken,
      ).toBe(true);
    });

    it('sets a token on an instance that has none', async () => {
      const ownerCookie = await signUpOwner();

      const res = await request(httpServer)
        .post('/admin/setup-monitoring')
        .set('Cookie', ownerCookie)
        .send(setupBody({ token: 'first-token' }));

      expect(res.status).toBe(200);
      expect(await storedToken()).toBe('first-token');
    });

    it('rotates the token when the write sends a new one', async () => {
      const ownerCookie = await signUpOwner();
      await storeToken(TOKEN);

      const res = await request(httpServer)
        .post('/admin/setup-monitoring')
        .set('Cookie', ownerCookie)
        .send(setupBody({ token: 'rotated-token' }));

      expect(res.status).toBe(200);
      expect(await storedToken()).toBe('rotated-token');
    });

    it('stops collecting when the write sends an empty token', async () => {
      // `stopCollecting` in `metrics-config-spec.ts` is an explicit `''`, and it
      // has to stay distinguishable from an omitted key: one clears the switch,
      // the other keeps it.
      const ownerCookie = await signUpOwner();
      await storeToken(TOKEN);

      const res = await request(httpServer)
        .post('/admin/setup-monitoring')
        .set('Cookie', ownerCookie)
        .send(setupBody({ token: '' }));

      expect(res.status).toBe(200);
      expect(await storedToken()).toBe('');
      expect(
        (res.body as { metricsConfig: { server: Record<string, unknown> } })
          .metricsConfig.server.hasToken,
      ).toBe(false);
      // The switch really is off: an agent still holding the old token is
      // refused, which is what "stop collecting" has to mean.
      const attack = await request(httpServer)
        .post('/notifications/receive')
        .send(alert(TOKEN));
      expect(attack.status).toBe(400);
    });
  });
});
