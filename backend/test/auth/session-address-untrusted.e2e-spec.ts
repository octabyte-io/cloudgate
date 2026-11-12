import { desc } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { session } from '../../src/auth/auth.schema';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * The shipped default: nothing in front, so nothing a caller says about their
 * own address is believed.
 *
 * The sibling of `session-address.e2e-spec.ts`, which is the same question asked
 * of an instance that *does* trust a hop. Two files rather than two blocks
 * because `TRUST_PROXY` is read when the app boots — `ConfigModule.forRoot`
 * snapshots the environment on AppModule's first import, and `AuthController`
 * reads the flag once in its constructor — so one app cannot answer both. The
 * unit-level pair lives together in `forwarded-address.spec.ts`, which is the
 * seam where one of the two rules would actually get simplified away.
 *
 * **`NODE_ENV` is `production`, and that is what makes this able to fail.**
 * `getIp` ends `if (isTest() || isDevelopment()) return "127.0.0.1"`
 * (`@better-auth/core` `dist/utils/ip.mjs:215`), which is also the address
 * supertest connects from — so under jest's own `NODE_ENV=test` a spoofed header
 * and a refused one are indistinguishable. Set before `createTestApp` requires
 * AppModule, because `@better-auth/core` snapshots `NODE_ENV` on first import.
 */
const nodeEnvBefore = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';
const trustProxyBefore = process.env.TRUST_PROXY;
delete process.env.TRUST_PROXY;

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** The address supertest really connects from, as better-auth normalizes it. */
const LOOPBACK = '127.0.0.1';
/** An address a caller might prefer to be recorded as. */
const CLAIMED = '1.2.3.4';

describe('Session address with no trusted proxy (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;

  beforeAll(async () => {
    ctx = await createTestApp();
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
    if (nodeEnvBefore === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnvBefore;
    if (trustProxyBefore === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = trustProxyBefore;
  });

  beforeEach(async () => {
    await ctx.resetDb();
  });

  /** The address on the session that was written last. */
  async function newestSessionAddress(): Promise<string | null> {
    const [row] = await ctx.db
      .select()
      .from(session)
      .orderBy(desc(session.createdAt))
      .limit(1);
    expect(row).toBeDefined();
    return row.ipAddress;
  }

  it('records the caller address on a session created without a forwarded header', async () => {
    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);

    expect(await newestSessionAddress()).toBe(LOOPBACK);
  });

  /**
   * The hole this closed. better-auth believes a single-entry `x-forwarded-for`
   * when no proxy is named (`ip.mjs:188-191`), so on the configuration almost
   * every install runs, any caller could choose the address recorded against
   * their session and against the login entry in the audit trail. An audit
   * column that lies is worse than one that is blank.
   */
  it('refuses a caller their own claimed address, recording the socket peer', async () => {
    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .set('x-forwarded-for', CLAIMED)
      .send(owner);
    expect(res.status).toBe(200);

    const recorded = await newestSessionAddress();
    expect(recorded).toBe(LOOPBACK);
    expect(recorded).not.toBe(CLAIMED);
  });

  it('refuses a whole claimed chain the same way', async () => {
    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .set('x-forwarded-for', `${CLAIMED}, 5.6.7.8`)
      .send(owner);
    expect(res.status).toBe(200);

    expect(await newestSessionAddress()).toBe(LOOPBACK);
  });
});
