import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * The session cookie on a Self-hosted instance is not `Secure`: a
 * stock install is plain HTTP on :3000, where a browser would never send a
 * Secure cookie back. The Hosted instance's, which is, is
 * `session-cookie-hosted.e2e-spec.ts`.
 */
describe('The session cookie on a Self-hosted instance (e2e)', () => {
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
  });

  it('is not Secure, under the plain name', async () => {
    const owner = {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
    };
    expect(
      (await request(server).post('/api/auth/sign-up/email').send(owner))
        .status,
    ).toBe(200);

    const res = await request(server)
      .post('/api/auth/sign-in/email')
      .send({ email: owner.email, password: owner.password });

    expect(res.status).toBe(200);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    const session = cookies.find((c) =>
      c.startsWith('better-auth.session_token='),
    );
    expect(session).toBeDefined();
    expect(session!.split(';').map((part) => part.trim())).toEqual(
      expect.arrayContaining(['HttpOnly', 'SameSite=Lax', 'Path=/']),
    );
    for (const cookie of cookies)
      expect(cookie).not.toMatch(/;\s*Secure(;|$)/i);
  });
});
