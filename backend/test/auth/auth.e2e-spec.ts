import { Controller, Get } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import type { AuthSession } from '../../src/auth/auth.config';
import { user } from '../../src/auth/auth.schema';
import {
  CurrentSession,
  CurrentUser,
} from '../../src/auth/decorators/current-user.decorator';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

@Controller('protected-test')
class ProtectedTestController {
  @Get()
  whoami(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: AuthSession['session'],
  ) {
    return { user, session };
  }
}

const signUpBody = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  password: 'super-secret-password',
};

interface UserBody {
  user: { id: string; name: string; email: string };
}

interface WhoAmIBody {
  user: { id: string; email: string };
  session: { userId: string };
}

describe('Auth (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;

  beforeAll(async () => {
    ctx = await createTestApp({ controllers: [ProtectedTestController] });
    server = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
  });

  it('email/password sign-up creates a user and account usable to sign in', async () => {
    const signUp = await request(server)
      .post('/api/auth/sign-up/email')
      .send(signUpBody);

    expect(signUp.status).toBe(200);
    const signedUp = signUp.body as UserBody;
    expect(signedUp.user).toMatchObject({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    });

    // The credential account exists: signing in with the same password works
    // and the resulting session resolves to the same user.
    const signIn = await request(server)
      .post('/api/auth/sign-in/email')
      .send({ email: signUpBody.email, password: signUpBody.password });

    expect(signIn.status).toBe(200);

    const cookie = signIn.headers['set-cookie'];
    expect(cookie).toBeDefined();

    const session = await request(server)
      .get('/api/auth/get-session')
      .set('Cookie', cookie);

    expect(session.status).toBe(200);
    const sessionBody = session.body as UserBody;
    expect(sessionBody.user).toMatchObject({ email: 'ada@example.com' });
    expect(sessionBody.user.id).toBe(signedUp.user.id);
  });

  it('resolves a signed-in session cookie to the correct user on a protected route', async () => {
    const signUp = await request(server)
      .post('/api/auth/sign-up/email')
      .send(signUpBody);
    const signedUp = signUp.body as UserBody;
    const cookie = signUp.headers['set-cookie'];

    const res = await request(server)
      .get('/protected-test')
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    const whoami = res.body as WhoAmIBody;
    expect(whoami.user).toMatchObject({
      id: signedUp.user.id,
      email: 'ada@example.com',
    });
    expect(whoami.session.userId).toBe(signedUp.user.id);
  });

  it('denies a protected route with 401 when no credentials are sent', async () => {
    const res = await request(server).get('/protected-test');

    expect(res.status).toBe(401);
  });

  it('resolves a valid x-api-key to the key owner on a protected route', async () => {
    const signUp = await request(server)
      .post('/api/auth/sign-up/email')
      .send(signUpBody);
    const signedUp = signUp.body as UserBody;
    const cookie = signUp.headers['set-cookie'];

    const created = await request(server)
      .post('/users/me/api-keys')
      .set('Cookie', cookie)
      .send({ name: 'ci-key' });

    expect(created.status).toBe(201);
    const { key } = created.body as { key: string };
    expect(typeof key).toBe('string');

    const res = await request(server)
      .get('/protected-test')
      .set('x-api-key', key);

    expect(res.status).toBe(200);
    const whoami = res.body as WhoAmIBody;
    expect(whoami.user).toMatchObject({
      id: signedUp.user.id,
      email: 'ada@example.com',
    });
  });

  it('rejects an invalid x-api-key with 401', async () => {
    const res = await request(server)
      .get('/protected-test')
      .set('x-api-key', 'definitely-not-a-valid-key');

    expect(res.status).toBe(401);
  });

  /**
   * The half of the ban better-auth's admin plugin *does* enforce on this build,
   * pinned here so nobody deletes `banInForce` as redundant.
   *
   * The plugin registers a `session.create.before` database hook
   * (`plugins/admin/admin.mjs:32-49`) that refuses a banned account a **new**
   * session, and that runs with no admin route involved. What it cannot do is
   * anything about the sessions an account already holds — `/admin/ban-user`
   * deletes those, and it answers 403 to every account this build can create —
   * which is why the credential paths assert the ban for themselves.
   *
   * Banned by column update, the way every other spec here does it: driving
   * `/admin/ban-user` would be testing a fact about the build rather than the
   * thing under test.
   */
  it('refuses a banned account a new session at sign-in', async () => {
    const signUp = await request(server)
      .post('/api/auth/sign-up/email')
      .send(signUpBody);
    const signedUp = signUp.body as UserBody;
    await ctx.db
      .update(user)
      .set({ banned: true })
      .where(eq(user.id, signedUp.user.id));

    const signIn = await request(server)
      .post('/api/auth/sign-in/email')
      .send({ email: signUpBody.email, password: signUpBody.password });

    expect(signIn.status).toBe(403);
    expect((signIn.body as { code?: string }).code).toBe('BANNED_USER');
  });
});
