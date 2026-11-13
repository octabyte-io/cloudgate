import request from 'supertest';
import { App } from 'supertest/types';

import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * Signing out clears the session cookies of the *other* Instance mode too.
 *
 * Hosted names its cookies `__Secure-better-auth.*` (`useSecureCookies`),
 * Self-hosted `better-auth.*`. After `set-instance-mode --mode self-hosted`,
 * a browser signed in on Hosted still holds `__Secure-better-auth.session_token`:
 * the console's gate (`src/proxy.ts`, `getSessionCookie`) accepts either name,
 * so it saw a session, but this Instance read none, and its sign-out cleared
 * only its own spelling. The dead-session exit's sign-out then left the cookie
 * the gate bounced on, and the console looped on a blank page (#32).
 *
 * This Instance is Self-hosted, the test app's default.
 */
describe('Sign-out after an Instance mode switch (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  /** The Set-Cookie line that names `name`, if any. */
  const setCookieFor = (headers: Record<string, unknown>, name: string) =>
    ((headers['set-cookie'] as string[] | undefined) ?? []).find((line) =>
      line.startsWith(`${name}=`),
    );

  it('expires the Hosted spelling of the session cookies a browser still holds', async () => {
    const res = await request(server)
      .post('/api/auth/sign-out')
      .set(
        'Cookie',
        '__Secure-better-auth.session_token=stale.signed; __Secure-better-auth.session_data=stale',
      )
      .send({});

    expect(res.status).toBe(200);
    for (const name of [
      '__Secure-better-auth.session_token',
      '__Secure-better-auth.session_data',
    ]) {
      const line = setCookieFor(res.headers, name);
      expect(line).toBeDefined();
      expect(line).toMatch(/Max-Age=0/i);
      // A `__Secure-` cookie is only accepted, and so only cleared, with Secure.
      expect(line).toMatch(/;\s*Secure/i);
      expect(line).toMatch(/Path=\//i);
    }
  });

  it("leaves the Set-Cookie of a browser holding only this mode's cookies as it was", async () => {
    const res = await request(server)
      .post('/api/auth/sign-out')
      .set('Cookie', 'better-auth.session_token=stale.signed')
      .send({});

    expect(res.status).toBe(200);
    expect(
      setCookieFor(res.headers, '__Secure-better-auth.session_token'),
    ).toBeUndefined();
  });
});
