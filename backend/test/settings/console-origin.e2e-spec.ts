import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import * as schema from '../../src/db/schema';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import type { FileConfig } from '../../src/traefik/config/file-types';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * Saving a console domain says whether anybody will be able to sign in on it.
 *
 * The Console domain form wrote the routers, Traefik obtained a real
 * certificate, the toast said "saved" — and every request from the new origin
 * was refused `403 INVALID_ORIGIN`, because better-auth trusts only
 * `BETTER_AUTH_URL`'s origin, `TRUSTED_ORIGINS` and the owners' runtime
 * allowlist, and `deploy/install.sh` leaves the second empty on purpose. So the
 * settings row now carries `consoleOrigin`: the origin a browser on the console
 * domain sends, and whether it is trusted *now*.
 *
 * **Every flag is checked against the gate it predicts.** A flag computed beside
 * better-auth rather than by it is the thing that drifts, so each case below
 * also signs in from that origin for real and expects the answer the flag gave.
 * That is also what holds `isOriginTrustedNow` to the per-request list: the
 * runtime-allowlist cases write the owner's row after boot, which a flag read
 * off better-auth's boot-time context would miss.
 */

/** The console's own origin — trusted for free, and not the console domain. */
const BASE_ORIGIN = 'http://203.0.113.10:3000';
/** Named by the backend's environment, the way a second dashboard is. */
const LISTED_HOST = 'listed.example.com';
/** Named by nothing until an owner allowlists it. */
const CONSOLE_HOST = 'console.example.com';

// Set before createTestApp requires AppModule — ConfigModule snapshots the env
// on that first import, and the snapshot is what both AuthModule and
// SettingsService read.
process.env.BETTER_AUTH_URL = BASE_ORIGIN;
process.env.TRUSTED_ORIGINS = `https://${LISTED_HOST}`;
// better-auth skips the origin check entirely under NODE_ENV=test, so the
// sign-ins below would answer 200 to every origin and prove nothing. The same
// arrangement as `test/auth/trusted-origins.e2e-spec.ts`, restored in afterAll.
const nodeEnvBefore = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** The field under test, off a settings response. */
const consoleOrigin = (res: { body: unknown }): unknown =>
  (res.body as { consoleOrigin?: unknown }).consoleOrigin;

const ok = (stdout: string): ExecResult => ({
  stdout,
  stderr: '',
  exitCode: 0,
});

describe('Console origin (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let cookie: string;

  // No Traefik to ask, so the save's router check answers `unavailable` at
  // once rather than dialling the machine running the suite.
  const remoteExec = withArgvExec({
    execAsync: jest.fn<Promise<ExecResult>, [string]>(() =>
      Promise.resolve(ok('')),
    ),
    execAsyncRemote: jest.fn<Promise<ExecResult>, [string, string]>(() =>
      Promise.resolve(ok('')),
    ),
  });

  // The routers are another suite's business; this suite is about the row.
  const traefikWriter = {
    loadOrCreateConfig: jest.fn<Promise<FileConfig>, [string]>(() =>
      Promise.resolve({ http: { routers: {}, services: {} } }),
    ),
    writeConfig: jest.fn<Promise<void>, [string, FileConfig]>(() =>
      Promise.resolve(),
    ),
    removeConfig: jest.fn<Promise<void>, [string]>(() => Promise.resolve()),
  };

  /** A credentialed sign-in, the browser case better-auth checks the origin of. */
  const signInFrom = (origin: string) =>
    request(server)
      .post('/api/auth/sign-in/email')
      .set('Origin', origin)
      .set('Cookie', 'cloudgate.probe=1')
      .send({ email: owner.email, password: owner.password });

  const assign = (host: string, https: boolean) =>
    request(server)
      .post('/settings/assign-domain')
      .set('Cookie', cookie)
      .send({ host, https, certificateType: https ? 'custom' : 'none' });

  const readRow = () =>
    request(server).get('/settings/web-server').set('Cookie', cookie);

  const allowlist = (origins: string[]) =>
    ctx.db
      .update(schema.user)
      .set({ trustedOrigins: origins })
      .where(eq(schema.user.email, owner.email));

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: remoteExec },
        { provide: TraefikWriterService, useValue: traefikWriter },
      ],
    });
    server = ctx.app.getHttpServer() as App;
    const res = await request(server)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    cookie = res.headers['set-cookie'];
  });

  afterEach(async () => {
    await allowlist([]);
  });

  afterAll(async () => {
    await ctx.teardown();
    if (nodeEnvBefore === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnvBefore;
  });

  it('answers a console domain no list names as untrusted, and sign-in there is refused', async () => {
    const saved = await assign(CONSOLE_HOST, true);

    expect(saved.status).toBe(200);
    expect(consoleOrigin(saved)).toEqual({
      origin: 'https://console.example.com',
      trusted: false,
    });
    // The read the Console routing card renders from says the same thing.
    expect(consoleOrigin(await readRow())).toEqual({
      origin: 'https://console.example.com',
      trusted: false,
    });

    const signIn = await signInFrom('https://console.example.com');
    expect(signIn.status).toBe(403);
    expect(signIn.body).toMatchObject({ code: 'INVALID_ORIGIN' });
  });

  it('answers a console domain TRUSTED_ORIGINS names as trusted, and sign-in there works', async () => {
    const saved = await assign(LISTED_HOST, true);

    expect(consoleOrigin(saved)).toEqual({
      origin: 'https://listed.example.com',
      trusted: true,
    });
    expect((await signInFrom('https://listed.example.com')).status).toBe(200);
  });

  it('reads the scheme the console domain is served on, so the plain-HTTP origin of a listed host is untrusted', async () => {
    const saved = await assign(LISTED_HOST, false);

    expect(consoleOrigin(saved)).toEqual({
      origin: 'http://listed.example.com',
      trusted: false,
    });
    expect((await signInFrom('http://listed.example.com')).status).toBe(403);
  });

  it('turns trusted once an owner allowlists the origin, without a restart', async () => {
    await assign(CONSOLE_HOST, true);
    await allowlist(['https://console.example.com']);

    expect(consoleOrigin(await readRow())).toEqual({
      origin: 'https://console.example.com',
      trusted: true,
    });
    expect((await signInFrom('https://console.example.com')).status).toBe(200);
  });

  it("matches an owner's wildcard the way better-auth does", async () => {
    await assign(CONSOLE_HOST, true);
    await allowlist(['https://*.example.com']);

    expect(consoleOrigin(await readRow())).toEqual({
      origin: 'https://console.example.com',
      trusted: true,
    });
    expect((await signInFrom('https://console.example.com')).status).toBe(200);
  });

  it('answers null when no console domain is set', async () => {
    const saved = await assign('', false);

    expect(saved.status).toBe(200);
    expect(consoleOrigin(saved)).toBeNull();
    expect(consoleOrigin(await readRow())).toBeNull();
  });
});
