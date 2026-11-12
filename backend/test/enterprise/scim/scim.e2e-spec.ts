import type { IncomingHttpHeaders } from 'node:http';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { user } from '../../../src/auth/auth.schema';
import { LicenseService } from '../../../src/enterprise/license/license.service';
import { ScimService } from '../../../src/enterprise/scim/scim.service';
import {
  member as memberTable,
  organization,
} from '../../../src/organizations/organizations.schema';
import type { PermissionCtx } from '../../../src/rbac/permission.service';
import {
  signUpMember,
  createOrganization as postOrganization,
} from '../../utils/test-auth';
import { createTestApp, TestAppContext } from '../../utils/test-app';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** A SCIM `User` resource as an IdP would POST it. */
const scimUser = (email: string, overrides: Record<string, unknown> = {}) => ({
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
  userName: email,
  name: { givenName: 'Ada', familyName: 'Lovelace' },
  emails: [{ value: email, primary: true }],
  active: true,
  ...overrides,
});

const ctxFor = (userId: string, organizationId: string): PermissionCtx => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

async function signUp(
  server: App,
  body: { name: string; email: string; password: string },
): Promise<{ cookie: string; id: string }> {
  const res = await request(server).post('/api/auth/sign-up/email').send(body);
  expect(res.status).toBe(200);
  const { user } = res.body as { user: { id: string } };
  return { cookie: res.headers['set-cookie'], id: user.id };
}

