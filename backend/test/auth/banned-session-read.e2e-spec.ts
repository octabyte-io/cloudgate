import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { user } from '../../src/auth/auth.schema';
import { BANNED_CODE, BANNED_MESSAGE } from '../../src/auth/ban';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * What better-auth's own endpoints answer a banned account (H-08).
 *
 * The sibling of `credential-liveness.e2e-spec.ts` and of `auth.e2e-spec.ts`'s
 * sign-in case, and the reader neither of them covers. Every Cloudgate route is
 * guarded by `AuthService.validateRequest`, which has refused a banned session
 * — but `/api/auth/*` is `AuthController`'s catch-all straight into
 * better-auth's handler, `@Public()` by construction because `/get-session` is
 * how a caller finds out whether they have a session at all. So the one read the
 * console gates on never met the ban: it answered **200 with a full live session
 * body, token included**, while `/servers` and `/projects` beside it answered
 * 403 — and the console stayed painted, reporting every refusal behind it to a
 * banned operator as a *role* problem.
 *
 * Banned by column update, as every other spec here does it: `/admin/ban-user`
 * answers 403 to every account this build can create (`auth.config.ts`), so
 * driving it would test a fact about the build rather than the thing under test.
 *
 * `NODE_ENV` is left at jest's own `test`, unlike the session-address specs.
 * Nothing here reads an address, and production would turn on better-auth's
 * origin check for the credentialed requests below.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const HOUR = 60 * 60 * 1000;

