import { HttpException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { apikey, user } from '../../src/auth/auth.schema';
import { AuthService } from '../../src/auth/auth.service';
import type { CredentialHandle } from '../../src/auth/auth.service';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * What an api key that is turned down actually answers, asked of a real route
 * rather than of a stubbed `verifyApiKey`.
 *
 * `api-key-refusal.spec.ts` is the unit half and pins the *mapping* from
 * better-auth's error codes; it cannot see the case the ban gap was about, because that
 * case is not a code better-auth ever emits. The plugin checks a ban inside
 * `/api-key/delete` and never on the verify path, so the 403 branch was
 * unreachable and a banned account went on answering 200 on every HTTP route —
 * while the ADR-0012 renewal cut the same account's WebSocket at the next tick.
 * Both halves of that are here: the matrix, and the two paths agreeing.
 *
 * `GET /projects` is the probe throughout — the route the finding was measured
 * on, and the cheapest one an api-key caller is entitled to.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** The message an unknown key gets, and the only thing it is allowed to say. */
const BARE_401 = 'Unauthorized';
const BANNED_MESSAGE = 'The account this API key belongs to is banned';
/**
 * The cookie path's own sentence. Same 403 and the same `USER_BANNED`
 * code, different words on purpose: the one above names the *key's* owner, and
 * telling a browser its session is an API key is the reason it is not reused.
 */
const SESSION_BANNED_MESSAGE = 'This account is banned';

describe('API key refusals (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let auth: AuthService;

  beforeAll(async () => {
    ctx = await createTestApp();
    httpServer = ctx.app.getHttpServer() as App;
    auth = ctx.app.get(AuthService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
  });

  /** The instance owner, and the cookie their key is minted with. */
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

  /**
   * A key of the owner's, minted through the route a person would use. Only the
   * secret comes back: every case below resets the database first and mints one
   * key, so the row a test wants to age or disable is the only row there — the
   * same reason `credential-liveness.e2e-spec.ts` deletes `apikey` unfiltered.
   */
  async function mintKey(cookie: string): Promise<string> {
    const created = await request(httpServer)
      .post('/users/me/api-keys')
      .set('Cookie', cookie)
      .send({ name: 'ci-key' });
    expect(created.status).toBe(201);
    return (created.body as { key: string }).key;
  }

  /** The probe: the route the finding was measured on, asked with a key. */
  function askWithKey(key: string) {
    return request(httpServer).get('/projects').set('x-api-key', key);
  }

  /**
   * The same probe, asked with the cookie instead — the two rows the issue's
   * transcript compared, so they have to be the same route.
   */
  function askWithCookie(cookie: string) {
    return request(httpServer).get('/projects').set('Cookie', cookie);
  }

  describe('the refusal matrix', () => {
    it('answers a live key on the route its owner is entitled to', async () => {
      const { cookie } = await signUp();
      const key = await mintKey(cookie);

      const res = await askWithKey(key);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    /**
     * The asymmetry NAMED_API_KEY_REFUSALS exists to keep: a key string that
     * matches nothing must not be told apart from one that does, or the header
     * becomes an oracle for which keys exist.
     */
    it('refuses an unknown key with a bare 401 that names nothing', async () => {
      await signUp();

      const res = await askWithKey('cg-a-key-that-was-never-minted');

      expect(res.status).toBe(401);
      expect((res.body as { message: string }).message).toBe(BARE_401);
    });

    it('refuses a malformed key with the same bare 401', async () => {
      await signUp();

      const res = await askWithKey('not-even-shaped-like-a-key');

      expect(res.status).toBe(401);
      expect((res.body as { message: string }).message).toBe(BARE_401);
    });

    it('names a key an operator disabled, with 401', async () => {
      const { cookie } = await signUp();
      const key = await mintKey(cookie);
      await ctx.db.update(apikey).set({ enabled: false });

      const res = await askWithKey(key);

      expect(res.status).toBe(401);
      expect((res.body as { message: string }).message).toBe(
        'API key is disabled',
      );
    });

    it('names a key whose expiry has passed, with 401', async () => {
      const { cookie } = await signUp();
      const key = await mintKey(cookie);
      await ctx.db
        .update(apikey)
        .set({ expiresAt: new Date(Date.now() - 1_000) });

      const res = await askWithKey(key);

      expect(res.status).toBe(401);
      expect((res.body as { message: string }).message).toBe(
        'API key has expired',
      );
    });

    it('names a key with no requests left, with 429', async () => {
      const { cookie } = await signUp();
      const key = await mintKey(cookie);
      await ctx.db.update(apikey).set({ remaining: 0 });

      const res = await askWithKey(key);

      expect(res.status).toBe(429);
      expect((res.body as { message: string }).message).toBe(
        'API key has reached its usage limit',
      );
    });

    /**
     * The ban gap itself. Not a `verifyApiKey` refusal at all — the key is
     * genuine and the plugin verifies it happily — so this only fails closed
     * because `validateApiKey` now asks about the owner's row itself.
     */
    it('refuses a banned owner with 403 and names the account', async () => {
      const { cookie, userId } = await signUp();
      const key = await mintKey(cookie);
      await ctx.db
        .update(user)
        .set({ banned: true })
        .where(eq(user.id, userId));

      const res = await askWithKey(key);

      expect(res.status).toBe(403);
      expect((res.body as { message: string }).message).toBe(BANNED_MESSAGE);
      // Nothing was listed on the way to being refused.
      expect(Array.isArray(res.body)).toBe(false);
    });

    it('lets a key back in once the ban is lifted', async () => {
      const { cookie, userId } = await signUp();
      const key = await mintKey(cookie);
      await ctx.db
        .update(user)
        .set({ banned: true })
        .where(eq(user.id, userId));
      expect((await askWithKey(key)).status).toBe(403);

      await ctx.db
        .update(user)
        .set({ banned: false })
        .where(eq(user.id, userId));

      expect((await askWithKey(key)).status).toBe(200);
    });

    /**
     * The neighbouring case found later, and its own transcript: the same
     * account, the same route, in the same second — the key answered 403 and the
     * **cookie answered 200 with the full listing**. `validateRequest` resolved
     * the session and never looked at `banned`, on the theory that a ban arrives
     * as a revocation because `/admin/ban-user` deletes the sessions. That route
     * answers 403 to every account this build can create, so nothing ever
     * revoked anything: on this build there was no way to ban an account and
     * have its existing browser sessions stop working.
     */
    it('refuses a banned account on the cookie path too, on the same route', async () => {
      const { cookie, userId } = await signUp();
      const key = await mintKey(cookie);
      await ctx.db
        .update(user)
        .set({ banned: true })
        .where(eq(user.id, userId));

      const overKey = await askWithKey(key);
      const overCookie = await askWithCookie(cookie);

      expect(overKey.status).toBe(403);
      expect(overCookie.status).toBe(403);
      expect((overCookie.body as { message: string }).message).toBe(
        SESSION_BANNED_MESSAGE,
      );
      // Nothing was listed on the way to being refused.
      expect(Array.isArray(overCookie.body)).toBe(false);
    });

    /**
     * `banExpires`, the half nothing in the tree read. The plugin clears
     * an elapsed ban only when a session is created, so a key — which creates
     * none — was refused for ever by a ban that had lasted a day. The row still
     * says `banned: true` here: that is the point.
     */
    it('lets both paths back in once a temporary ban has passed', async () => {
      const { cookie, userId } = await signUp();
      const key = await mintKey(cookie);
      await ctx.db
        .update(user)
        .set({ banned: true })
        .where(eq(user.id, userId));
      expect((await askWithKey(key)).status).toBe(403);

      await ctx.db
        .update(user)
        .set({ banned: true, banExpires: new Date(Date.now() - 1_000) })
        .where(eq(user.id, userId));

      expect((await askWithKey(key)).status).toBe(200);
      expect((await askWithCookie(cookie)).status).toBe(200);
    });
  });

  /**
   * ADR-0012 leaves two implementations of "is this credential still alive" in
   * one file, and the file says so: they are next to each other precisely
   * because they can drift. The ban gap is what drifting looked like. These two pin the
   * seam from both sides.
   */
  describe('the request path and the socket path', () => {
    /** The handle a socket of this key's would hold, read the live way. */
    async function socketHandle(key: string): Promise<{
      credential: CredentialHandle;
      organizationId: string | null;
    }> {
      const validated = await auth.validateRequest({ 'x-api-key': key });
      if (validated.credential?.kind !== 'apiKey') {
        throw new Error(
          `expected an api-key handle, got ${JSON.stringify(validated.credential)}`,
        );
      }
      return {
        credential: validated.credential,
        organizationId: validated.session?.activeOrganizationId ?? null,
      };
    }

    it('refuse a banned owner with the same status and the same sentence', async () => {
      const { cookie, userId } = await signUp();
      const key = await mintKey(cookie);
      // Read before the ban: after it there is no credential to hand a socket,
      // which is the request path's half of the same refusal.
      const { credential, organizationId } = await socketHandle(key);
      await ctx.db
        .update(user)
        .set({ banned: true })
        .where(eq(user.id, userId));

      const overHttp = await askWithKey(key);
      const overSocket = await auth
        .assertCredentialAlive(credential, organizationId)
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect(overSocket).toBeInstanceOf(HttpException);
      const refusal = overSocket as HttpException;
      expect(refusal.getStatus()).toBe(overHttp.status);
      expect(refusal.message).toBe(
        (overHttp.body as { message: string }).message,
      );
      expect(refusal.getStatus()).toBe(403);
      expect(refusal.message).toBe(BANNED_MESSAGE);
    });

    it('both admit an owner who is not banned', async () => {
      const { cookie } = await signUp();
      const key = await mintKey(cookie);
      const { credential, organizationId } = await socketHandle(key);

      expect((await askWithKey(key)).status).toBe(200);
      await expect(
        auth.assertCredentialAlive(credential, organizationId),
      ).resolves.toBeUndefined();
    });
  });
});
