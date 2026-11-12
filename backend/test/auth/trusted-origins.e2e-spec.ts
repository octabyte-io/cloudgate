import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import * as schema from '../../src/db/schema';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/** The origin better-auth generates its links against — trusted on its own. */
const BASE_ORIGIN = 'http://dashboard.cloudgate.test';
/** A second dashboard origin, reachable only through TRUSTED_ORIGINS. */
const CONFIGURED_ORIGIN = 'http://console.cloudgate.test';
/** A third, on a non-default port, to prove the port survives the parse. */
const CONFIGURED_PORT_ORIGIN = 'http://ops.cloudgate.test:8443';
/** Added at runtime by an owner, the way an IdP's origin is (SsoService). */
const RUNTIME_ORIGIN = 'https://idp.cloudgate.test';
const STRANGER_ORIGIN = 'http://stranger.cloudgate.test';

// Set before createTestApp requires AppModule: ConfigModule.forRoot({ validate })
// snapshots the environment on that first import, and the snapshot — not
// process.env — is what AuthModule reads.
process.env.BETTER_AUTH_URL = BASE_ORIGIN;
process.env.TRUSTED_ORIGINS = ` ${CONFIGURED_ORIGIN}, ${CONFIGURED_PORT_ORIGIN} `;
// better-auth skips the origin check entirely when NODE_ENV is `test`
// (`skipOriginCheck` defaults to `isTest()`), so an app booted the usual way
// answers 200 to every origin and every assertion below would pass while
// proving nothing. This spec is the one place that has to run the check the way
// a real instance does. Restored in afterAll; `advanced.disableOriginCheck` is
// deliberately left alone, since turning the check on for the whole test suite
// would make every credentialed request without an `Origin` fail instead.
const nodeEnvBefore = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';

const credentials = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/**
 * better-auth only checks the origin of a *credentialed* request — the
 * browser case, where the session cookie rides along — so the probe carries a
 * cookie header the way a signed-in dashboard would.
 */
function signIn(server: App, origin: string) {
  return request(server)
    .post('/api/auth/sign-in/email')
    .set('Origin', origin)
    .set('Cookie', 'cloudgate.probe=1')
    .send({ email: credentials.email, password: credentials.password });
}

describe('Trusted origins (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as App;
    await request(server).post('/api/auth/sign-up/email').send(credentials);
  });

  afterAll(async () => {
    await ctx.teardown();
    if (nodeEnvBefore === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnvBefore;
  });

  it('refuses a sign-in from an origin no list names', async () => {
    const res = await signIn(server, STRANGER_ORIGIN);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'INVALID_ORIGIN' });
  });

  it('signs in from an origin TRUSTED_ORIGINS names', async () => {
    const res = await signIn(server, CONFIGURED_ORIGIN);

    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('signs in from a second configured origin, port and all', async () => {
    const res = await signIn(server, CONFIGURED_PORT_ORIGIN);

    expect(res.status).toBe(200);
  });

  it("still trusts BETTER_AUTH_URL's own origin, which needs no list", async () => {
    const res = await signIn(server, BASE_ORIGIN);

    expect(res.status).toBe(200);
  });

  describe('once an owner allowlists an origin at runtime', () => {
    // What POST /sso/trusted-origins writes (SsoService), reached directly
    // because that route is behind the enterprise licence — the whole point of
    // being that a dashboard cannot depend on it.
    beforeAll(async () => {
      await ctx.db
        .update(schema.user)
        .set({ trustedOrigins: [RUNTIME_ORIGIN] })
        .where(eq(schema.user.email, credentials.email));
    });

    afterAll(async () => {
      await ctx.db
        .update(schema.user)
        .set({ trustedOrigins: [] })
        .where(eq(schema.user.email, credentials.email));
    });

    it('signs in from that origin without a restart', async () => {
      const res = await signIn(server, RUNTIME_ORIGIN);

      expect(res.status).toBe(200);
    });

    it('goes on trusting the configured ones alongside it', async () => {
      const res = await signIn(server, CONFIGURED_ORIGIN);

      expect(res.status).toBe(200);
    });

    it('trusts no origin that neither list names', async () => {
      const res = await signIn(server, STRANGER_ORIGIN);

      expect(res.status).toBe(403);
    });
  });
});
