import { Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import * as schema from '../../src/db/schema';
import { routedAuthEndpoints } from '../utils/auth-endpoints';
import { secondOrganizationOwner } from '../utils/test-auth';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { totpFromUri } from '../utils/totp';

jest.setTimeout(120_000);

const signUpBody = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  password: 'super-secret-password',
};

interface ProfileBody {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  image: string | null;
  twoFactorEnabled: boolean | null;
}

/** One row of `GET /users/me/sessions` — deliberately no `token`. */
interface ListedSession {
  id: string;
  userId: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  expiresAt: string;
}

async function signUp(server: App): Promise<{ cookie: string; id: string }> {
  const res = await request(server)
    .post('/api/auth/sign-up/email')
    .send(signUpBody);
  expect(res.status).toBe(200);
  const { user } = res.body as { user: { id: string } };
  return { cookie: res.headers['set-cookie'], id: user.id };
}

/**
 * The session id behind a cookie, read from better-auth's own `get-session`.
 *
 * Read from there rather than from `GET /users/me/sessions` on purpose: the
 * route under test must not be the only thing that can name a session, or a
 * test for it would be checking its answer against itself (§1.7).
 */
async function currentSessionId(server: App, cookie: string): Promise<string> {
  const res = await request(server)
    .get('/api/auth/get-session')
    .set('Cookie', cookie);
  return (res.body as { session: { id: string } }).session.id;
}

/** The live bearer token behind a cookie — what the listing must never leak. */
async function currentToken(server: App, cookie: string): Promise<string> {
  const res = await request(server)
    .get('/api/auth/get-session')
    .set('Cookie', cookie);
  return (res.body as { session: { token: string } }).session.token;
}

/** Every field of an error body except the wall clock. */
function withoutTimestamp(body: unknown): unknown {
  const rest = { ...(body as Record<string, unknown>) };
  delete rest.timestamp;
  return rest;
}

