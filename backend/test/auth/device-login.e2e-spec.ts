import request from 'supertest';
import { App } from 'supertest/types';

import { signUpMember } from '../utils/test-auth';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * `cloudgate login`'s server half: the device flow, where
 * the person approves a code in the console and the polling CLI is handed a
 * **Personal key** ending 90 days after login — never a session, so a CLI
 * login is never an interactive session.
 *
 * Driven over HTTP the way the CLI and the console's `/device` screen drive
 * it: the CLI's two routes (`POST /auth/device/code`, `POST /auth/device/token`)
 * with no credential, and the person's claim and approval on better-auth's
 * `/api/auth/device*` with their session cookie.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const DAY = 24 * 60 * 60 * 1000;

interface StartedLogin {
  deviceCode: string;
  userCode: string;
  interval: number;
  expiresIn: number;
}

describe('Device login (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;

  beforeAll(async () => {
    ctx = await createTestApp();
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
  });

  async function signUp(): Promise<{ cookie: string; userId: string }> {
    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    const cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    return { cookie, userId: (res.body as { user: { id: string } }).user.id };
  }

  /** What the CLI does first: ask for a code, with no credential. */
  async function startLogin(): Promise<StartedLogin> {
    const res = await request(httpServer).post('/auth/device/code').send({});
    expect(res.status).toBe(200);
    return res.body as StartedLogin;
  }

  /** What the console's `/device` screen does: look the code up, then approve it. */
  async function approve(cookie: string, userCode: string) {
    const looked = await request(httpServer)
      .get('/api/auth/device')
      .query({ user_code: userCode })
      .set('Cookie', cookie);
    expect(looked.status).toBe(200);
    return request(httpServer)
      .post('/api/auth/device/approve')
      .set('Cookie', cookie)
      .send({ userCode });
  }

  function poll(deviceCode: string, extra: Record<string, unknown> = {}) {
    return request(httpServer)
      .post('/auth/device/token')
      .send({ deviceCode, ...extra });
  }

  it('hands the polling CLI a Personal key ending 90 days after login, and no session', async () => {
    const { cookie } = await signUp();
    const login = await startLogin();
    expect(login.userCode).toMatch(/^[A-Z0-9]{8}$/);
    expect(login.interval).toBeGreaterThan(0);
    expect(login.expiresIn).toBeGreaterThan(0);

    const approved = await approve(cookie, login.userCode);
    expect(approved.status).toBe(200);

    const before = Date.now();
    const res = await poll(login.deviceCode, { name: 'cloudgate on laptop' });
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    const body = res.body as { key: string; keyId: string; expiresAt: string };
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'key', 'keyId']);
    const ends = new Date(body.expiresAt).getTime();
    expect(Math.abs(ends - (before + 90 * DAY))).toBeLessThan(60_000);

    // The key is the person's: it reads their facts, and it is in their list.
    const whoami = await request(httpServer)
      .get('/users/me/whoami')
      .set('x-api-key', body.key);
    expect(whoami.status).toBe(200);
    expect(whoami.body).toMatchObject({
      email: owner.email,
      key: { id: body.keyId, name: 'cloudgate on laptop' },
    });
    const keys = await request(httpServer)
      .get('/users/me/api-keys')
      .set('Cookie', cookie);
    expect(
      (keys.body as { apiKeys: Array<{ id: string }> }).apiKeys.map(
        (key) => key.id,
      ),
    ).toContain(body.keyId);

    // A key, not a session: the person's own sessions are still just the one
    // their sign-up made.
    const sessions = await request(httpServer)
      .get('/users/me/sessions')
      .set('Cookie', cookie);
    expect(sessions.body).toHaveLength(1);

    // The code is spent.
    const again = await poll(login.deviceCode);
    expect(again.status).toBe(400);
    expect(again.body).toMatchObject({ code: 'INVALID_GRANT' });
  });

  it('mints a key named after a long hostname, up to the longest name the CLI may send', async () => {
    const { cookie } = await signUp();
    const login = await startLogin();
    expect((await approve(cookie, login.userCode)).status).toBe(200);

    // `cloudgate on Admins-MacBook-Air.local` is 37 characters, and the CLI
    // may send up to 100: better-auth's own default ceiling is 32.
    const name = `cloudgate on ${'a'.repeat(87)}`;
    expect(name).toHaveLength(100);
    const res = await poll(login.deviceCode, { name });
    expect(res.status).toBe(200);

    const whoami = await request(httpServer)
      .get('/users/me/whoami')
      .set('x-api-key', (res.body as { key: string }).key);
    expect(whoami.body).toMatchObject({ key: { name } });
  });

  it('names a Personal key made in the console with the longest name its form allows', async () => {
    const { cookie } = await signUp();
    const name = 'k'.repeat(255);
    const res = await request(httpServer)
      .post('/users/me/api-keys')
      .set('Cookie', cookie)
      .send({ name });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name });
  });

  it('answers AUTHORIZATION_PENDING until the code is approved, and SLOW_DOWN to a poll inside the interval', async () => {
    const login = await startLogin();
    const first = await poll(login.deviceCode);
    expect(first.status).toBe(400);
    expect(first.body).toMatchObject({ code: 'AUTHORIZATION_PENDING' });

    const second = await poll(login.deviceCode);
    expect(second.status).toBe(400);
    expect(second.body).toMatchObject({ code: 'SLOW_DOWN' });
  });

  it('answers ACCESS_DENIED once the person denies the code', async () => {
    const { cookie } = await signUp();
    const login = await startLogin();
    await request(httpServer)
      .get('/api/auth/device')
      .query({ user_code: login.userCode })
      .set('Cookie', cookie);
    const denied = await request(httpServer)
      .post('/api/auth/device/deny')
      .set('Cookie', cookie)
      .send({ userCode: login.userCode });
    expect(denied.status).toBe(200);

    const res = await poll(login.deviceCode);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'ACCESS_DENIED' });
  });

  it('refuses a device code it never issued', async () => {
    const res = await poll('not-a-device-code');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_GRANT' });
  });

  describe('the pre-bind (better-auth 1.6.33 takes user_id from an unauthenticated body)', () => {
    it("does not route better-auth's own /device/code, which takes a user_id", async () => {
      const { userId } = await signUp();
      const res = await request(httpServer)
        .post('/api/auth/device/code')
        .send({ client_id: 'cloudgate-cli', user_id: userId });
      expect(res.status).toBe(404);
    });

    it("refuses a user id in the CLI's code request", async () => {
      const { userId } = await signUp();
      for (const field of ['userId', 'user_id']) {
        const res = await request(httpServer)
          .post('/auth/device/code')
          .send({ [field]: userId });
        expect(res.status).toBe(400);
      }
    });

    it('binds a code to no one until a signed-in person looks it up', async () => {
      const victim = await signUp();
      const other = await signUpMember(httpServer, victim.cookie, {
        email: 'ida@example.com',
      });
      const login = await startLogin();
      // A lookup with no session claims nothing.
      const anonymous = await request(httpServer)
        .get('/api/auth/device')
        .query({ user_code: login.userCode });
      expect(anonymous.status).toBe(200);

      // So the first signed-in person to look it up is who it is bound to,
      // and the victim, who never did, cannot approve it.
      expect((await approve(other.cookie, login.userCode)).status).toBe(200);
      const res = await poll(login.deviceCode);
      expect(res.status).toBe(200);
      const whoami = await request(httpServer)
        .get('/users/me/whoami')
        .set('x-api-key', (res.body as { key: string }).key);
      expect(whoami.body).toMatchObject({ email: 'ida@example.com' });
    });
  });

  it('refuses a Personal key on the lookup, approve and deny, so a key cannot mint a key', async () => {
    const { cookie } = await signUp();
    const created = await request(httpServer)
      .post('/users/me/api-keys')
      .set('Cookie', cookie)
      .send({ name: 'ci-key' });
    const key = (created.body as { key: string }).key;
    const login = await startLogin();

    const looked = await request(httpServer)
      .get('/api/auth/device')
      .query({ user_code: login.userCode })
      .set('x-api-key', key);
    expect(looked.status).toBe(403);
    for (const path of ['/api/auth/device/approve', '/api/auth/device/deny']) {
      const res = await request(httpServer)
        .post(path)
        .set('x-api-key', key)
        .send({ userCode: login.userCode });
      expect(res.status).toBe(403);
    }
    expect((await poll(login.deviceCode)).body).toMatchObject({
      code: 'AUTHORIZATION_PENDING',
    });
  });

  it("deletes the key a login replaces, when it is the approving person's", async () => {
    const { cookie } = await signUp();
    const first = await startLogin();
    await approve(cookie, first.userCode);
    const old = (await poll(first.deviceCode)).body as {
      key: string;
      keyId: string;
    };

    const second = await startLogin();
    await approve(cookie, second.userCode);
    const res = await poll(second.deviceCode, { replaces: old.keyId });
    expect(res.status).toBe(200);

    const oldAnswer = await request(httpServer)
      .get('/users/me/whoami')
      .set('x-api-key', old.key);
    expect(oldAnswer.status).toBe(401);
    const newAnswer = await request(httpServer)
      .get('/users/me/whoami')
      .set('x-api-key', (res.body as { key: string }).key);
    expect(newAnswer.status).toBe(200);
  });

  it("leaves a key that is not the approving person's", async () => {
    const { cookie } = await signUp();
    const other = await signUpMember(httpServer, cookie, {
      email: 'ida@example.com',
    });
    const created = await request(httpServer)
      .post('/users/me/api-keys')
      .set('Cookie', cookie)
      .send({ name: 'grace-key' });
    const grace = created.body as { key: string; id: string };

    const login = await startLogin();
    await approve(other.cookie, login.userCode);
    const res = await poll(login.deviceCode, { replaces: grace.id });
    expect(res.status).toBe(200);

    const still = await request(httpServer)
      .get('/users/me/whoami')
      .set('x-api-key', grace.key);
    expect(still.status).toBe(200);
  });
});
