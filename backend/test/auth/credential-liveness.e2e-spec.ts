import { UnauthorizedException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { apikey, session, user } from '../../src/auth/auth.schema';
import { AuthService } from '../../src/auth/auth.service';
import type { CredentialHandle } from '../../src/auth/auth.service';
import { member } from '../../src/organizations/organizations.schema';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(120_000);

/**
 * `AuthService.assertCredentialAlive` — the sibling of `validateRequest`, asked
 * of a row instead of a header (ADR-0012).
 *
 * A WebSocket has to keep asking "is this caller still who they were" for hours
 * after its upgrade request is gone, and it deliberately keeps no credential to
 * ask with: only `session.id` or `apikey.id`, because a live cookie held in a
 * gateway's closure for the life of a socket is the leak it already was once. The
 * cost of that inversion is this second implementation, which can drift from the
 * first if better-auth adds a condition to session validity — so these tests
 * name each condition it does check, one at a time, against real rows written by
 * the real sign-up and api-key routes.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

describe('Credential liveness (e2e)', () => {
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

  /**
   * A signed-up caller, and the handle a socket of theirs would hold — taken
   * from `validateRequest` rather than read off the table, because the handle
   * being the one the live path produces is half of what is under test.
   */
  async function signIn(): Promise<{
    cookie: string;
    userId: string;
    organizationId: string;
    credential: CredentialHandle;
  }> {
    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    const cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const validated = await auth.validateRequest({ cookie });
    expect(validated.credential).toBeDefined();
    return {
      cookie,
      userId: (res.body as { user: { id: string } }).user.id,
      organizationId: validated.session?.activeOrganizationId as string,
      credential: validated.credential as CredentialHandle,
    };
  }

  /** An api key of the signed-in caller's, and the handle its socket would hold. */
  async function createApiKey(
    cookie: string,
  ): Promise<{ credential: CredentialHandle; apiKeyId: string }> {
    const created = await request(httpServer)
      .post('/users/me/api-keys')
      .set('Cookie', cookie)
      .send({ name: 'ci-key' });
    expect(created.status).toBe(201);
    const { key } = created.body as { key: string };

    const validated = await auth.validateRequest({ 'x-api-key': key });
    const credential = validated.credential;
    // Narrowed rather than asserted: the handle a key caller gets has to be the
    // key's own id, and a session handle here would mean the socket would be
    // re-reading the wrong table for the rest of its life.
    if (credential?.kind !== 'apiKey') {
      throw new Error(
        `expected an api-key handle, got ${JSON.stringify(credential)}`,
      );
    }
    return { credential, apiKeyId: credential.apiKeyId };
  }

  describe('a session', () => {
    it('is alive while its row is alive and it acts where it acted', async () => {
      const caller = await signIn();

      await expect(
        auth.assertCredentialAlive(caller.credential, caller.organizationId),
      ).resolves.toBeUndefined();
    });

    it('is revoked when its row is gone', async () => {
      const caller = await signIn();
      await ctx.db.delete(session);

      await expect(
        auth.assertCredentialAlive(caller.credential, caller.organizationId),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('is expired when its own expiry has passed', async () => {
      const caller = await signIn();
      await ctx.db
        .update(session)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(session.userId, caller.userId));

      await expect(
        auth.assertCredentialAlive(caller.credential, caller.organizationId),
      ).rejects.toThrow('The session has expired');
    });

    /**
     * The vector no permission check can see: the caller is still entitled to
     * everything, in a different Organization. A stream authorized in the one
     * they have left is not re-scoped to follow them.
     */
    it('is refused once it acts in another organization', async () => {
      const caller = await signIn();
      const second = await createOrganization(
        httpServer,
        ctx.db,
        caller.cookie,
        { name: 'Second Org' },
      );
      expect(second.status).toBe(201);
      await ctx.db
        .update(session)
        .set({ activeOrganizationId: (second.body as { id: string }).id })
        .where(eq(session.userId, caller.userId));

      await expect(
        auth.assertCredentialAlive(caller.credential, caller.organizationId),
      ).rejects.toThrow('The session is acting in a different organization');
    });

    /**
     * Deliberately *not* a refusal here. The organization a session acts in is
     * resolved through the member row, the way `validateRequest` resolves it, so
     * a removed Member would otherwise be turned down by the credential check —
     * and "removed from the Organization" belongs to the entitlement check,
     * which is the thing that knows what they were reaching for.
     */
    it('survives its member row being deleted, for the entitlement check to catch', async () => {
      const caller = await signIn();
      await ctx.db.delete(member);

      await expect(
        auth.assertCredentialAlive(caller.credential, caller.organizationId),
      ).resolves.toBeUndefined();
    });

    /**
     * The condition this path used to delegate and nothing delivered.
     * `assertSessionAlive` said a banned user needed no case of its own, because
     * `/admin/ban-user` deletes their sessions — but that route answers 403 to
     * every account this build can create, so a socket held by a banned account
     * simply kept renewing. Banned by column update, which is the only mechanism
     * the build has and the one both api-key cases beside this already use.
     */
    it('is dead once the account it belongs to is banned', async () => {
      const caller = await signIn();
      await ctx.db
        .update(user)
        .set({ banned: true })
        .where(eq(user.id, caller.userId));

      await expect(
        auth.assertCredentialAlive(caller.credential, caller.organizationId),
      ).rejects.toThrow('This account is banned');
    });

    /**
     * `banExpires`, which nothing in the tree read before the fix. The plugin
     * clears an elapsed ban only inside its `session.create.before` hook, so the
     * row still says `banned: true` here and the predicate is the only thing
     * that lets the credential back in — otherwise a 24-hour ban is permanent
     * for every credential that outlives it.
     */
    it('is alive again once a temporary ban has passed', async () => {
      const caller = await signIn();
      await ctx.db
        .update(user)
        .set({ banned: true, banExpires: new Date(Date.now() - 1_000) })
        .where(eq(user.id, caller.userId));

      await expect(
        auth.assertCredentialAlive(caller.credential, caller.organizationId),
      ).resolves.toBeUndefined();
    });
  });

  describe('an api key', () => {
    it('is alive while its row is enabled and unexpired', async () => {
      const caller = await signIn();
      const { credential } = await createApiKey(caller.cookie);

      await expect(
        auth.assertCredentialAlive(credential, caller.organizationId),
      ).resolves.toBeUndefined();
    });

    it('is dead once its row is gone', async () => {
      const caller = await signIn();
      const { credential } = await createApiKey(caller.cookie);
      await ctx.db.delete(apikey);

      await expect(
        auth.assertCredentialAlive(credential, caller.organizationId),
      ).rejects.toThrow('The API key has been deleted');
    });

    it('is dead once an operator disables it', async () => {
      const caller = await signIn();
      const { credential, apiKeyId } = await createApiKey(caller.cookie);
      await ctx.db
        .update(apikey)
        .set({ enabled: false })
        .where(eq(apikey.id, apiKeyId));

      await expect(
        auth.assertCredentialAlive(credential, caller.organizationId),
      ).rejects.toThrow('The API key is disabled');
    });

    it('is dead once its expiry passes', async () => {
      const caller = await signIn();
      const { credential, apiKeyId } = await createApiKey(caller.cookie);
      await ctx.db
        .update(apikey)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(apikey.id, apiKeyId));

      await expect(
        auth.assertCredentialAlive(credential, caller.organizationId),
      ).rejects.toThrow('The API key has expired');
    });

    /**
     * The twin of the session case above, and it used to be the only one. The
     * reason given for the asymmetry — banning deletes a user's sessions, so a
     * cookie socket is caught as an ordinary revocation — was false: the
     * deletion lives in `/admin/ban-user`, which no account on this build can
     * reach. Both paths now ask the columns, and the two sentences differ
     * only because this one names the key's owner.
     */
    it('is dead once the account it belongs to is banned', async () => {
      const caller = await signIn();
      const { credential } = await createApiKey(caller.cookie);
      await ctx.db
        .update(user)
        .set({ banned: true })
        .where(eq(user.id, caller.userId));

      await expect(
        auth.assertCredentialAlive(credential, caller.organizationId),
      ).rejects.toThrow('The account this API key belongs to is banned');
    });

    /**
     * The same asymmetry the session path draws, and for the same reason: a
     * membership that is gone is the entitlement check's refusal to make, not
     * the credential's — it is the half that knows which Service was being
     * reached for and can say so in the journal.
     */
    it('survives its owner losing their membership, for the entitlement check to catch', async () => {
      const caller = await signIn();
      const { credential } = await createApiKey(caller.cookie);
      await ctx.db.delete(member);

      await expect(
        auth.assertCredentialAlive(credential, caller.organizationId),
      ).resolves.toBeUndefined();
    });

    /** Acting somewhere else, though, is the credential's own answer. */
    it('is refused once its owner acts in another organization', async () => {
      const caller = await signIn();
      const { credential } = await createApiKey(caller.cookie);
      const second = await createOrganization(
        httpServer,
        ctx.db,
        caller.cookie,
        { name: 'Second Org' },
      );
      expect(second.status).toBe(201);
      // The synthetic session takes the owner's *default* membership, so the
      // second organization only becomes the one the key acts in once the
      // first membership is gone.
      await ctx.db
        .delete(member)
        .where(eq(member.organizationId, caller.organizationId));

      await expect(
        auth.assertCredentialAlive(credential, caller.organizationId),
      ).rejects.toThrow('The API key is acting in a different organization');
    });

    /**
     * A key whose request named its Organization in `x-organization-id`
     * acts there, so a log stream opened in a non-default Organization is not
     * "acting in a different organization" at its first renewal.
     */
    it('stays alive in a non-default Organization its request named', async () => {
      const caller = await signIn();
      const second = await createOrganization(
        httpServer,
        ctx.db,
        caller.cookie,
        { name: 'Second Org' },
      );
      expect(second.status).toBe(201);
      const secondId = (second.body as { id: string }).id;
      const created = await request(httpServer)
        .post('/users/me/api-keys')
        .set('Cookie', caller.cookie)
        .send({ name: 'ci-key' });
      const { key } = created.body as { key: string };

      const validated = await auth.validateRequest({
        'x-api-key': key,
        'x-organization-id': secondId,
      });
      expect(validated.session?.activeOrganizationId).toBe(secondId);

      await expect(
        auth.assertCredentialAlive(
          validated.credential as CredentialHandle,
          secondId,
        ),
      ).resolves.toBeUndefined();
    });
  });
});