describe('Users (e2e)', () => {
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

  describe('profile', () => {
    it('denies profile routes with 401 when no credentials are sent', async () => {
      const get = await request(server).get('/users/me');
      expect(get.status).toBe(401);

      const patch = await request(server)
        .patch('/users/me')
        .send({ firstName: 'Eve' });
      expect(patch.status).toBe(401);
    });

    it('returns the signed-in user profile', async () => {
      const { cookie, id } = await signUp(server);

      const res = await request(server).get('/users/me').set('Cookie', cookie);

      expect(res.status).toBe(200);
      const profile = res.body as ProfileBody;
      expect(profile).toMatchObject({
        id,
        firstName: 'Ada Lovelace',
        email: 'ada@example.com',
      });
    });

    it('profile update changes the retrievable profile fields', async () => {
      const { cookie, id } = await signUp(server);

      const patch = await request(server)
        .patch('/users/me')
        .set('Cookie', cookie)
        .send({ firstName: 'Ada', lastName: 'King' });

      expect(patch.status).toBe(200);

      const res = await request(server).get('/users/me').set('Cookie', cookie);
      expect(res.status).toBe(200);
      const profile = res.body as ProfileBody;
      expect(profile).toMatchObject({
        id,
        firstName: 'Ada',
        lastName: 'King',
        email: 'ada@example.com',
      });
    });

    it('rejects a profile update with an invalid email', async () => {
      const { cookie } = await signUp(server);

      const res = await request(server)
        .patch('/users/me')
        .set('Cookie', cookie)
        .send({ email: 'not-an-email' });

      expect(res.status).toBe(400);
    });
  });

  /**
   * The sign-in email is the account-recovery anchor, so changing it is an
   * account-security action, and it is stored the way better-auth looks
   * it up — lower-cased — or nobody can sign in with it again.
   */
  describe('changing the sign-in email', () => {
    /** The stored `user.email`, read from the table rather than the route. */
    async function storedEmail(id: string): Promise<string> {
      const [row] = await ctx.db
        .select({ email: schema.user.email })
        .from(schema.user)
        .where(eq(schema.user.id, id));
      return row.email;
    }

    it('stores a mixed-case address lower-cased, and it signs in', async () => {
      const { cookie, id } = await signUp(server);

      const patch = await request(server)
        .patch('/users/me')
        .set('Cookie', cookie)
        .send({
          email: 'Mixed.Case@Example.com',
          currentPassword: signUpBody.password,
        });

      expect(patch.status).toBe(200);
      expect((patch.body as ProfileBody).email).toBe('mixed.case@example.com');
      expect(await storedEmail(id)).toBe('mixed.case@example.com');

      const signIn = await request(server)
        .post('/api/auth/sign-in/email')
        .send({
          email: 'Mixed.Case@Example.com',
          password: signUpBody.password,
        });
      expect(signIn.status).toBe(200);
    });

    it('refuses an email change without the current password, leaving the row', async () => {
      const { cookie, id } = await signUp(server);

      const res = await request(server)
        .patch('/users/me')
        .set('Cookie', cookie)
        .send({ email: 'someone-else@example.com' });

      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toBe(
        'Changing the sign-in email needs your current password. Send it as ' +
          'currentPassword',
      );
      expect(await storedEmail(id)).toBe(signUpBody.email);
    });

    it('refuses an email change with a wrong password, leaving the row', async () => {
      const { cookie, id } = await signUp(server);

      const res = await request(server)
        .patch('/users/me')
        .set('Cookie', cookie)
        .send({
          email: 'someone-else@example.com',
          currentPassword: 'not-the-password',
        });

      expect(res.status).toBe(400);
      expect((res.body as { code?: string }).code).toBe('INVALID_PASSWORD');
      expect(await storedEmail(id)).toBe(signUpBody.email);
    });

    it('does not ask for a password when the address sent is the one stored', async () => {
      const { cookie } = await signUp(server);

      const res = await request(server)
        .patch('/users/me')
        .set('Cookie', cookie)
        .send({ firstName: 'Ada', email: signUpBody.email.toUpperCase() });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        firstName: 'Ada',
        email: signUpBody.email,
      });
    });

    it('refuses an address another account signs in with, in any case', async () => {
      const { cookie, id } = await signUp(server);
      await ctx.db.insert(schema.user).values({
        id: 'other-user',
        email: 'taken@example.com',
        updatedAt: new Date(),
      });

      const res = await request(server)
        .patch('/users/me')
        .set('Cookie', cookie)
        .send({
          email: 'Taken@Example.com',
          currentPassword: signUpBody.password,
        });

      expect(res.status).toBe(409);
      expect((res.body as { message: string }).message).toBe(
        'Another account already signs in with that email address',
      );
      expect(await storedEmail(id)).toBe(signUpBody.email);
    });

    it('refuses an API key an email change, with the password, leaving the row', async () => {
      const { cookie, id } = await signUp(server);
      const created = await request(server)
        .post('/users/me/api-keys')
        .set('Cookie', cookie)
        .send({ name: 'ci-key' });
      const { key } = created.body as { key: string };

      const res = await request(server)
        .patch('/users/me')
        .set('x-api-key', key)
        .send({
          email: 'attacker@example.com',
          currentPassword: signUpBody.password,
        });

      expect(res.status).toBe(403);
      expect((res.body as { message: string }).message).toMatch(
        /personal key cannot be used on this route/,
      );
      expect(await storedEmail(id)).toBe(signUpBody.email);

      // The cosmetic columns are not account security, and stay open to a key.
      const rename = await request(server)
        .patch('/users/me')
        .set('x-api-key', key)
        .send({ firstName: 'Ada', lastName: 'King' });
      expect(rename.status).toBe(200);
      expect(rename.body).toMatchObject({ firstName: 'Ada', lastName: 'King' });
    });
  });

  describe('2FA', () => {
    it('denies 2FA routes with 401 when no credentials are sent', async () => {
      const res = await request(server)
        .post('/users/me/2fa/enable')
        .send({ password: signUpBody.password });

      expect(res.status).toBe(401);
    });

    it('enable returns a TOTP URI and backup codes without activating 2FA yet', async () => {
      const { cookie } = await signUp(server);

      const res = await request(server)
        .post('/users/me/2fa/enable')
        .set('Cookie', cookie)
        .send({ password: signUpBody.password });

      expect(res.status).toBe(200);
      const body = res.body as { totpURI: string; backupCodes: string[] };
      expect(body.totpURI).toMatch(/^otpauth:\/\/totp\//);
      expect(body.totpURI).toContain('secret=');
      expect(body.backupCodes.length).toBeGreaterThan(0);

      // Not active until a code is verified.
      const profile = await request(server)
        .get('/users/me')
        .set('Cookie', cookie);
      expect(profile.body).toMatchObject({ twoFactorEnabled: false });
    });

    it('enable rejects a wrong password', async () => {
      const { cookie } = await signUp(server);

      const res = await request(server)
        .post('/users/me/2fa/enable')
        .set('Cookie', cookie)
        .send({ password: 'wrong-password' });

      expect(res.status).toBe(400);
    });

    it('verifying a valid TOTP code activates 2FA', async () => {
      const { cookie } = await signUp(server);

      const enable = await request(server)
        .post('/users/me/2fa/enable')
        .set('Cookie', cookie)
        .send({ password: signUpBody.password });
      const { totpURI } = enable.body as { totpURI: string };

      const verify = await request(server)
        .post('/users/me/2fa/verify')
        .set('Cookie', cookie)
        .send({ code: totpFromUri(totpURI) });

      expect(verify.status).toBe(200);
      // verify-totp rotates the session; the new cookie must be forwarded.
      const rotated = verify.headers['set-cookie'];
      expect(rotated).toBeDefined();

      const profile = await request(server)
        .get('/users/me')
        .set('Cookie', rotated);
      expect(profile.status).toBe(200);
      expect(profile.body).toMatchObject({ twoFactorEnabled: true });
    });

    it('rejects a wrong TOTP code without activating 2FA', async () => {
      const { cookie } = await signUp(server);

      const enable = await request(server)
        .post('/users/me/2fa/enable')
        .set('Cookie', cookie)
        .send({ password: signUpBody.password });
      const { totpURI } = enable.body as { totpURI: string };

      const valid = totpFromUri(totpURI);
      const wrong = valid === '000000' ? '000001' : '000000';

      const verify = await request(server)
        .post('/users/me/2fa/verify')
        .set('Cookie', cookie)
        .send({ code: wrong });

      expect(verify.status).toBeGreaterThanOrEqual(400);

      const profile = await request(server)
        .get('/users/me')
        .set('Cookie', cookie);
      expect(profile.body).toMatchObject({ twoFactorEnabled: false });
    });

    it('disable turns 2FA off again', async () => {
      const { cookie } = await signUp(server);

      const enable = await request(server)
        .post('/users/me/2fa/enable')
        .set('Cookie', cookie)
        .send({ password: signUpBody.password });
      const { totpURI } = enable.body as { totpURI: string };

      const verify = await request(server)
        .post('/users/me/2fa/verify')
        .set('Cookie', cookie)
        .send({ code: totpFromUri(totpURI) });
      const rotated = verify.headers['set-cookie'];

      const disable = await request(server)
        .post('/users/me/2fa/disable')
        .set('Cookie', rotated)
        .send({ password: signUpBody.password });

      expect(disable.status).toBe(200);
      // disable also rotates the session cookie.
      const afterDisable = disable.headers['set-cookie'];
      expect(afterDisable).toBeDefined();

      const profile = await request(server)
        .get('/users/me')
        .set('Cookie', afterDisable);
      expect(profile.status).toBe(200);
      expect(profile.body).toMatchObject({ twoFactorEnabled: false });
    });
  });

  describe('sessions', () => {
    it('denies session routes with 401 when no credentials are sent', async () => {
      const list = await request(server).get('/users/me/sessions');
      expect(list.status).toBe(401);

      const revoke = await request(server)
        .post('/users/me/sessions/revoke')
        .send({ sessionId: 'whatever' });
      expect(revoke.status).toBe(401);
    });

    it('lists the current session for the signed-in user', async () => {
      const { cookie, id } = await signUp(server);

      const res = await request(server)
        .get('/users/me/sessions')
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      const sessions = res.body as ListedSession[];
      expect(sessions).toHaveLength(1);
      expect(sessions[0].userId).toBe(id);
      expect(typeof sessions[0].id).toBe('string');
      expect(typeof sessions[0].createdAt).toBe('string');
      expect(typeof sessions[0].expiresAt).toBe('string');
    });

    /**
     * The whole point: the listing used to answer with better-auth's raw
     * session rows, so it handed the caller a live bearer token for every other
     * machine the account was signed in on.
     *
     * Asserted as the **exact key set** rather than `token` alone. The route is
     * a projection now, and the failure mode worth pinning is a field arriving
     * that nobody chose — a `token` renamed upstream, or a session column added
     * by a plugin — which an `not.toHaveProperty('token')` would sail past.
     */
    it('the session listing carries no token and no field beyond the ones it declares', async () => {
      const { cookie } = await signUp(server);

      // Two sessions, because the row the caller is *not* using is the one the
      // old shape leaked a working credential for — asserting only on the
      // caller's own row would pass even if every other row still carried one.
      const signIn = await request(server)
        .post('/api/auth/sign-in/email')
        .send({ email: signUpBody.email, password: signUpBody.password });
      const secondCookie = signIn.headers['set-cookie'];

      const res = await request(server)
        .get('/users/me/sessions')
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      const sessions = res.body as ListedSession[];
      expect(sessions).toHaveLength(2);
      for (const listed of sessions) {
        expect(Object.keys(listed).sort()).toEqual([
          'createdAt',
          'expiresAt',
          'id',
          'ipAddress',
          'userAgent',
          'userId',
        ]);
      }
      // Neither session's token arrived under another name either — the other
      // machine's included, which is the credential the listing was handing out.
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(await currentToken(server, cookie));
      expect(body).not.toContain(await currentToken(server, secondCookie));
      // And each of the six that *is* declared carries something: the
      // key set was right all along and `ipAddress` still arrived empty on every
      // row, so an allowlist assertion on its own could not tell a chosen field
      // from a field that can never inform.
      for (const listed of sessions) {
        expect(listed.ipAddress).toEqual(expect.any(String));
        expect(listed.ipAddress).not.toBe('');
      }
    });

    /**
     * The Address column could only ever render a dash.
     *
     * better-auth writes `session.ip_address` itself, from `getIp(headers)`, and
     * `getIp` reads a header and never the socket — so a caller that sends no
     * `x-forwarded-for` stored an empty address on every session it created.
     * `AuthController.toWebRequest` now fills the header from Express's `req.ip`,
     * which `TRUST_PROXY` decides the meaning of.
     *
     * **This assertion is weaker than it looks and the next one is not.** Under
     * jest's `NODE_ENV=test`, `@better-auth/core` `dist/utils/ip.mjs:215` falls
     * back to `127.0.0.1` whenever it resolves nothing, which is the same value a
     * loopback `req.ip` produces — so a broken app answers this too. What proves
     * the fix is `test/auth/session-address.e2e-spec.ts`, which runs the same
     * question under `NODE_ENV=production` where there is no fallback. This one is
     * here to pin the shape the console reads.
     */
    it('records the caller address on a session created without a forwarded header', async () => {
      const { cookie } = await signUp(server);

      const res = await request(server)
        .get('/users/me/sessions')
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      const [listed] = res.body as ListedSession[];
      expect(listed.ipAddress).toBe('127.0.0.1');
    });

    /**
     * The other half of the rule, in the configuration this suite runs: with
     * `TRUST_PROXY` unset there is no proxy in front by configuration, so a chain
     * a caller sends is unverifiable and `toWebRequest` replaces it with the
     * socket peer. better-auth would otherwise believe a single-entry header
     * (`@better-auth/core` `dist/utils/ip.mjs:188-191`), which let any caller
     * choose the address recorded against their session — an audit column that
     * lies, which is worse than the dash it used to show.
     *
     * This one really does fail without the fix, `NODE_ENV=test` and all: the
     * `127.0.0.1` fallback only fires when nothing resolves, and a header that
     * was passed through resolves to the claim.
     *
     * The *trusted* direction — a real proxy's chain kept and stripped from the
     * right — cannot be asked here, because it needs an instance that declares a
     * proxy and `TRUST_PROXY` is read once when the app boots. It lives in
     * `test/auth/session-address.e2e-spec.ts`, and both directions of the rule
     * itself sit in one describe in `test/auth/forwarded-address.spec.ts`.
     */
    it('refuses a caller the address they claim, recording the one they connected from', async () => {
      const { cookie } = await signUp(server);
      const claimed = await request(server)
        .post('/api/auth/sign-in/email')
        .set('x-forwarded-for', '1.2.3.4')
        .send({ email: signUpBody.email, password: signUpBody.password });
      expect(claimed.status).toBe(200);

      const res = await request(server)
        .get('/users/me/sessions')
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      const addresses = (res.body as ListedSession[]).map(
        (listed) => listed.ipAddress,
      );
      expect(addresses).toHaveLength(2);
      expect(addresses).not.toContain('1.2.3.4');
      for (const address of addresses) {
        expect(address).toBe('127.0.0.1');
      }
    });

    it('lists sessions for a session older than a day', async () => {
      const { cookie, id } = await signUp(server);

      // Age the caller's own session past better-auth's default 24h freshness
      // window, which is where a working session spends nearly all its life.
      const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
      await ctx.db
        .update(schema.session)
        .set({ createdAt: twoDaysAgo, updatedAt: twoDaysAgo })
        .where(eq(schema.session.userId, id));

      const res = await request(server)
        .get('/users/me/sessions')
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      const sessions = res.body as ListedSession[];
      expect(sessions).toHaveLength(1);
      expect(sessions[0].userId).toBe(id);
    });

    it('revoking by session id removes it and the revoked cookie stops working', async () => {
      const { cookie } = await signUp(server);

      // A second session for the same user.
      const signIn = await request(server)
        .post('/api/auth/sign-in/email')
        .send({ email: signUpBody.email, password: signUpBody.password });
      const secondCookie = signIn.headers['set-cookie'];
      const secondId = await currentSessionId(server, secondCookie);

      const before = await request(server)
        .get('/users/me/sessions')
        .set('Cookie', cookie);
      const idsBefore = (before.body as ListedSession[]).map((s) => s.id);
      expect(idsBefore).toHaveLength(2);
      expect(idsBefore).toContain(secondId);

      const revoke = await request(server)
        .post('/users/me/sessions/revoke')
        .set('Cookie', cookie)
        .send({ sessionId: secondId });
      expect(revoke.status).toBe(200);

      const after = await request(server)
        .get('/users/me/sessions')
        .set('Cookie', cookie);
      const idsAfter = (after.body as ListedSession[]).map((s) => s.id);
      expect(idsAfter).toHaveLength(1);
      expect(idsAfter).not.toContain(secondId);

      // The revoked session's cookie no longer authenticates.
      const revoked = await request(server)
        .get('/users/me')
        .set('Cookie', secondCookie);
      expect(revoked.status).toBe(401);
    });

    /**
     * ADR-0009, following ADR-0007 and ADR-0008: the two refusals are
     * byte-identical so the route cannot be used to ask whether a session id
     * exists. Compared as whole bodies rather than status alone — a differing
     * `message` would answer the question just as well as a differing status.
     */
    it('refuses a session id it does not own and one that does not exist identically', async () => {
      const { cookie } = await signUp(server);

      // A second user, reached the only way a closed instance allows: an
      // invitation. Accepting is not needed — these routes are the person's
      // own, not organization-scoped.
      const invite = await request(server)
        .post('/organizations/invitations')
        .set('Cookie', cookie)
        .send({ email: 'grace@example.com', role: 'member' });
      const inviteId = (invite.body as { id: string }).id;
      const other = await request(server)
        .post('/api/auth/sign-up/email')
        .set('x-cloudgate-token', inviteId)
        .send({
          name: 'Grace Hopper',
          email: 'grace@example.com',
          password: 'super-secret-password',
        });
      expect(other.status).toBe(200);
      const otherId = await currentSessionId(
        server,
        other.headers['set-cookie'],
      );

      const notOwned = await request(server)
        .post('/users/me/sessions/revoke')
        .set('Cookie', cookie)
        .send({ sessionId: otherId });
      const notFound = await request(server)
        .post('/users/me/sessions/revoke')
        .set('Cookie', cookie)
        .send({ sessionId: 'no-such-session-id' });

      expect(notOwned.status).toBe(404);
      expect(notOwned.status).toBe(notFound.status);
      // `timestamp` is the wall clock and is the only field allowed to differ.
      expect(withoutTimestamp(notOwned.body)).toEqual(
        withoutTimestamp(notFound.body),
      );

      // Nothing was revoked on the way to being refused: the other user's
      // session still authenticates.
      const stillAlive = await request(server)
        .get('/users/me')
        .set('Cookie', other.headers['set-cookie']);
      expect(stillAlive.status).toBe(200);
    });
  });

  describe('API keys', () => {
    it('denies api-key routes with 401 when no credentials are sent', async () => {
      const create = await request(server)
        .post('/users/me/api-keys')
        .send({ name: 'ci-key' });
      expect(create.status).toBe(401);

      const list = await request(server).get('/users/me/api-keys');
      expect(list.status).toBe(401);
    });

    it('a created api key authenticates requests and appears in the list', async () => {
      const { cookie, id } = await signUp(server);

      const created = await request(server)
        .post('/users/me/api-keys')
        .set('Cookie', cookie)
        .send({ name: 'ci-key' });

      expect(created.status).toBe(201);
      const createdKey = created.body as { id: string; key: string };
      expect(typeof createdKey.key).toBe('string');

      // The raw key works as x-api-key credentials.
      const whoami = await request(server)
        .get('/users/me')
        .set('x-api-key', createdKey.key);
      expect(whoami.status).toBe(200);
      expect(whoami.body).toMatchObject({ id, email: signUpBody.email });

      // The list shows the key's metadata but never the raw key.
      const list = await request(server)
        .get('/users/me/api-keys')
        .set('Cookie', cookie);
      expect(list.status).toBe(200);
      const listBody = list.body as {
        apiKeys: { id: string; name: string; key?: string }[];
        total: number;
      };
      expect(listBody.total).toBe(1);
      expect(listBody.apiKeys[0]).toMatchObject({
        id: createdKey.id,
        name: 'ci-key',
      });
      expect(listBody.apiKeys[0].key).toBeUndefined();
    });

    it('deleting an api key revokes it', async () => {
      const { cookie } = await signUp(server);

      const created = await request(server)
        .post('/users/me/api-keys')
        .set('Cookie', cookie)
        .send({ name: 'ci-key' });
      const createdKey = created.body as { id: string; key: string };

      const del = await request(server)
        .delete(`/users/me/api-keys/${createdKey.id}`)
        .set('Cookie', cookie);
      expect(del.status).toBe(200);

      const list = await request(server)
        .get('/users/me/api-keys')
        .set('Cookie', cookie);
      expect((list.body as { total: number }).total).toBe(0);

      const rejected = await request(server)
        .get('/users/me')
        .set('x-api-key', createdKey.key);
      expect(rejected.status).toBe(401);
    });
  });

  /**
   * The key as the service credential it is documented to be.
   *
   * Both faults were found in the same live-install phase and are the two
   * halves of one sentence: a minted key could serve ten requests a day, and
   * the routes that would have let it inspect or rotate itself refused it
   * outright. Either one alone makes headless operation impossible.
   */
  describe('as a service credential', () => {
    /** Mints a key over the cookie, the way the console does. */
    async function mintKey(
      cookie: string,
    ): Promise<{ id: string; key: string }> {
      const created = await request(server)
        .post('/users/me/api-keys')
        .set('Cookie', cookie)
        .send({ name: 'ci-key' });
      expect(created.status).toBe(201);
      return created.body as { id: string; key: string };
    }

    /**
     * better-auth's untouched default is ten requests per rolling day, and
     * its window only reopens after an idle gap, so the eleventh call is where
     * a steadily driven key died — a full day from its next chance.
     *
     * Eleven is the whole point of the number; ten used to pass.
     */
    it('serves more than the ten requests a day better-auth defaults to', async () => {
      const { cookie, id } = await signUp(server);
      const { key } = await mintKey(cookie);

      for (let attempt = 1; attempt <= 11; attempt += 1) {
        const res = await request(server)
          .get('/users/me')
          .set('x-api-key', key);
        expect([attempt, res.status]).toEqual([attempt, 200]);
        expect(res.body).toMatchObject({ id });
      }
    });

    /** The row itself must say so, since the console publishes these fields. */
    it('mints keys that are not rate limited', async () => {
      const { cookie } = await signUp(server);
      await mintKey(cookie);

      const list = await request(server)
        .get('/users/me/api-keys')
        .set('Cookie', cookie);

      const [listed] = (
        list.body as { apiKeys: { rateLimitEnabled: boolean }[] }
      ).apiKeys;
      expect(listed.rateLimitEnabled).toBe(false);
    });

    /**
     * The same key that answered 200 on `/projects` answered 401 on the
     * account routes, because the handler forwarded the raw headers to
     * better-auth and better-auth had never heard of the key. The session
     * listing still answers a key; the key listing no longer does.
     */
    it('lists the account sessions with the key alone', async () => {
      const { cookie, id } = await signUp(server);
      const { key } = await mintKey(cookie);

      const sessions = await request(server)
        .get('/users/me/sessions')
        .set('x-api-key', key);
      expect(sessions.status).toBe(200);
      const rows = sessions.body as ListedSession[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.userId === id)).toBe(true);
      expect(rows.every((row) => !('token' in row))).toBe(true);
    });

    /**
     * The baseline the key-scope change leaves standing: a personal key keeps its owner's
     * whole authority on the REST surface. Only key management moved behind
     * the console session.
     */
    it('still authenticates a REST route as its owner', async () => {
      const { cookie } = await signUp(server);
      const { key } = await mintKey(cookie);

      const projects = await request(server)
        .get('/projects')
        .set('x-api-key', key);
      expect(projects.status).toBe(200);
    });

    /**
     * A key that can mint its own replacement cannot be revoked — the
     * holder rotates before the owner deletes. So creating, listing and
     * deleting keys needs the console session; the one delete a key may make
     * is of itself, so the refused delete here names a sibling, and
     * both keys are still there afterwards.
     */
    it('refuses to create, list or delete another key, naming the credential', async () => {
      const { cookie } = await signUp(server);
      const { id: keyId, key } = await mintKey(cookie);
      const { id: siblingId } = await mintKey(cookie);

      const refusals = [
        await request(server)
          .post('/users/me/api-keys')
          .set('x-api-key', key)
          .send({ name: 'successor' }),
        await request(server).get('/users/me/api-keys').set('x-api-key', key),
        await request(server)
          .delete(`/users/me/api-keys/${siblingId}`)
          .set('x-api-key', key),
      ];
      for (const res of refusals) {
        expect(res.status).toBe(403);
        expect((res.body as { message: string }).message).toMatch(
          /personal key cannot be used on this route/,
        );
      }

      const rows = await ctx.db
        .select({ id: schema.apikey.id })
        .from(schema.apikey);
      expect(rows.map((row) => row.id).sort()).toEqual(
        [keyId, siblingId].sort(),
      );
      const stillValid = await request(server)
        .get('/users/me')
        .set('x-api-key', key);
      expect(stillValid.status).toBe(200);
    });

    /**
     * `cloudgate logout` deletes the key it holds, and a key is all it
     * holds. So a key may delete itself — and once it has, it is an unknown
     * key like any other: a bare 401 whose body, and whose log lines, never
     * carry the value it was sent with. Its sibling is untouched.
     */
    it('deletes itself, and is then refused without its value in the answer or the logs', async () => {
      const { cookie } = await signUp(server);
      const { id: keyId, key } = await mintKey(cookie);
      const { id: siblingId, key: siblingKey } = await mintKey(cookie);

      const deleted = await request(server)
        .delete(`/users/me/api-keys/${keyId}`)
        .set('x-api-key', key);
      expect(deleted.status).toBe(200);

      const spies = [
        ...(['log', 'error', 'warn', 'debug', 'verbose'] as const).map(
          (level) => jest.spyOn(Logger.prototype, level),
        ),
        ...(['log', 'error', 'warn', 'info', 'debug'] as const).map((level) =>
          jest.spyOn(console, level),
        ),
      ];
      let refused: request.Response;
      try {
        refused = await request(server)
          .get('/users/me/whoami')
          .set('x-api-key', key);
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }
      expect(refused.status).toBe(401);
      expect(refused.text).not.toContain(key);
      const lines = spies.flatMap((spy) =>
        spy.mock.calls.map((call) => JSON.stringify(call)),
      );
      expect(lines.filter((line) => line.includes(key))).toEqual([]);

      const rows = await ctx.db
        .select({ id: schema.apikey.id })
        .from(schema.apikey);
      expect(rows).toEqual([{ id: siblingId }]);
      const sibling = await request(server)
        .get('/users/me')
        .set('x-api-key', siblingKey);
      expect(sibling.status).toBe(200);
    });

    /**
     * `cloudgate whoami` says when its key ends, and the key-scope change keeps the key
     * listing away from a key. So the whoami read answers about the calling
     * key and that key only — a sibling minted beside it is never named. The
     * expected end is read from the row, not from the route under test.
     */
    it('tells a key its own email, Organization and end, and nothing of a sibling key', async () => {
      const { cookie, id: userId } = await signUp(server);
      const created = await request(server)
        .post('/users/me/api-keys')
        .set('Cookie', cookie)
        .send({ name: 'ci-key', expiresIn: 90 * 24 * 60 * 60 });
      expect(created.status).toBe(201);
      const { id: keyId, key } = created.body as { id: string; key: string };
      const { id: siblingId } = await mintKey(cookie);

      const res = await request(server)
        .get('/users/me/whoami')
        .set('x-api-key', key);

      expect(res.status).toBe(200);
      const [membership] = await ctx.db
        .select({
          id: schema.organization.id,
          name: schema.organization.name,
        })
        .from(schema.member)
        .innerJoin(
          schema.organization,
          eq(schema.organization.id, schema.member.organizationId),
        )
        .where(eq(schema.member.userId, userId));
      const [row] = await ctx.db
        .select({
          start: schema.apikey.start,
          expiresAt: schema.apikey.expiresAt,
        })
        .from(schema.apikey)
        .where(eq(schema.apikey.id, keyId));
      expect(res.body).toEqual({
        email: signUpBody.email,
        organization: membership,
        key: {
          id: keyId,
          name: 'ci-key',
          start: row.start,
          expiresAt: row.expiresAt?.toISOString(),
        },
      });
      // The sibling is in the table and nowhere in the answer.
      expect(JSON.stringify(res.body)).not.toContain(siblingId);
    });

    it('tells a console session who it is, with no key', async () => {
      const { cookie } = await signUp(server);
      await mintKey(cookie);

      const res = await request(server)
        .get('/users/me/whoami')
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ email: signUpBody.email, key: null });
      expect(
        (res.body as { organization: { id: string } | null }).organization,
      ).not.toBeNull();
    });

    it('refuses the whoami read with 401 when no credentials are sent', async () => {
      const res = await request(server).get('/users/me/whoami');
      expect(res.status).toBe(401);
    });

    /**
     * A request may name the Organization it acts in with
     * `x-organization-id`, so a Folder link made in one Organization keeps
     * reaching it whatever the key owner's default is. Named for a member it
     * acts there; named for anyone else it is refused with a code the CLI can
     * branch on; left out, the key acts in the owner's default Organization as
     * it always did.
     */
    describe('x-organization-id', () => {
      async function ownerAndMallory() {
        const { cookie } = await signUp(server);
        const ownerCookie = (cookie as unknown as string[])
          .map((entry) => entry.split(';')[0])
          .join('; ');
        const mallory = await secondOrganizationOwner(
          server,
          ctx.db,
          ownerCookie,
        );
        return { ownerCookie, mallory };
      }

      it('acts in the default Organization when the header is left out', async () => {
        const { ownerCookie, mallory } = await ownerAndMallory();
        const { key } = await mintKey(ownerCookie);

        const res = await request(server)
          .get('/users/me/whoami')
          .set('x-api-key', key);

        expect(res.status).toBe(200);
        expect(
          (res.body as { organization: { id: string } }).organization.id,
        ).toBe(mallory.instanceOrganizationId);
      });

      it('acts in the Organization the header names when the key owner is a member there', async () => {
        const { ownerCookie, mallory } = await ownerAndMallory();
        const { key } = await mintKey(ownerCookie);

        const res = await request(server)
          .get('/users/me/whoami')
          .set('x-api-key', key)
          .set('x-organization-id', mallory.organizationId);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          organization: { id: mallory.organizationId, name: 'Second Org' },
        });
      });

      it('refuses a key whose owner is not a member of the Organization the header names, with a code', async () => {
        const { mallory } = await ownerAndMallory();
        const { key } = await mintKey(mallory.cookie);

        const res = await request(server)
          .get('/users/me/whoami')
          .set('x-api-key', key)
          .set('x-organization-id', mallory.instanceOrganizationId);

        expect(res.status).toBe(403);
        const body = res.body as { code: string; message: string };
        expect(body.code).toBe('NOT_ORGANIZATION_MEMBER');
        expect(body.message).toContain(mallory.instanceOrganizationId);
        // Nothing of the Organization refused is read back.
        expect(JSON.stringify(res.body)).not.toContain('email');
      });
    });

    /**
     * better-auth's own key routes are closed, not merely unused. The
     * set is read off the running instance — every `/api-key/*` endpoint the
     * installed plugin routes over HTTP — so a better-auth upgrade that adds
     * or renames one reds here instead of opening a second way to mint a key.
     * Asked with the key *and* with the cookie, because the plugin's session
     * hook would otherwise let either one through.
     */
    it("closes every HTTP route of better-auth's api-key plugin", async () => {
      const { cookie } = await signUp(server);
      const { key } = await mintKey(cookie);

      const routes = routedAuthEndpoints(ctx.app).filter(({ path }) =>
        path.startsWith('/api-key/'),
      );
      expect(routes.map(({ path }) => path).sort()).toEqual([
        '/api-key/create',
        '/api-key/delete',
        '/api-key/get',
        '/api-key/list',
        '/api-key/update',
      ]);

      for (const { path, methods } of routes) {
        for (const method of methods) {
          for (const [header, value] of [
            ['x-api-key', key],
            ['Cookie', cookie],
          ]) {
            const call =
              method === 'GET'
                ? request(server).get(`/api/auth${path}`)
                : request(server).post(`/api/auth${path}`).send({});
            const res = await call.set(header, value);
            expect([path, method, header, res.status]).toEqual([
              path,
              method,
              header,
              404,
            ]);
          }
        }
      }
      expect(await ctx.db.select().from(schema.apikey)).toHaveLength(1);
    });

    /**
     * The other half of the fix: where better-auth genuinely will not accept
     * a non-interactive credential, the refusal says which credential and why
     * rather than repeating the 401 that made this look broken.
     */
    it.each([
      ['/users/me/sessions/revoke', { sessionId: 'whatever' }],
      ['/users/me/2fa/enable', { password: signUpBody.password }],
      ['/users/me/2fa/disable', { password: signUpBody.password }],
      ['/users/me/2fa/verify', { code: '000000' }],
    ])(
      'refuses %s with a message naming the credential',
      async (path, body) => {
        const { cookie } = await signUp(server);
        const { key } = await mintKey(cookie);

        const res = await request(server)
          .post(path)
          .set('x-api-key', key)
          .send(body);

        expect(res.status).toBe(403);
        expect((res.body as { message: string }).message).toMatch(
          /personal key cannot be used on this route/,
        );
      },
    );

    /**
     * The other half: a key better-auth turns down for a reason it can name
     * must not answer the way an unknown key does. `enabled = false` is set on
     * the row because no route exposes it — which is itself part of why the
     * ten-a-day limit was unreachable.
     */
    it('names a disabled key instead of answering an anonymous 401', async () => {
      const { cookie } = await signUp(server);
      const { id: keyId, key } = await mintKey(cookie);

      await ctx.db
        .update(schema.apikey)
        .set({ enabled: false })
        .where(eq(schema.apikey.id, keyId));

      const res = await request(server).get('/users/me').set('x-api-key', key);

      expect(res.status).toBe(401);
      expect((res.body as { message: string }).message).toBe(
        'API key is disabled',
      );
    });

    /** A key that matches nothing stays deliberately indistinguishable. */
    it('says nothing at all about a key it does not recognise', async () => {
      const res = await request(server)
        .get('/users/me')
        .set('x-api-key', 'definitely-not-a-valid-key');

      expect(res.status).toBe(401);
      expect((res.body as { message: string }).message).toBe('Unauthorized');
    });
  });
});