async function createOrganization(
  server: App,
  db: TestAppContext['db'],
  cookie: string,
  name: string,
): Promise<string> {
  const res = await postOrganization(server, db, cookie, { name });
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

/** `ScimService.ensureEnterprise`'s two refusals, written out. */
const OWNER_OR_ADMIN_REFUSAL =
  'Only owners and admins can manage SCIM providers';
const LICENSE_REFUSAL = 'Valid enterprise license required';

/** The message an `AllExceptionsFilter` response carries. */
const refusal = (res: { body: unknown }): string =>
  (res.body as { message: string }).message;

async function activeOrganizationId(
  server: App,
  cookie: string,
): Promise<string> {
  const res = await request(server)
    .get('/organizations/active')
    .set('Cookie', cookie);
  expect(res.status).toBe(200);
  return (res.body as { id: string }).id;
}

describe('SCIM (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let scim: ScimService;

  let ownerCtx: PermissionCtx;
  let ownerCookie: string;
  let ownerHeaders: IncomingHttpHeaders;

  const license = {
    hasValidLicense: jest.fn<Promise<boolean>, [string]>(),
    hasAnyValidLicense: jest.fn<Promise<boolean>, []>(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: LicenseService, useValue: license }],
    });
    httpServer = ctx.app.getHttpServer() as App;
    scim = ctx.app.get(ScimService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    jest.clearAllMocks();
    license.hasValidLicense.mockResolvedValue(true);
    license.hasAnyValidLicense.mockResolvedValue(true);

    const session = await signUp(httpServer, owner);
    const organizationId = await activeOrganizationId(
      httpServer,
      session.cookie,
    );
    ownerCtx = ctxFor(session.id, organizationId);
    ownerCookie = session.cookie;
    ownerHeaders = { cookie: session.cookie };
  });

  /** The bearer token an IdP would be configured with. */
  async function scimToken(providerId = 'okta'): Promise<string> {
    const { scimToken } = await scim.generateToken(ownerCtx, ownerHeaders, {
      providerId,
    });
    return scimToken;
  }

  /** What an IdP's SCIM client does to provision someone. */
  const createScimUser = (
    token: string,
    email: string,
    overrides: Record<string, unknown> = {},
  ) =>
    request(httpServer)
      .post('/api/auth/scim/v2/Users')
      .set('Authorization', `Bearer ${token}`)
      .send(scimUser(email, overrides));

  /** The organization's roster, as the rest of the product reads it. */
  async function members(): Promise<
    Array<{ role: string; user: { email: string } }>
  > {
    const res = await request(httpServer)
      .get('/organizations/members')
      .set('Cookie', ownerCookie);
    expect(res.status).toBe(200);
    return (
      res.body as { members: Array<{ role: string; user: { email: string } }> }
    ).members;
  }

  const emails = async () => (await members()).map((m) => m.user.email).sort();

  /** Provisions someone and hands back the SCIM resource id (the user id). */
  async function provision(token: string, email: string): Promise<string> {
    const res = await createScimUser(token, email);
    expect(res.status).toBe(201);
    return (res.body as { id: string }).id;
  }

  /** The stored disabled state `active: false` maps onto. */
  async function disabledState(
    email: string,
  ): Promise<{ banned: boolean | null; banReason: string | null }> {
    const [row] = await ctx.db
      .select({ banned: user.banned, banReason: user.banReason })
      .from(user)
      .where(eq(user.email, email));
    return row;
  }

  describe('provider configuration', () => {
    it('issues a token for a new provider, which is then listed for the organization', async () => {
      const generated = await scim.generateToken(ownerCtx, ownerHeaders, {
        providerId: 'okta',
      });

      expect(generated.providerId).toBe('okta');
      expect(typeof generated.scimToken).toBe('string');
      expect(generated.scimToken.length).toBeGreaterThan(0);

      const listed = await scim.listProviders(ownerCtx);
      expect(listed).toEqual([
        {
          id: expect.any(String) as string,
          providerId: 'okta',
          organizationId: ownerCtx.session.activeOrganizationId,
          lastRefusedAddAt: null,
          lastRefusedAddEmail: null,
        },
      ]);
    });

    it('refuses a provider id that already exists, leaving the original row untouched', async () => {
      await scim.generateToken(ownerCtx, ownerHeaders, { providerId: 'okta' });
      const [before] = await scim.listProviders(ownerCtx);

      await expect(
        scim.generateToken(ownerCtx, ownerHeaders, { providerId: 'okta' }),
      ).rejects.toThrow('A SCIM provider with this ID already exists');

      // The plugin's own generate-token *replaces* a colliding row, silently
      // revoking a token an IdP is already provisioning with. Same row id means
      // that did not happen.
      expect(await scim.listProviders(ownerCtx)).toEqual([before]);
    });

    it('deletes a provider, freeing its id for a replacement', async () => {
      await scim.generateToken(ownerCtx, ownerHeaders, { providerId: 'okta' });

      await expect(scim.deleteProvider(ownerCtx, 'okta')).resolves.toEqual({
        success: true,
      });
      expect(await scim.listProviders(ownerCtx)).toEqual([]);

      await scim.generateToken(ownerCtx, ownerHeaders, { providerId: 'okta' });
      expect(await scim.listProviders(ownerCtx)).toHaveLength(1);
    });

    it('stores the token encrypted at rest while it keeps authenticating', async () => {
      const token = await scimToken();

      // Raw SQL bypasses the drizzle custom type, so this is the ciphertext.
      const raw = await ctx.db.execute<{ scim_token: string }>(
        sql`select scim_token from scim_provider`,
      );
      const stored = raw.rows[0].scim_token;
      expect(stored).not.toHaveLength(0);
      expect(token).not.toContain(stored);
      expect(Buffer.from(token, 'base64url').toString('utf8')).not.toContain(
        stored,
      );

      // And the round trip still works, so the plugin reads back the plaintext.
      expect((await createScimUser(token, 'ada@example.com')).status).toBe(201);
    });

    it('refuses to delete a provider that does not exist', async () => {
      await expect(scim.deleteProvider(ownerCtx, 'nope')).rejects.toThrow(
        'SCIM provider not found or you do not have permission to delete it',
      );
    });
  });

  describe('provisioning', () => {
    it('provisions a member into the provider organization from a SCIM create', async () => {
      const token = await scimToken();

      const res = await createScimUser(token, 'ada@example.com');

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        userName: 'ada@example.com',
        active: true,
      });

      const provisioned = (await members()).find(
        (m) => m.user.email === 'ada@example.com',
      );
      expect(provisioned).toMatchObject({
        role: 'member',
        user: { email: 'ada@example.com' },
      });
    });

    it('provisions a plain member, not a second owner with their own organization', async () => {
      const token = await scimToken();
      await createScimUser(token, 'ada@example.com');

      const roster = await members();
      expect(roster).toHaveLength(2);
      expect(roster.filter((m) => m.role === 'owner')).toHaveLength(1);
      // No organization was bootstrapped for them alongside the owner's.
      expect(await ctx.db.select().from(organization)).toHaveLength(1);
    });
  });

  describe('deprovisioning', () => {
    it('deactivates a member on a SCIM update with active false, keeping them on the roster', async () => {
      const token = await scimToken();
      const userId = await provision(token, 'ada@example.com');

      const res = await request(httpServer)
        .put(`/api/auth/scim/v2/Users/${userId}`)
        .set('Authorization', `Bearer ${token}`)
        .send(scimUser('ada@example.com', { active: false }));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ active: false });

      // Deactivation is a disabled state, not a removal — the admin plugin
      // stays registered precisely so `active: false` maps to the user's
      // `banned` flag.
      expect(await emails()).toEqual(['ada@example.com', owner.email]);
      expect(await disabledState('ada@example.com')).toEqual({
        banned: true,
        banReason: 'Deactivated via SCIM',
      });
    });

    it('reactivates a member on a SCIM patch with active true', async () => {
      const token = await scimToken();
      const userId = await provision(token, 'ada@example.com');
      await request(httpServer)
        .put(`/api/auth/scim/v2/Users/${userId}`)
        .set('Authorization', `Bearer ${token}`)
        .send(scimUser('ada@example.com', { active: false }));

      const res = await request(httpServer)
        .patch(`/api/auth/scim/v2/Users/${userId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', path: 'active', value: true }],
        });

      expect(res.status).toBe(204);
      expect(await disabledState('ada@example.com')).toEqual({
        banned: false,
        banReason: null,
      });
    });

    /**
     * The roster the console renders says so, and says it was the directory
     * — before, a deactivated member was listed exactly like an active
     * one, so an owner could not see that a deprovision had landed. And a
     * reactivation takes the mark away again.
     */
    it('marks a deactivated member on the roster as the directory’s doing, and unmarks a reactivated one', async () => {
      const token = await scimToken();
      const userId = await provision(token, 'ada@example.com');
      const deactivationOf = async () => {
        const res = await request(httpServer)
          .get('/organizations/members')
          .set('Cookie', ownerCookie);
        expect(res.status).toBe(200);
        return (
          res.body as {
            members: Array<{ userId: string; deactivation: unknown }>;
          }
        ).members.find((m) => m.userId === userId)!.deactivation;
      };
      const setActive = (value: boolean) =>
        request(httpServer)
          .patch(`/api/auth/scim/v2/Users/${userId}`)
          .set('Authorization', `Bearer ${token}`)
          .send({
            schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
            Operations: [{ op: 'replace', path: 'active', value }],
          });

      expect(await deactivationOf()).toBeNull();

      expect((await setActive(false)).status).toBe(204);
      expect(await deactivationOf()).toEqual({
        byDirectory: true,
        reason: 'Deactivated via SCIM',
        expiresAt: null,
      });

      expect((await setActive(true)).status).toBe(204);
      expect(await deactivationOf()).toBeNull();
    });

    it('removes a member from the organization on a SCIM delete', async () => {
      const token = await scimToken();
      const userId = await provision(token, 'ada@example.com');

      const res = await request(httpServer)
        .delete(`/api/auth/scim/v2/Users/${userId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(204);
      expect(await emails()).toEqual([owner.email]);
    });

    it('re-provisions a deleted user: create, deactivate, delete, create again', async () => {
      const token = await scimToken();
      const userId = await provision(token, 'ada@example.com');
      const deactivated = await request(httpServer)
        .patch(`/api/auth/scim/v2/Users/${userId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', path: 'active', value: false }],
        });
      expect(deactivated.status).toBe(204);
      const deleted = await request(httpServer)
        .delete(`/api/auth/scim/v2/Users/${userId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(deleted.status).toBe(204);
      const gone = await request(httpServer)
        .get(`/api/auth/scim/v2/Users/${userId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(gone.status).toBe(404);

      const recreated = await createScimUser(token, 'ada@example.com');

      expect(recreated.status).toBe(201);
      expect(recreated.body).toMatchObject({
        userName: 'ada@example.com',
        active: true,
      });
      expect(await emails()).toEqual(['ada@example.com', owner.email]);
      expect(await disabledState('ada@example.com')).toEqual({
        banned: false,
        banReason: null,
      });
      // The tombstone is revived rather than replaced, so the id the IdP held
      // before is the one GET now answers for again.
      expect((recreated.body as { id: string }).id).toBe(userId);
      const found = await request(httpServer)
        .get(`/api/auth/scim/v2/Users/${userId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(found.status).toBe(200);
      expect(found.body).toMatchObject({ active: true });
    });

    it('re-provisions a user deleted while still active', async () => {
      const token = await scimToken();
      const userId = await provision(token, 'ada@example.com');
      await request(httpServer)
        .delete(`/api/auth/scim/v2/Users/${userId}`)
        .set('Authorization', `Bearer ${token}`);
      // A delete alone does not ban: only `active: false` does.
      expect((await disabledState('ada@example.com')).banned).toBeFalsy();

      const recreated = await createScimUser(token, 'ada@example.com');

      expect(recreated.status).toBe(201);
      expect(recreated.body).toMatchObject({ id: userId, active: true });
      expect(await emails()).toEqual(['ada@example.com', owner.email]);
    });

    it('re-provisions a deleted user as deactivated when the create says so', async () => {
      const token = await scimToken();
      const userId = await provision(token, 'ada@example.com');
      await request(httpServer)
        .delete(`/api/auth/scim/v2/Users/${userId}`)
        .set('Authorization', `Bearer ${token}`);

      const recreated = await createScimUser(token, 'ada@example.com', {
        active: false,
      });

      expect(recreated.status).toBe(201);
      expect(recreated.body).toMatchObject({ active: false });
      expect(await disabledState('ada@example.com')).toEqual({
        banned: true,
        banReason: 'Deactivated via SCIM',
      });
    });

    it('still refuses a create for an address that belongs to a person who can sign in', async () => {
      const token = await scimToken();
      // Removed from the organization, so the only thing left is their own
      // password — which is still theirs, not the provider's to take.
      const invited = await signUpMember(httpServer, ownerCookie, {
        email: 'ada@example.com',
      });
      await ctx.db
        .delete(memberTable)
        .where(eq(memberTable.userId, invited.id));

      const res = await createScimUser(token, 'ada@example.com');

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ scimType: 'uniqueness' });
      expect(await emails()).toEqual([owner.email]);
    });

    it('does not lift a ban SCIM did not put there', async () => {
      const token = await scimToken();
      const userId = await provision(token, 'ada@example.com');
      await request(httpServer)
        .delete(`/api/auth/scim/v2/Users/${userId}`)
        .set('Authorization', `Bearer ${token}`);
      await ctx.db
        .update(user)
        .set({ banned: true, banReason: 'Banned by an owner' })
        .where(eq(user.id, userId));

      const res = await createScimUser(token, 'ada@example.com');

      expect(res.status).toBe(409);
      expect(await disabledState('ada@example.com')).toEqual({
        banned: true,
        banReason: 'Banned by an owner',
      });
      expect(await emails()).toEqual([owner.email]);
    });

    it('does not revive an Agent removed from its Organization', async () => {
      const token = await scimToken();
      const created = await request(httpServer)
        .post('/agents')
        .set('Cookie', ownerCookie)
        .send({ name: 'deploy-bot' });
      expect(created.status).toBe(201);
      const agentId = (created.body as { agent: { id: string } }).agent.id;
      // Removed as a member rather than deleted: no account and no membership,
      // which is exactly the shape a SCIM delete leaves (ADR-0022).
      await ctx.db.delete(memberTable).where(eq(memberTable.userId, agentId));
      const [agent] = await ctx.db
        .select({ email: user.email })
        .from(user)
        .where(eq(user.id, agentId));

      const res = await createScimUser(token, agent.email);

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ scimType: 'uniqueness' });
      expect(await emails()).toEqual([owner.email]);
      const [after] = await ctx.db
        .select({ kind: user.kind })
        .from(user)
        .where(eq(user.id, agentId));
      expect(after.kind).toBe('agent');
    });

    it('refuses to touch a user the provider never provisioned', async () => {
      const token = await scimToken();
      const stranger = await ctx.db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, owner.email));

      const res = await request(httpServer)
        .delete(`/api/auth/scim/v2/Users/${stranger[0].id}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(await emails()).toEqual([owner.email]);
    });
  });

  describe('SCIM media type', () => {
    /** RFC 7644 §3.1's media type, which is what a real IdP sends. */
    const SCIM_JSON = 'application/scim+json';
    const SCIM_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';

    it('provisions from a create sent as application/scim+json', async () => {
      const token = await scimToken();

      const res = await request(httpServer)
        .post('/api/auth/scim/v2/Users')
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', SCIM_JSON)
        .send(JSON.stringify(scimUser('ada@example.com')));

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ userName: 'ada@example.com' });
      expect(await emails()).toEqual(['ada@example.com', owner.email]);
    });

    it('applies a PUT, a PATCH and a DELETE sent as application/scim+json', async () => {
      const token = await scimToken();
      const userId = await provision(token, 'ada@example.com');

      const put = await request(httpServer)
        .put(`/api/auth/scim/v2/Users/${userId}`)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', SCIM_JSON)
        .send(JSON.stringify(scimUser('ada@example.com', { active: false })));
      expect(put.status).toBe(200);
      expect(await disabledState('ada@example.com')).toMatchObject({
        banned: true,
      });

      const patch = await request(httpServer)
        .patch(`/api/auth/scim/v2/Users/${userId}`)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', SCIM_JSON)
        .send(
          JSON.stringify({
            schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
            Operations: [{ op: 'replace', path: 'active', value: true }],
          }),
        );
      expect(patch.status).toBe(204);
      expect(await disabledState('ada@example.com')).toMatchObject({
        banned: false,
      });

      const remove = await request(httpServer)
        .delete(`/api/auth/scim/v2/Users/${userId}`)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', SCIM_JSON);
      expect(remove.status).toBe(204);
      expect(await emails()).toEqual([owner.email]);
    });

    it('answers a SCIM body that is not JSON in the SCIM error schema', async () => {
      const token = await scimToken();

      const res = await request(httpServer)
        .post('/api/auth/scim/v2/Users')
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', SCIM_JSON)
        .send('{"userName":');

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        schemas: [SCIM_ERROR],
        status: '400',
        scimType: 'invalidSyntax',
      });
      expect(await emails()).toEqual([owner.email]);
    });

    it('answers a SCIM body that fails validation in the SCIM error schema, in either media type', async () => {
      const token = await scimToken();

      // better-call refuses a body missing `userName` before the plugin runs,
      // in its own `VALIDATION_ERROR` shape — whatever the media type.
      for (const type of [SCIM_JSON, 'application/json']) {
        const res = await request(httpServer)
          .post('/api/auth/scim/v2/Users')
          .set('Authorization', `Bearer ${token}`)
          .set('Content-Type', type)
          .send(JSON.stringify({ schemas: scimUser('x').schemas }));

        expect({ type, status: res.status, body: res.body as unknown }).toEqual(
          {
            type,
            status: 400,
            body: expect.objectContaining({
              schemas: [SCIM_ERROR],
              status: '400',
              scimType: 'invalidValue',
            }) as unknown,
          },
        );
      }
      expect(await emails()).toEqual([owner.email]);
    });

    it('answers in the SCIM media type', async () => {
      const token = await scimToken();

      const created = await createScimUser(token, 'ada@example.com');
      const refused = await createScimUser(token, 'ada@example.com');

      expect(created.status).toBe(201);
      expect(created.headers['content-type']).toMatch(
        /^application\/scim\+json/,
      );
      expect(refused.status).toBe(409);
      expect(refused.headers['content-type']).toMatch(
        /^application\/scim\+json/,
      );
    });
  });

  describe('token authentication', () => {
    it('refuses a SCIM request with no bearer token', async () => {
      await scimToken();

      const res = await request(httpServer)
        .post('/api/auth/scim/v2/Users')
        .send(scimUser('ada@example.com'));

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ detail: 'SCIM token is required' });
      expect(await emails()).toEqual([owner.email]);
    });

    it('refuses a SCIM request with a token that is not one it issued', async () => {
      await scimToken();

      const res = await request(httpServer)
        .post('/api/auth/scim/v2/Users')
        .set(
          'Authorization',
          `Bearer ${Buffer.from('forged:okta').toString('base64url')}`,
        )
        .send(scimUser('ada@example.com'));

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ detail: 'Invalid SCIM token' });
      expect(await emails()).toEqual([owner.email]);
    });

    it('stops honouring a token once its provider is deleted', async () => {
      const token = await scimToken();
      await provision(token, 'ada@example.com');

      await scim.deleteProvider(ownerCtx, 'okta');

      const res = await createScimUser(token, 'alan@example.com');
      expect(res.status).toBe(401);
      expect(await emails()).toEqual(['ada@example.com', owner.email]);
    });

    it('scopes a token to its own organization', async () => {
      const token = await scimToken();
      const otherOrgId = await createOrganization(
        httpServer,
        ctx.db,
        ownerCookie,
        'Other Org',
      );
      const otherCtx = ctxFor(ownerCtx.user.id, otherOrgId);
      await scim.generateToken(otherCtx, ownerHeaders, {
        providerId: 'other-okta',
      });

      await provision(token, 'ada@example.com');

      // The provisioned member landed in the token's organization only.
      expect(await scim.listProviders(otherCtx)).toEqual([
        expect.objectContaining({ providerId: 'other-okta' }),
      ]);
      expect(await emails()).toEqual(['ada@example.com', owner.email]);
      const otherRoster = await ctx.db
        .select({ role: memberTable.role })
        .from(memberTable)
        .where(eq(memberTable.organizationId, otherOrgId));
      expect(otherRoster).toEqual([{ role: 'owner' }]);
    });
  });

  describe('enterprise gate', () => {
    it('refuses provider management to a plain member, storing nothing', async () => {
      const memberSession = await signUpMember(httpServer, ownerCookie);
      const memberCtx = ctxFor(
        memberSession.id,
        ownerCtx.session.activeOrganizationId,
      );
      await scim.generateToken(ownerCtx, ownerHeaders, { providerId: 'okta' });
      const before = await scim.listProviders(ownerCtx);

      await expect(
        scim.generateToken(
          memberCtx,
          { cookie: memberSession.cookie },
          { providerId: 'entra' },
        ),
      ).rejects.toThrow('Only owners and admins can manage SCIM providers');
      await expect(scim.listProviders(memberCtx)).rejects.toThrow(
        'Only owners and admins can manage SCIM providers',
      );
      await expect(scim.deleteProvider(memberCtx, 'okta')).rejects.toThrow(
        'Only owners and admins can manage SCIM providers',
      );

      expect(await scim.listProviders(ownerCtx)).toEqual(before);
    });

    it('refuses issuing a token without a valid licence, and still lists and deletes providers', async () => {
      await scim.generateToken(ownerCtx, ownerHeaders, { providerId: 'okta' });
      const before = await scim.listProviders(ownerCtx);
      license.hasValidLicense.mockResolvedValue(false);

      await expect(
        scim.generateToken(ownerCtx, ownerHeaders, { providerId: 'entra' }),
      ).rejects.toThrow('Valid enterprise license required');
      // Kept settings stay readable, and removing is always allowed.
      expect(await scim.listProviders(ownerCtx)).toEqual(before);
      await expect(scim.deleteProvider(ownerCtx, 'okta')).resolves.toEqual({
        success: true,
      });
      expect(await scim.listProviders(ownerCtx)).toEqual([]);
    });

    it("does not expose the plugin's own management writes", async () => {
      const generate = await request(httpServer)
        .post('/api/auth/scim/generate-token')
        .set('Cookie', ownerCookie)
        .send({ providerId: 'okta' });
      expect(generate.status).toBe(404);

      const remove = await request(httpServer)
        .post('/api/auth/scim/delete-provider-connection')
        .set('Cookie', ownerCookie)
        .send({ providerId: 'okta' });
      expect(remove.status).toBe(404);

      expect(await scim.listProviders(ownerCtx)).toEqual([]);
    });
  });

  /**
   * Below the paid features SCIM refuses the pushes that add or widen access
   * and accepts the ones that take it away, so offboarding in the IdP keeps
   * working (ADR-0054). This used to be the other way round: a lapsed
   * licence stopped only token issuance, and an existing token kept adding.
   */
  describe('pushes without the paid features', () => {
    const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
    const ADD_REFUSED = {
      schemas: [SCIM_ERROR_SCHEMA],
      status: '403',
      detail:
        'Adding members through SCIM needs a valid enterprise license. Deactivations and deletions are still accepted',
    };

    const setActive = (token: string, userId: string, value: unknown) =>
      request(httpServer)
        .patch(`/api/auth/scim/v2/Users/${userId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', path: 'active', value }],
        });

    const put = (token: string, userId: string, body: object) =>
      request(httpServer)
        .put(`/api/auth/scim/v2/Users/${userId}`)
        .set('Authorization', `Bearer ${token}`)
        .send(body);

    async function lastRefusedAdd() {
      const [provider] = await scim.listProviders(ownerCtx);
      return {
        at: provider.lastRefusedAddAt,
        email: provider.lastRefusedAddEmail,
      };
    }

    it('refuses a create in the SCIM error schema, adding nobody, and stores it as the last refused add', async () => {
      const token = await scimToken();
      license.hasValidLicense.mockResolvedValue(false);
      const before = Date.now();

      const res = await createScimUser(token, 'Ada@Example.com', {
        userName: 'ada@example.com',
      });

      expect(res.status).toBe(403);
      expect(res.headers['content-type']).toMatch(/^application\/scim\+json/);
      expect(res.body).toEqual(ADD_REFUSED);
      expect(await emails()).toEqual([owner.email]);
      const [created] = await ctx.db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, 'ada@example.com'));
      expect(created).toBeUndefined();

      const refused = await lastRefusedAdd();
      expect(refused.email).toBe('ada@example.com');
      expect(refused.at!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    });

    it('keeps the newest refused add', async () => {
      const token = await scimToken();
      license.hasValidLicense.mockResolvedValue(false);

      await createScimUser(token, 'ada@example.com');
      const first = await lastRefusedAdd();
      await createScimUser(token, 'alan@example.com');
      const second = await lastRefusedAdd();

      expect(second.email).toBe('alan@example.com');
      expect(second.at!.getTime()).toBeGreaterThanOrEqual(first.at!.getTime());
    });

    it('refuses reactivating a deactivated member by PATCH or PUT, leaving them deactivated', async () => {
      const token = await scimToken();
      const userId = await provision(token, 'ada@example.com');
      expect((await setActive(token, userId, false)).status).toBe(204);
      license.hasValidLicense.mockResolvedValue(false);

      const patched = await setActive(token, userId, true);
      expect([patched.status, patched.body]).toEqual([403, ADD_REFUSED]);
      const putted = await put(token, userId, scimUser('ada@example.com'));
      expect([putted.status, putted.body]).toEqual([403, ADD_REFUSED]);
      // `active` nested in a path-less value is the same reactivation.
      const nested = await request(httpServer)
        .patch(`/api/auth/scim/v2/Users/${userId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'Replace', value: { active: true } }],
        });
      expect(nested.status).toBe(403);

      expect(await disabledState('ada@example.com')).toEqual({
        banned: true,
        banReason: 'Deactivated via SCIM',
      });
      expect((await lastRefusedAdd()).email).toBe('ada@example.com');
    });

    it('accepts a deactivation, a rename of an active member and a delete', async () => {
      const token = await scimToken();
      const ada = await provision(token, 'ada@example.com');
      const alan = await provision(token, 'alan@example.com');
      license.hasValidLicense.mockResolvedValue(false);

      // An IdP's routine full PUT says `active: true` of someone already
      // active; it widens nothing, so it goes through.
      const renamed = await put(
        token,
        ada,
        scimUser('ada@example.com', { name: { formatted: 'Ada King' } }),
      );
      expect(renamed.status).toBe(200);
      expect(renamed.body).toMatchObject({ active: true });

      expect((await setActive(token, ada, false)).status).toBe(204);
      expect(await disabledState('ada@example.com')).toEqual({
        banned: true,
        banReason: 'Deactivated via SCIM',
      });
      const deactivatedByPut = await put(
        token,
        alan,
        scimUser('alan@example.com', { active: false }),
      );
      expect(deactivatedByPut.status).toBe(200);

      const deleted = await request(httpServer)
        .delete(`/api/auth/scim/v2/Users/${ada}`)
        .set('Authorization', `Bearer ${token}`);
      expect(deleted.status).toBe(204);
      expect(await emails()).toEqual(['alan@example.com', owner.email]);

      expect(await lastRefusedAdd()).toEqual({ at: null, email: null });
    });

    it('keeps members SCIM already made as members', async () => {
      const token = await scimToken();
      await provision(token, 'ada@example.com');
      license.hasValidLicense.mockResolvedValue(false);

      const ada = (await members()).find(
        (m) => m.user.email === 'ada@example.com',
      );
      expect(ada?.role).toBe('member');
    });

    it('does not revive a tombstone either: delete, then create again, is refused', async () => {
      const token = await scimToken();
      const userId = await provision(token, 'ada@example.com');
      license.hasValidLicense.mockResolvedValue(false);
      const deleted = await request(httpServer)
        .delete(`/api/auth/scim/v2/Users/${userId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(deleted.status).toBe(204);

      const recreated = await createScimUser(token, 'ada@example.com');

      expect([recreated.status, recreated.body]).toEqual([403, ADD_REFUSED]);
      expect(await emails()).toEqual([owner.email]);
    });

    it('answers a token it did not issue as before, recording nothing', async () => {
      await scimToken();
      license.hasValidLicense.mockClear();
      license.hasValidLicense.mockResolvedValue(false);

      const res = await request(httpServer)
        .post('/api/auth/scim/v2/Users')
        .set(
          'Authorization',
          `Bearer ${Buffer.from('forged:okta').toString('base64url')}`,
        )
        .send(scimUser('ada@example.com'));

      expect(res.status).toBe(401);
      expect(await lastRefusedAdd()).toEqual({ at: null, email: null });
      expect(license.hasValidLicense).not.toHaveBeenCalled();
    });

    it('asks about the token’s own Organization', async () => {
      const token = await scimToken();
      license.hasValidLicense.mockResolvedValue(false);

      await createScimUser(token, 'ada@example.com');

      expect(license.hasValidLicense).toHaveBeenCalledWith(
        ownerCtx.session.activeOrganizationId,
      );
    });

    it('adds again once the licence is back, keeping the record of the refusal', async () => {
      const token = await scimToken();
      license.hasValidLicense.mockResolvedValue(false);
      expect((await createScimUser(token, 'ada@example.com')).status).toBe(403);

      license.hasValidLicense.mockResolvedValue(true);
      expect((await createScimUser(token, 'ada@example.com')).status).toBe(201);
      expect(await emails()).toEqual(['ada@example.com', owner.email]);
      expect((await lastRefusedAdd()).email).toBe('ada@example.com');
    });
  });

  describe('HTTP surface', () => {
    it('serves the provider lifecycle over /scim/providers', async () => {
      const created = await request(httpServer)
        .post('/scim/providers')
        .set('Cookie', ownerCookie)
        .send({ providerId: 'okta' });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        providerId: 'okta',
        scimToken: expect.any(String) as string,
      });

      const listed = await request(httpServer)
        .get('/scim/providers')
        .set('Cookie', ownerCookie);
      expect(listed.status).toBe(200);
      expect(listed.body).toEqual([
        expect.objectContaining({ providerId: 'okta' }),
      ]);

      const removed = await request(httpServer)
        .delete('/scim/providers/okta')
        .set('Cookie', ownerCookie);
      expect(removed.status).toBe(200);
      expect(removed.body).toEqual({ success: true });

      const after = await request(httpServer)
        .get('/scim/providers')
        .set('Cookie', ownerCookie);
      expect(after.body).toEqual([]);
    });

    it('requires authentication', async () => {
      expect((await request(httpServer).get('/scim/providers')).status).toBe(
        401,
      );
      expect(
        (
          await request(httpServer)
            .post('/scim/providers')
            .send({ providerId: 'okta' })
        ).status,
      ).toBe(401);
      expect(
        (await request(httpServer).delete('/scim/providers/okta')).status,
      ).toBe(401);
    });

    it('refuses a plain member with 403', async () => {
      const memberSession = await signUpMember(httpServer, ownerCookie);

      // Deferred: supertest binds its own ephemeral listener per request, so
      // building all three up front races them against each other's teardown.
      const attempts = [
        () =>
          request(httpServer)
            .get('/scim/providers')
            .set('Cookie', memberSession.cookie),
        () =>
          request(httpServer)
            .post('/scim/providers')
            .set('Cookie', memberSession.cookie)
            .send({ providerId: 'okta' }),
        () =>
          request(httpServer)
            .delete('/scim/providers/okta')
            .set('Cookie', memberSession.cookie),
      ];
      // The message, not the bare 403: the controller's `toCtx` refuses a
      // member with no active organization first, so a status-only assertion
      // would pass with `ensureEnterprise` deleted.
      for (const attempt of attempts) {
        const res = await attempt();
        expect([res.status, refusal(res)]).toEqual([
          403,
          OWNER_OR_ADMIN_REFUSAL,
        ]);
      }
    });

    it('refuses an unlicensed organization with 403', async () => {
      license.hasValidLicense.mockResolvedValue(false);

      const res = await request(httpServer)
        .post('/scim/providers')
        .set('Cookie', ownerCookie)
        .send({ providerId: 'okta' });
      // The licence sentence, not the bare 403: it is what separates this
      // refusal from the owner/admin one the test above is about.
      expect([res.status, refusal(res)]).toEqual([403, LICENSE_REFUSAL]);
    });

    it('rejects a provider id the SCIM token format cannot carry', async () => {
      // `providerIdSchema`: the id is packed into the bearer token
      // between colon separators, so it stays lowercase alphanumeric + dashes.
      for (const providerId of [
        '',
        'Okta',
        'okta:prod',
        '-okta',
        'okta_prod',
        'o'.repeat(65),
      ]) {
        const res = await request(httpServer)
          .post('/scim/providers')
          .set('Cookie', ownerCookie)
          .send({ providerId });
        expect({ providerId, status: res.status }).toEqual({
          providerId,
          status: 400,
        });
      }

      expect(await scim.listProviders(ownerCtx)).toEqual([]);
    });
  });
});