describe('The ban on the /api/auth surface (e2e)', () => {
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

  /** A signed-up owner and the cookie their browser would be holding. */
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

  /** Writes the two ban columns directly, the way an operator with psql would. */
  async function ban(
    userId: string,
    banExpires: Date | null = null,
  ): Promise<void> {
    await ctx.db
      .update(user)
      .set({ banned: true, banExpires })
      .where(eq(user.id, userId));
  }

  /**
   * The finding itself. A 403 rather than a 401 because that is the answer an earlier fix
   * settled for a session whose *account* is refused, and the code is
   * better-auth's own `BANNED_USER` — the same one sign-in already answers with
   * — so the console learns one spelling of this fact rather than two.
   */
  it('refuses a session read from a banned account', async () => {
    const { cookie, userId } = await signUp();
    await ban(userId, new Date(Date.now() + HOUR));

    const res = await request(httpServer)
      .get('/api/auth/get-session')
      .set('Cookie', cookie);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: BANNED_CODE,
      message: BANNED_MESSAGE,
    });
    // Nothing of the session came back beside the refusal — the body carried a
    // live session and its token before H-08, which is what the console read.
    expect(JSON.stringify(res.body)).not.toContain('token');
  });

  /**
   * The same read, and the control that says the refusal is the ban rather than
   * the cookie: on the live box unbanning restored *the same session in the same
   * tab* with full data.
   */
  it('answers a live session for the same cookie while the account is not banned', async () => {
    const { cookie } = await signUp();

    const res = await request(httpServer)
      .get('/api/auth/get-session')
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ user: { email: owner.email } });
  });

  /**
   * `banExpires` again, on a third reader. The admin plugin clears an elapsed
   * ban only inside its `session.create.before` hook, so the row still reads
   * `banned = true` here and `banInForce` is the only thing letting this session
   * back in.
   */
  it('answers a live session once a temporary ban has passed', async () => {
    const { cookie, userId } = await signUp();
    await ban(userId, new Date(Date.now() - HOUR));

    const res = await request(httpServer)
      .get('/api/auth/get-session')
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ user: { email: owner.email } });
  });

  /**
   * Not one route. The hook reads the session better-auth itself resolved, so
   * every `/api/auth` endpoint that resolved one is covered — and this is the
   * neighbour the live capture caught answering **304** beside the 200 on
   * `/get-session`, handing a banned operator the Organization the console draws
   * its scope rail from.
   */
  it('refuses the organization list from a banned account', async () => {
    const { cookie, userId } = await signUp();
    await ban(userId);

    const res = await request(httpServer)
      .get('/api/auth/organization/list')
      .set('Cookie', cookie);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: BANNED_CODE });
  });

  /**
   * The one exemption, and it is the console's exit. The dead-session guard ends
   * the session before it navigates — a redirect with the cookie still set is
   * the loop `frontend/src/proxy.ts` produces — so refusing this would strand a
   * banned operator on a console they cannot leave, and would refuse it *after*
   * better-auth had already deleted the row.
   */
  it('lets a banned account sign out', async () => {
    const { cookie, userId } = await signUp();
    await ban(userId);

    const res = await request(httpServer)
      .post('/api/auth/sign-out')
      .set('Cookie', cookie)
      .send({});

    expect(res.status).toBe(200);

    // And the session really is gone, rather than merely reported as gone.
    const after = await request(httpServer)
      .get('/api/auth/get-session')
      .set('Cookie', cookie);
    expect(after.status).toBe(200);
    expect(after.body).toBeNull();
  });

  /**
   * H-26, and the half H-08 left open. The refusal above reaches the console as
   * a code; this one reached it as a **403 and nothing else**, and the console
   * has exactly one sentence for a 403 — "Your role in this Organization does
   * not allow this" — so a banned operator was told to ask an owner for a role
   * change that would not have helped. The message was already right on the
   * wire and is deliberately not what the console reads: matching it is what
   * an earlier fix removed (`frontend/src/lib/auth/auth-error.ts`).
   *
   * `BANNED_CODE` rather than `OWNER_REFUSALS.SESSION_BANNED.code`, which is
   * `USER_BANNED` — better-auth's api-key spelling, and one the console would
   * then have to learn a second time for the same fact.
   */
  it("names the ban with a code on a Cloudgate route, not only on better-auth's", async () => {
    const { cookie, userId } = await signUp();
    await ban(userId);

    for (const path of ['/servers', '/projects']) {
      const res = await request(httpServer).get(path).set('Cookie', cookie);

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        statusCode: 403,
        error: 'Forbidden',
        message: BANNED_MESSAGE,
        code: BANNED_CODE,
        path,
      });
    }
  });

  /**
   * The control on the field above: `code` is opt-in, so a refusal nobody named
   * still answers with the body it always did. Without this, "add a code" could
   * quietly become "add a code to everything", which is the contract change
   * H-26 explicitly did not make.
   */
  it('leaves an unnamed refusal without a code', async () => {
    const res = await request(httpServer).get('/projects');

    expect(res.status).toBe(401);
    expect(res.body).not.toHaveProperty('code');
  });

  /**
   * H-29. Both endpoints carried `BANNED_USER` after H-08, and the two of them
   * said different things: better-auth's `bannedUserMessage` default here, and
   * `BANNED_MESSAGE` on the read a second later. One fact, one surface, one
   * person — and a wire sentence that told a self-hosted operator to contact a
   * support desk that does not exist.
   */
  it('refuses a banned sign-in in the same words as the session read', async () => {
    const { userId } = await signUp();
    await ban(userId);

    const res = await request(httpServer)
      .post('/api/auth/sign-in/email')
      .send({ email: owner.email, password: owner.password });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: BANNED_CODE,
      message: BANNED_MESSAGE,
    });
  });

  /**
   * The in-process half, which must stay on `AuthService`'s side of the line.
   * `validateRequest` dispatches `auth.api.getSession` through this same hook
   * pipeline and then makes the refusal itself, as a typed rejection the guard
   * renders. If the hook stopped skipping request-less dispatches, that call
   * would reject with a raw `APIError` and `AllExceptionsFilter` would answer a
   * banned caller **500** instead of 403.
   */
  it('answers a banned cookie on a Cloudgate route with the guard 403, not a 500', async () => {
    const { cookie, userId } = await signUp();
    await ban(userId);

    const res = await request(httpServer)
      .get('/projects')
      .set('Cookie', cookie);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ message: BANNED_MESSAGE });
  });
});
