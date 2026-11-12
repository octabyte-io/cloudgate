import request from 'supertest';
import { App } from 'supertest/types';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { SettingsService } from '../../src/settings/settings.service';
import { signUpMember } from '../utils/test-auth';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

async function signUp(
  httpServer: App,
  body: { name: string; email: string; password: string },
): Promise<{ cookie: string; id: string }> {
  const res = await request(httpServer)
    .post('/api/auth/sign-up/email')
    .send(body);
  expect(res.status).toBe(200);
  const { user } = res.body as { user: { id: string } };
  return { cookie: res.headers['set-cookie'], id: user.id };
}

/**
 * `PermissionService.checkInstanceAuthority`'s refusal, written out.
 *
 * `setupMonitoring` writes the **platform host's** `metricsConfig` on the
 * `web_server_settings` singleton, so since H-63 it asks whether the caller
 * administers this instance rather than what their role is in whichever
 * organization they are acting in. A plain member fails either gate; which
 * sentence comes back is what says *which question was asked*.
 */
const INSTANCE_AUTHORITY_REFUSAL =
  'Only an owner or admin of the instance organization can configure the platform host';

/** The message an `AllExceptionsFilter` response carries. */
const refusal = (res: { body: unknown }): string =>
  (res.body as { message: string }).message;

const metricsConfig = {
  server: {
    refreshRate: 30,
    port: 4500,
    token: 'web-metrics-token',
    urlCallback: 'http://cloudgate.example.com/api/notifications/receive',
    retentionDays: 3,
    cronJob: '0 0 * * *',
    thresholds: { cpu: 80, memory: 85 },
  },
  containers: {
    refreshRate: 45,
    services: { include: ['web'], exclude: [] },
  },
};

describe('Admin (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;

  const remoteExec = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
    execFileAsync: jest.fn(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: remoteExec }],
    });
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    jest.clearAllMocks();
  });

  it('persists the web-server metricsConfig with type Cloudgate and returns the settings', async () => {
    const session = await signUp(httpServer, owner);

    const res = await request(httpServer)
      .post('/admin/setup-monitoring')
      .set('Cookie', session.cookie)
      .send({ metricsConfig });

    expect(res.status).toBe(200);
    const body = res.body as {
      metricsConfig: {
        server: {
          type: string;
          token?: string;
          hasToken?: boolean;
          thresholds: { cpu: number };
        };
        containers: { refreshRate: number; services: { include: string[] } };
      };
    };
    expect(body.metricsConfig.server.type).toBe('Cloudgate');
    expect(body.metricsConfig.server.thresholds.cpu).toBe(80);
    expect(body.metricsConfig.containers.refreshRate).toBe(45);
    expect(body.metricsConfig.containers.services.include).toEqual(['web']);

    // **The token is persisted but not returned**, and this assertion used to be
    // the other way round. `metricsConfig.server.token` is a live shared secret
    // — possession of it is the whole of `POST /notifications/receive`'s
    // authentication, and *this* copy authenticates the instance-wide branch, so
    // one forged alert reaches every organization's channels. It is projected
    // out of every response the singleton appears in, including this one:
    // there is no caller it is safe to echo it back to, and no screen that reads
    // anything but the flag. `test/settings/web-server-secrets.e2e-spec.ts`
    // carries the whole argument and the read side of it.
    expect(body.metricsConfig.server).not.toHaveProperty('token');
    expect(body.metricsConfig.server.hasToken).toBe(true);
    expect(res.text).not.toContain('web-metrics-token');
    // Persisted, through the internal getter that is allowed to see it.
    const stored = await ctx.app.get(SettingsService).getWebServerSettings();
    expect(stored.metricsConfig.server.token).toBe('web-metrics-token');
  });

  it('rejects refresh rates under 2', async () => {
    const session = await signUp(httpServer, owner);

    const res = await request(httpServer)
      .post('/admin/setup-monitoring')
      .set('Cookie', session.cookie)
      .send({
        metricsConfig: {
          ...metricsConfig,
          server: { ...metricsConfig.server, refreshRate: 1 },
        },
      });
    expect(res.status).toBe(400);
  });

  // The third instance of an earlier leak's shape: setupMonitoring answered
  // with the unprojected webServerSettings row, and the instance's SSH key —
  // an encryptedText column that decrypted on read — rode the response body.
  // That column has since been dropped; what the row still carries is the metrics agent
  // token this very route writes, and it must not come back even to the caller
  // who just sent it.
  it('POST /admin/setup-monitoring never carries the metrics agent token', async () => {
    const session = await signUp(httpServer, owner);

    const res = await request(httpServer)
      .post('/admin/setup-monitoring')
      .set('Cookie', session.cookie)
      .send({ metricsConfig });

    expect(res.status).toBe(200);
    const body = res.body as {
      metricsConfig: { server: Record<string, unknown> };
    } & Record<string, unknown>;
    expect(body.metricsConfig.server).not.toHaveProperty('token');
    expect(res.text).not.toContain(metricsConfig.server.token);
    expect(body.metricsConfig.server.hasToken).toBe(true);
    // Nor the key the row no longer has, nor its flag.
    expect(body).not.toHaveProperty('sshPrivateKey');
    expect(body).not.toHaveProperty('hasSshPrivateKey');
    // The rest of the row still answers the caller's write.
    expect(body.id).toBeTruthy();
  });

  // The other half of the earlier fix: the projection is the controller's,
  // not the store's. The internal getter must keep handing the token over after
  // setup-monitoring has written the singleton — `setupMonitoring` itself reads
  // it back that way to keep a token a later write omits.
  it('the internal getter still hands the metrics agent token to internal callers', async () => {
    const session = await signUp(httpServer, owner);

    const res = await request(httpServer)
      .post('/admin/setup-monitoring')
      .set('Cookie', session.cookie)
      .send({ metricsConfig });
    expect(res.status).toBe(200);

    const settings = ctx.app.get(SettingsService);
    const row = await settings.getWebServerSettings();
    expect(row.metricsConfig?.server.token).toBe('web-metrics-token');
  });

  it('denies non-admin members', async () => {
    const session = await signUp(httpServer, owner);
    const memberSession = await signUpMember(httpServer, session.cookie);

    const res = await request(httpServer)
      .post('/admin/setup-monitoring')
      .set('Cookie', memberSession.cookie)
      .send({ metricsConfig });
    // The message, not the bare 403: an unaccepted member's `toCtx` refusal
    // carries 'No active organization' and would pass with
    // `requireOwnerOrAdmin` deleted from the service.
    expect([res.status, refusal(res)]).toEqual([
      403,
      INSTANCE_AUTHORITY_REFUSAL,
    ]);
  });
});
