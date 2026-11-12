// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first load.
import { useHostedMode } from '../utils/hosted-mode';
useHostedMode();

import request from 'supertest';
import { App } from 'supertest/types';
import { HOSTED_STAFF, openHostedSignUp } from '../utils/hosted-sign-up';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * The session cookie on the Hosted instance is `Secure`: it is served
 * on HTTPS alone, and a cookie a browser would also send over plain HTTP is one
 * anybody on the path can read. Its self-hosted counterpart, where a stock
 * install is plain HTTP and the cookie is not Secure, is
 * `session-cookie.e2e-spec.ts`.
 */
describe('The session cookie on the Hosted instance (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    await openHostedSignUp(ctx.db);
  });

  async function signIn(): Promise<string[]> {
    const res = await request(server)
      .post('/api/auth/sign-in/email')
      .send({ email: HOSTED_STAFF.email, password: HOSTED_STAFF.password });
    expect(res.status).toBe(200);
    return res.headers['set-cookie'] as unknown as string[];
  }

  it('is Secure, under the __Secure- name', async () => {
    const cookies = await signIn();
    const session = cookies.find((c) =>
      c.startsWith('__Secure-better-auth.session_token='),
    );

    expect(session).toBeDefined();
    expect(session!.split(';').map((part) => part.trim())).toEqual(
      expect.arrayContaining(['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/']),
    );
    // Nothing goes out without the attribute.
    for (const cookie of cookies) expect(cookie).toMatch(/;\s*Secure(;|$)/);
  });

  it('is the cookie the session is read back from', async () => {
    const cookie = (await signIn()).map((c) => c.split(';')[0]).join('; ');

    const res = await request(server)
      .get('/api/auth/get-session')
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect((res.body as { user?: { email?: string } }).user?.email).toBe(
      HOSTED_STAFF.email,
    );
  });
});
