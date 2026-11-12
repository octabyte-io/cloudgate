import type { IncomingHttpHeaders } from 'node:http';
import { ConfigService } from '@nestjs/config';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { user } from '../../../src/auth/auth.schema';
import { App } from 'supertest/types';
import { LicenseService } from '../../../src/enterprise/license/license.service';
import { ssoProvider } from '../../../src/enterprise/sso/sso.schema';
import { SsoService } from '../../../src/enterprise/sso/sso.service';
import { SettingsService } from '../../../src/settings/settings.service';
import type { PermissionCtx } from '../../../src/rbac/permission.service';
import { createTestApp, TestAppContext } from '../../utils/test-app';
import {
  discoveredAtIdp,
  FakeIdp,
  providerAtIdp,
  startFakeIdp,
} from './fake-idp';
import { createOrganization as postOrganization } from '../../utils/test-auth';

jest.setTimeout(120_000);

// The redirect URI is built from it, so the suite says it rather than read a
// developer's backend/.env, which a fresh clone has none of. Set before
// createTestApp requires AppModule, whose ConfigModule snapshots the
// environment on that first import.
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/**
 * A registrable OIDC provider. `skipDiscovery` keeps registration off the
 * network — the plugin otherwise fetches the issuer's discovery document.
 */
const oidcProvider = {
  issuer: 'https://idp.acme.example.com',
  oidcConfig: {
    clientId: 'acme-client',
    clientSecret: 'acme-secret',
    authorizationEndpoint: 'https://idp.acme.example.com/authorize',
    tokenEndpoint: 'https://idp.acme.example.com/token',
    userInfoEndpoint: 'https://idp.acme.example.com/userinfo',
    skipDiscovery: true,
  },
};

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

describe('SSO (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let sso: SsoService;
  let settings: SettingsService;

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
    sso = ctx.app.get(SsoService);
    settings = ctx.app.get(SettingsService);
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

  /**
   * A member who actually accepted the invitation — signing up with a token
   * alone creates no member row.
   */
  async function invite(): Promise<{ ctx: PermissionCtx; cookie: string }> {
    const invitation = await request(httpServer)
      .post('/organizations/invitations')
      .set('Cookie', ownerCookie)
      .send({ email: 'invitee@example.com', role: 'member' });
    const inviteId = (invitation.body as { id: string }).id;

    const su = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .set('x-cloudgate-token', inviteId)
      .send({
        name: 'Ida Rhodes',
        email: 'invitee@example.com',
        password: 'super-secret-password',
      });
    const cookie = su.headers['set-cookie'];
    const inviteeId = (su.body as { user: { id: string } }).user.id;

    const accept = await request(httpServer)
      .post(`/organizations/invitations/${inviteId}/accept`)
      .set('Cookie', cookie);
    expect(accept.status).toBe(201);

    return {
      ctx: ctxFor(inviteeId, ownerCtx.session.activeOrganizationId),
      cookie,
    };
  }

  const inviteMember = async (): Promise<PermissionCtx> => (await invite()).ctx;

  const inviteMemberCookie = async (): Promise<string> =>
    (await invite()).cookie;

  describe('provider registration', () => {
    it('registers a provider that is then retrievable, with the domains joined', async () => {
      await sso.register(ownerCtx, ownerHeaders, {
        ...oidcProvider,
        providerId: 'acme-oidc',
        domains: ['acme.example.com', 'acme.test'],
      });

      const provider = await sso.findOne(ownerCtx, 'acme-oidc');
      expect(provider).toMatchObject({
        providerId: 'acme-oidc',
        issuer: 'https://idp.acme.example.com',
        domain: 'acme.example.com,acme.test',
        organizationId: ownerCtx.session.activeOrganizationId,
      });

      const listed = await sso.listProviders(ownerCtx);
      expect(listed.map((p) => p.providerId)).toEqual(['acme-oidc']);
    });

    it('refuses a domain another provider already claims, storing nothing', async () => {
      await sso.register(ownerCtx, ownerHeaders, {
        ...oidcProvider,
        providerId: 'acme-oidc',
        domains: ['acme.example.com', 'acme.test'],
      });

      await expect(
        sso.register(ownerCtx, ownerHeaders, {
          ...oidcProvider,
          providerId: 'second-oidc',
          domains: ['other.example.com', 'acme.test'],
        }),
      ).rejects.toThrow(
        'Domain acme.test is already registered for another provider',
      );

      const listed = await sso.listProviders(ownerCtx);
      expect(listed.map((p) => p.providerId)).toEqual(['acme-oidc']);
    });
  });

  describe('trusted origins', () => {
    it('keeps a normalized, de-duplicated list on the organization owner', async () => {
      expect(await sso.getTrustedOrigins(ownerCtx)).toEqual([]);

      await sso.addTrustedOrigin(ownerCtx, '  https://idp.acme.example.com/  ');
      expect(await sso.getTrustedOrigins(ownerCtx)).toEqual([
        'https://idp.acme.example.com',
      ]);

      // Same origin in a different case and with a trailing slash: no new entry.
      await sso.addTrustedOrigin(ownerCtx, 'https://IDP.acme.example.com//');
      expect(await sso.getTrustedOrigins(ownerCtx)).toEqual([
        'https://idp.acme.example.com',
      ]);

      await sso.addTrustedOrigin(ownerCtx, 'https://idp.other.example.com');
      await sso.updateTrustedOrigin(
        ownerCtx,
        'https://IDP.acme.example.com',
        'https://idp.renamed.example.com/',
      );
      expect(await sso.getTrustedOrigins(ownerCtx)).toEqual([
        'https://idp.renamed.example.com',
        'https://idp.other.example.com',
      ]);

      await sso.removeTrustedOrigin(
        ownerCtx,
        'https://idp.renamed.example.com',
      );
      expect(await sso.getTrustedOrigins(ownerCtx)).toEqual([
        'https://idp.other.example.com',
      ]);
    });

    it('lets an internal IdP be registered only once its origin is trusted', async () => {
      const internal = {
        providerId: 'internal-oidc',
        issuer: 'http://127.0.0.1:9999',
        domains: ['internal.example.com'],
        oidcConfig: {
          clientId: 'internal-client',
          clientSecret: 'internal-secret',
          authorizationEndpoint: 'http://127.0.0.1:9999/authorize',
          tokenEndpoint: 'http://127.0.0.1:9999/token',
          userInfoEndpoint: 'http://127.0.0.1:9999/userinfo',
          skipDiscovery: true,
        },
      };

      // A loopback IdP is not publicly routable, so the plugin refuses it
      // until an operator allowlists the origin.
      await expect(
        sso.register(ownerCtx, ownerHeaders, internal),
      ).rejects.toThrow(/not publicly routable/);

      await sso.addTrustedOrigin(ownerCtx, 'http://127.0.0.1:9999');

      await sso.register(ownerCtx, ownerHeaders, internal);
      expect((await sso.findOne(ownerCtx, 'internal-oidc')).issuer).toBe(
        'http://127.0.0.1:9999',
      );
    });
  });

  /**
   * The first provider on a fresh install is registered against an empty
   * list, and the plugin's own discovery check refuses it there — a refusal
   * `assertIssuerTrusted` has nothing to do with, so nothing here used to pin
   * it. These drive the discovery path the Add dialog actually sends: no
   * endpoint fields, so `registerSSOProvider` fetches
   * `/.well-known/openid-configuration` and consults the list first.
   */
  describe('registering against an empty trusted-origins list', () => {
    let idp: FakeIdp;

    beforeEach(async () => {
      idp = await startFakeIdp({
        sub: 'idp-user-1',
        email: 'newhire@discovered.example.com',
        name: 'New Hire',
      });
    });

    afterEach(async () => {
      await idp.close();
    });

    it('refuses, naming the origin and the card that trusts it', async () => {
      expect(await sso.getTrustedOrigins(ownerCtx)).toEqual([]);

      await expect(
        sso.register(ownerCtx, ownerHeaders, discoveredAtIdp(idp)),
      ).rejects.toThrow(
        `The Issuer URL is not in the organization's trusted origins list. ` +
          `Please add ${idp.origin} under Trusted origins before registering, ` +
          `or tick "Trust this issuer" to add it as part of this registration.`,
      );

      // Refused before anything was written, including the allowlist.
      expect(await sso.listProviders(ownerCtx)).toEqual([]);
      expect(await sso.getTrustedOrigins(ownerCtx)).toEqual([]);
    });

    it('registers in one step when the issuer is trusted with it', async () => {
      await sso.register(ownerCtx, ownerHeaders, {
        ...discoveredAtIdp(idp),
        trustIssuer: true,
      });

      // Discovery ran: the endpoints nobody typed are on the stored blob.
      const provider = await sso.findOne(ownerCtx, 'discovered-oidc');
      expect(JSON.parse(provider.oidcConfig ?? '{}')).toMatchObject({
        authorizationEndpoint: `${idp.origin}/authorize`,
        tokenEndpoint: `${idp.origin}/token`,
        jwksEndpoint: `${idp.origin}/jwks`,
        discoveryEndpoint: `${idp.origin}/.well-known/openid-configuration`,
      });
      expect(await sso.getTrustedOrigins(ownerCtx)).toEqual([idp.origin]);
    });

    it('leaves the list alone when the origin is already on it', async () => {
      await sso.addTrustedOrigin(ownerCtx, `${idp.origin}/`);

      await sso.register(ownerCtx, ownerHeaders, {
        ...discoveredAtIdp(idp),
        trustIssuer: true,
      });

      expect(await sso.getTrustedOrigins(ownerCtx)).toEqual([idp.origin]);
    });

    it('does not widen the list for a registration that fails anyway', async () => {
      await expect(
        sso.register(ownerCtx, ownerHeaders, {
          ...discoveredAtIdp(idp),
          issuer: `${idp.origin}/nowhere`,
          trustIssuer: true,
        }),
      ).rejects.toThrow(/discovery/i);

      // The origin was trusted to get past the gate, and the retry then failed
      // on the document itself — which is the honest split: the operator did
      // ask for the origin to be trusted.
      expect(await sso.getTrustedOrigins(ownerCtx)).toEqual([idp.origin]);
      expect(await sso.listProviders(ownerCtx)).toEqual([]);
    });
  });

  /**
   * The redirect URI the console shows. The template is built from
   * better-auth's own base URL and the path of the callback endpoint the plugin
   * serves, and the second test below is what makes that more than a restatement
   * — it compares the filled-in template against the `redirect_uri` the plugin
   * puts in front of the IdP.
   */
  describe('the redirect URI', () => {
    it('is BETTER_AUTH_URL, the auth base path and a provider-id slot', async () => {
      const configured = ctx.app
        .get(ConfigService)
        .get<string>('BETTER_AUTH_URL');
      expect(configured).toBeTruthy();

      const { template } = await sso.getRedirectUri(ownerCtx);
      expect(template.startsWith(`${configured}/api/auth/`)).toBe(true);
      expect(template.endsWith('{providerId}')).toBe(true);
    });

    it('is on a route of its own, readable without a valid license', async () => {
      const res = await request(httpServer)
        .get('/sso/redirect-uri')
        .set('Cookie', ownerCookie);
      expect(res.status).toBe(200);
      expect((res.body as { template: string }).template).toBe(
        (await sso.getRedirectUri(ownerCtx)).template,
      );

      license.hasValidLicense.mockResolvedValue(false);
      expect(
        (
          await request(httpServer)
            .get('/sso/redirect-uri')
            .set('Cookie', ownerCookie)
        ).status,
      ).toBe(200);
    });
  });

  describe('signing in through a provider', () => {
    let idp: FakeIdp;

    beforeEach(async () => {
      idp = await startFakeIdp({
        sub: 'idp-user-1',
        email: 'newhire@acme.example.com',
        name: 'New Hire',
      });
      await sso.addTrustedOrigin(ownerCtx, idp.origin);
      await sso.register(ownerCtx, ownerHeaders, providerAtIdp(idp));
    });

    afterEach(async () => {
      await idp.close();
    });

    /** Walks the whole flow, returning the cookie the callback issued. */
    async function signInThroughIdp(email: string): Promise<string> {
      const start = await request(httpServer)
        .post('/api/auth/sign-in/sso')
        .send({ email, callbackURL: '/dashboard' });
      expect(start.status).toBe(200);

      const authorizeUrl = new URL((start.body as { url: string }).url);
      expect(authorizeUrl.origin).toBe(idp.origin);
      expect(authorizeUrl.pathname).toBe('/authorize');
      expect(authorizeUrl.searchParams.get('client_id')).toBe('acme-client');

      // The browser carries the signed state cookie back with the redirect;
      // without it the callback rejects the state as unpersisted.
      const callback = await request(httpServer)
        .get('/api/auth/sso/callback/acme-oidc')
        .set('Cookie', start.headers['set-cookie'])
        .query({
          code: 'fake-idp-auth-code',
          state: authorizeUrl.searchParams.get('state'),
        });
      expect(callback.status).toBe(302);
      expect(callback.headers.location).toBe('/dashboard');
      return callback.headers['set-cookie'];
    }

    /**
     * The pin that keeps the console's redirect URI and the plugin's honest
     * about each other: the right-hand side is not a second copy of the
     * path, it is the `redirect_uri` the plugin puts in the authorize URL.
     */
    it('hands the IdP exactly the redirect URI the console shows', async () => {
      const start = await request(httpServer)
        .post('/api/auth/sign-in/sso')
        .send({ email: 'newhire@acme.example.com', callbackURL: '/dashboard' });
      expect(start.status).toBe(200);

      const { template } = await sso.getRedirectUri(ownerCtx);
      expect(
        new URL((start.body as { url: string }).url).searchParams.get(
          'redirect_uri',
        ),
      ).toBe(template.replace('{providerId}', 'acme-oidc'));
    });

    it('provisions the user into the provider organization with a valid session', async () => {
      const cookie = await signInThroughIdp('newhire@acme.example.com');

      // The code really was exchanged at the IdP.
      expect(idp.tokenRequests).toHaveLength(1);
      expect(idp.tokenRequests[0]).toContain('code=fake-idp-auth-code');

      const session = await request(httpServer)
        .get('/api/auth/get-session')
        .set('Cookie', cookie);
      expect(session.status).toBe(200);
      expect((session.body as { user: { email: string } }).user.email).toBe(
        'newhire@acme.example.com',
      );

      // They landed in the organization the provider belongs to...
      const active = await request(httpServer)
        .get('/organizations/active')
        .set('Cookie', cookie);
      expect(active.status).toBe(200);
      expect((active.body as { id: string }).id).toBe(
        ownerCtx.session.activeOrganizationId,
      );

      // ...as a plain member, not an owner.
      const members = await request(httpServer)
        .get('/organizations/members')
        .set('Cookie', ownerCookie);
      expect(members.status).toBe(200);
      const provisioned = (
        members.body as {
          members: Array<{ role: string; user: { email: string } }>;
        }
      ).members.find((m) => m.user.email === 'newhire@acme.example.com');
      expect(provisioned?.role).toBe('member');
    });

    /** Everything the IdP was told the client is, on the first exchange. */
    const credentialsPresented = (): string =>
      Buffer.from(
        (idp.tokenAuthorizations[0] ?? '').replace(/^Basic\s+/i, ''),
        'base64',
      ).toString() + (idp.tokenRequests[0] ?? '');

    it('still signs in with the stored secret after an edit that omits it', async () => {
      // The listing hands back no secret, so an edit that changes anything else
      // cannot resend one — `update` merges over the stored blob.
      await sso.update(ownerCtx, ownerHeaders, {
        providerId: 'acme-oidc',
        issuer: idp.origin,
        domains: ['acme.example.com', 'more.example.com'],
      });

      const listed = await sso.listProviders(ownerCtx);
      expect(listed[0].domain).toBe('acme.example.com,more.example.com');
      expect(listed[0].hasClientSecret).toBe(true);
      expect(JSON.stringify(listed)).not.toContain('acme-secret');

      await signInThroughIdp('newhire@acme.example.com');
      // The server still holds the real thing and presented it to the IdP.
      expect(credentialsPresented()).toContain('acme-secret');
    });

    it('links onto an existing verified account instead of duplicating it', async () => {
      // Cloudgate has no route that verifies an address, so the precondition
      // that makes linking legal at all is arranged directly.
      await ctx.db
        .update(user)
        .set({ emailVerified: true })
        .where(eq(user.id, ownerCtx.user.id));

      const linkingIdp = await startFakeIdp({
        sub: 'idp-owner',
        email: owner.email,
        name: 'Grace Hopper',
        email_verified: true,
      });
      await sso.addTrustedOrigin(ownerCtx, linkingIdp.origin);
      await sso.register(
        ownerCtx,
        ownerHeaders,
        providerAtIdp(linkingIdp, {
          providerId: 'owner-oidc',
          domains: ['owner.example.com'],
        }),
      );

      try {
        const start = await request(httpServer)
          .post('/api/auth/sign-in/sso')
          .send({ providerId: 'owner-oidc', callbackURL: '/dashboard' });
        expect(start.status).toBe(200);
        const authorizeUrl = new URL((start.body as { url: string }).url);

        const callback = await request(httpServer)
          .get('/api/auth/sso/callback/owner-oidc')
          .set('Cookie', start.headers['set-cookie'])
          .query({
            code: 'fake-idp-auth-code',
            state: authorizeUrl.searchParams.get('state'),
          });
        expect(callback.headers.location).toBe('/dashboard');

        const session = await request(httpServer)
          .get('/api/auth/get-session')
          .set('Cookie', callback.headers['set-cookie']);
        // The same user, not a second one carrying the same address.
        expect((session.body as { user: { id: string } }).user.id).toBe(
          ownerCtx.user.id,
        );

        const members = await request(httpServer)
          .get('/organizations/members')
          .set('Cookie', ownerCookie);
        const roster = (
          members.body as {
            members: Array<{ role: string; user: { email: string } }>;
          }
        ).members;
        expect(roster).toHaveLength(1);
        expect(roster[0]).toMatchObject({ role: 'owner' });
      } finally {
        await linkingIdp.close();
      }
    });

    describe('without a valid license', () => {
      const SSO_OFF = {
        code: 'SSO_SIGN_IN_OFF',
        message:
          'SSO sign-in is off for this Organization because it has no valid enterprise license. Sign in with your email and password instead; if you have never set one, use "Forgot password"',
      };

      const start = (body: { email?: string; providerId?: string }) =>
        request(httpServer)
          .post('/api/auth/sign-in/sso')
          .send({ ...body, callbackURL: '/dashboard' });

      const finish = (started: request.Response) => {
        const authorizeUrl = new URL((started.body as { url: string }).url);
        return request(httpServer)
          .get('/api/auth/sso/callback/acme-oidc')
          .set('Cookie', started.headers['set-cookie'])
          .query({
            code: 'fake-idp-auth-code',
            state: authorizeUrl.searchParams.get('state'),
          });
      };

      const sessionCookieOf = (res: request.Response) =>
        ((res.headers['set-cookie'] ?? []) as unknown as string[]).filter(
          (cookie) => /session_token=[^;]+/.test(cookie),
        );

      const usersWithEmail = (email: string) =>
        ctx.db.select().from(user).where(eq(user.email, email));

      it("refuses the sign-in route, by address and by provider, asking about the provider's Organization", async () => {
        license.hasValidLicense.mockResolvedValue(false);

        for (const body of [
          { email: 'newhire@acme.example.com' },
          { providerId: 'acme-oidc' },
        ]) {
          const res = await start(body);
          expect(res.status).toBe(403);
          expect(res.body).toMatchObject(SSO_OFF);
        }
        expect(license.hasValidLicense).toHaveBeenCalledWith(
          ownerCtx.session.activeOrganizationId,
        );
      });

      it('lets no sign-in started under a valid license finish once it is not, creating no user', async () => {
        const started = await start({ email: 'newhire@acme.example.com' });
        expect(started.status).toBe(200);

        license.hasValidLicense.mockResolvedValue(false);
        const callback = await finish(started);

        expect(callback.status).toBe(302);
        expect(callback.headers.location).toContain('error=');
        expect(sessionCookieOf(callback)).toEqual([]);
        expect(await usersWithEmail('newhire@acme.example.com')).toHaveLength(
          0,
        );
      });

      it('starts no session for someone who has signed in through SSO before', async () => {
        await signInThroughIdp('newhire@acme.example.com');
        const started = await start({ email: 'newhire@acme.example.com' });

        license.hasValidLicense.mockResolvedValue(false);
        const callback = await finish(started);

        expect(callback.headers.location).toContain('error=');
        expect(sessionCookieOf(callback)).toEqual([]);
      });

      it('keeps the provider as it was, and signs in again once the license is valid', async () => {
        const [before] = await ctx.db.select().from(ssoProvider);
        license.hasValidLicense.mockResolvedValue(false);
        expect(
          (await start({ email: 'newhire@acme.example.com' })).status,
        ).toBe(403);

        const [after] = await ctx.db.select().from(ssoProvider);
        expect(after).toEqual(before);

        license.hasValidLicense.mockResolvedValue(true);
        const cookie = await signInThroughIdp('newhire@acme.example.com');
        const session = await request(httpServer)
          .get('/api/auth/get-session')
          .set('Cookie', cookie);
        expect((session.body as { user: { email: string } }).user.email).toBe(
          'newhire@acme.example.com',
        );
      });
    });

    it('refuses to take over an unverified account with the same address', async () => {
      // Same flow as above, minus the verified local address.
      const takeoverIdp = await startFakeIdp({
        sub: 'idp-impostor',
        email: owner.email,
        name: 'Not Grace',
        email_verified: true,
      });
      await sso.addTrustedOrigin(ownerCtx, takeoverIdp.origin);
      await sso.register(
        ownerCtx,
        ownerHeaders,
        providerAtIdp(takeoverIdp, {
          providerId: 'impostor-oidc',
          domains: ['impostor.example.com'],
        }),
      );

      try {
        const start = await request(httpServer)
          .post('/api/auth/sign-in/sso')
          .send({ providerId: 'impostor-oidc', callbackURL: '/dashboard' });
        const authorizeUrl = new URL((start.body as { url: string }).url);

        const callback = await request(httpServer)
          .get('/api/auth/sso/callback/impostor-oidc')
          .set('Cookie', start.headers['set-cookie'])
          .query({
            code: 'fake-idp-auth-code',
            state: authorizeUrl.searchParams.get('state'),
          });

        expect(callback.headers.location).toContain('error=account+not+linked');
      } finally {
        await takeoverIdp.close();
      }
    });
  });

  describe('the public sign-in screen queries', () => {
    it('offers SSO only while the instance holds a valid licence', async () => {
      license.hasAnyValidLicense.mockResolvedValue(true);
      expect(await sso.showSignInWithSso()).toBe(true);

      license.hasAnyValidLicense.mockResolvedValue(false);
      expect(await sso.showSignInWithSso()).toBe(false);
    });

    it('lets an owner turn SSO-only on and off without a valid licence', async () => {
      license.hasValidLicense.mockResolvedValue(false);
      license.hasAnyValidLicense.mockResolvedValue(false);

      await settings.updateEnforceSso(ownerCtx, true);
      expect(await sso.enforceSso()).toBe(true);

      await settings.updateEnforceSso(ownerCtx, false);
      expect(await sso.enforceSso()).toBe(false);
    });

    it('reports SSO as not enforced until an owner turns it on', async () => {
      expect(await sso.enforceSso()).toBe(false);

      await settings.updateEnforceSso(ownerCtx, true);
      expect(await sso.enforceSso()).toBe(true);

      await settings.updateEnforceSso(ownerCtx, false);
      expect(await sso.enforceSso()).toBe(false);
    });

    it('reads without any session, but only an owner or admin may enforce it', async () => {
      // Both are public: the login screen asks before anyone is
      // signed in.
      const show = await request(httpServer).get('/sso/show-sign-in');
      expect(show.status).toBe(200);
      expect(show.body).toEqual({ enabled: true });

      const enforce = await request(httpServer).get('/sso/enforce');
      expect(enforce.status).toBe(200);
      expect(enforce.body).toEqual({ enforced: false });

      const memberCtx = await inviteMember();
      await expect(
        settings.updateEnforceSso(memberCtx, true),
      ).rejects.toThrow();
      expect(await sso.enforceSso()).toBe(false);
    });
  });

  describe('the enterprise gate', () => {
    /** Every call the gate covers, as a named thunk. */
    const gatedCalls = (
      caller: PermissionCtx,
      headers: IncomingHttpHeaders,
    ) => {
      const payload = {
        ...oidcProvider,
        providerId: 'acme-oidc',
        domains: ['acme.example.com'],
      };
      return [
        ['register', () => sso.register(caller, headers, payload)],
        ['update', () => sso.update(caller, headers, payload)],
        [
          'addTrustedOrigin',
          () => sso.addTrustedOrigin(caller, 'https://x.example.com'),
        ],
        [
          'updateTrustedOrigin',
          () =>
            sso.updateTrustedOrigin(
              caller,
              'https://x.example.com',
              'https://y.example.com',
            ),
        ],
      ] as const;
    };

    /**
     * What stays open below the paid features (ADR-0054): the kept
     * settings are readable, and removing is always allowed.
     */
    const keptCalls = (caller: PermissionCtx) =>
      [
        ['listProviders', () => sso.listProviders(caller)],
        ['getTrustedOrigins', () => sso.getTrustedOrigins(caller)],
        ['getRedirectUri', () => sso.getRedirectUri(caller)],
        [
          'removeTrustedOrigin',
          () => sso.removeTrustedOrigin(caller, 'https://x.example.com'),
        ],
      ] as const;

    it('refuses setting SSO up or changing it when the licence is not valid', async () => {
      license.hasValidLicense.mockResolvedValue(false);

      for (const [name, call] of gatedCalls(ownerCtx, ownerHeaders)) {
        await expect(call()).rejects.toThrow(
          'Valid enterprise license required',
        );
        expect(name).toBeTruthy();
      }
    });

    it('keeps the settings readable and removable when the licence is not valid', async () => {
      license.hasValidLicense.mockResolvedValue(false);

      for (const [name, call] of keptCalls(ownerCtx)) {
        await expect(call()).resolves.toBeDefined();
        expect(name).toBeTruthy();
      }
      // Absent, not refused: the gate let it through to the lookup.
      await expect(sso.findOne(ownerCtx, 'acme-oidc')).rejects.toThrow(
        'SSO provider not found',
      );
      await expect(sso.remove(ownerCtx, 'acme-oidc')).rejects.toThrow(
        'SSO provider not found',
      );
    });

    it('closes the whole surface to a member of the organization', async () => {
      const memberCtx = await inviteMember();

      for (const [name, call] of [
        ...gatedCalls(memberCtx, ownerHeaders),
        ...keptCalls(memberCtx),
        ['findOne', () => sso.findOne(memberCtx, 'acme-oidc')],
        ['remove', () => sso.remove(memberCtx, 'acme-oidc')],
      ] as const) {
        await expect(call()).rejects.toThrow(
          'Only owners and admins can manage SSO providers',
        );
        expect(name).toBeTruthy();
      }
    });

    it('leaves an existing provider untouched when a refused call is made', async () => {
      await sso.register(ownerCtx, ownerHeaders, {
        ...oidcProvider,
        providerId: 'acme-oidc',
        domains: ['acme.example.com'],
      });
      const memberCtx = await inviteMember();

      await expect(sso.remove(memberCtx, 'acme-oidc')).rejects.toThrow(
        'Only owners and admins can manage SSO providers',
      );
      expect(await sso.listProviders(ownerCtx)).toHaveLength(1);
    });
  });

  describe('the HTTP surface', () => {
    const body = {
      ...oidcProvider,
      providerId: 'acme-oidc',
      domains: ['acme.example.com'],
    };

    it('carries the provider lifecycle over the routes', async () => {
      const created = await request(httpServer)
        .post('/sso/providers')
        .set('Cookie', ownerCookie)
        .send(body);
      expect(created.status).toBe(201);

      const listed = await request(httpServer)
        .get('/sso/providers')
        .set('Cookie', ownerCookie);
      expect(listed.status).toBe(200);
      expect(listed.body).toHaveLength(1);

      const one = await request(httpServer)
        .get('/sso/providers/acme-oidc')
        .set('Cookie', ownerCookie);
      expect(one.status).toBe(200);
      expect((one.body as { domain: string }).domain).toBe('acme.example.com');

      const updated = await request(httpServer)
        .put('/sso/providers/acme-oidc')
        .set('Cookie', ownerCookie)
        .send({ ...body, domains: ['acme.example.com', 'more.example.com'] });
      expect(updated.status).toBe(200);

      const removed = await request(httpServer)
        .delete('/sso/providers/acme-oidc')
        .set('Cookie', ownerCookie);
      expect(removed.status).toBe(200);

      const gone = await request(httpServer)
        .get('/sso/providers/acme-oidc')
        .set('Cookie', ownerCookie);
      expect(gone.status).toBe(404);
    });

    it('carries the trusted-origin routes', async () => {
      const added = await request(httpServer)
        .post('/sso/trusted-origins')
        .set('Cookie', ownerCookie)
        .send({ origin: 'https://idp.acme.example.com/' });
      expect(added.status).toBe(200);

      const listed = await request(httpServer)
        .get('/sso/trusted-origins')
        .set('Cookie', ownerCookie);
      expect(listed.body).toEqual(['https://idp.acme.example.com']);

      const renamed = await request(httpServer)
        .put('/sso/trusted-origins')
        .set('Cookie', ownerCookie)
        .send({
          oldOrigin: 'https://idp.acme.example.com',
          newOrigin: 'https://idp.new.example.com',
        });
      expect(renamed.status).toBe(200);

      const removed = await request(httpServer)
        .delete('/sso/trusted-origins')
        .set('Cookie', ownerCookie)
        .send({ origin: 'https://idp.new.example.com' });
      expect(removed.status).toBe(200);

      const empty = await request(httpServer)
        .get('/sso/trusted-origins')
        .set('Cookie', ownerCookie);
      expect(empty.body).toEqual([]);
    });

    it('rejects payloads the DTO will not accept', async () => {
      const cases = [
        { ...body, domains: ['https://acme.example.com'] }, // a URL, not a domain
        { ...body, domains: ['localhost'] }, // bare label
        { ...body, domains: [] }, // nothing to route
        { ...body, issuer: 'not-a-url' },
        { ...body, oidcConfig: { clientSecret: 'only-a-secret' } },
        {
          ...body,
          oidcConfig: { ...oidcProvider.oidcConfig, tokenEndpoint: 'nope' },
        },
      ];

      for (const payload of cases) {
        const res = await request(httpServer)
          .post('/sso/providers')
          .set('Cookie', ownerCookie)
          .send(payload);
        expect(res.status).toBe(400);
      }
      expect(await sso.listProviders(ownerCtx)).toEqual([]);
    });

    it('answers 401 unauthenticated and 403 for a member, and lists for a lapsed licence', async () => {
      expect((await request(httpServer).get('/sso/providers')).status).toBe(
        401,
      );
      expect(
        (await request(httpServer).post('/sso/providers').send(body)).status,
      ).toBe(401);
      expect(
        (await request(httpServer).get('/sso/trusted-origins')).status,
      ).toBe(401);

      const memberCookie = await inviteMemberCookie();
      expect(
        (
          await request(httpServer)
            .get('/sso/providers')
            .set('Cookie', memberCookie)
        ).status,
      ).toBe(403);
      expect(
        (
          await request(httpServer)
            .patch('/sso/enforce')
            .set('Cookie', memberCookie)
            .send({ enforceSSO: true })
        ).status,
      ).toBe(403);

      license.hasValidLicense.mockResolvedValue(false);
      expect(
        (
          await request(httpServer)
            .get('/sso/providers')
            .set('Cookie', ownerCookie)
        ).status,
      ).toBe(200);
    });
  });

  describe('the provider projection', () => {
    const registered = {
      ...oidcProvider,
      providerId: 'acme-oidc',
      domains: ['acme.example.com'],
    };

    it('never carries the client secret over the listing route', async () => {
      await sso.register(ownerCtx, ownerHeaders, registered);

      const listed = await request(httpServer)
        .get('/sso/providers')
        .set('Cookie', ownerCookie);
      expect(listed.status).toBe(200);
      expect(listed.body).toHaveLength(1);
      // The whole serialised response, not just the field it is declared on:
      // an encrypted column that decrypts on read leaks wherever it is spread.
      expect(JSON.stringify(listed.body)).not.toContain('acme-secret');
    });

    /**
     * The SAML half of the same column pair. Nothing in this app registers a
     * SAML provider — the plugin's own endpoint does — so the row is arranged
     * directly, which is also the only way to store material this shape.
     */
    it('never carries SAML signing material either', async () => {
      await ctx.db.insert(ssoProvider).values({
        providerId: 'acme-saml',
        issuer: 'https://idp.saml.example.com',
        domain: 'saml.example.com',
        userId: ownerCtx.user.id,
        organizationId: ownerCtx.session.activeOrganizationId,
        samlConfig: JSON.stringify({
          issuer: 'https://idp.saml.example.com',
          entryPoint: 'https://idp.saml.example.com/sso',
          // The IdP's signing certificate is public by definition.
          cert: 'PUBLIC-IDP-CERTIFICATE',
          callbackUrl: 'https://console.example.com/callback/acme-saml',
          privateKey: 'saml-signing-key',
          decryptionPvk: 'saml-decryption-key',
          spMetadata: {
            entityID: 'https://console.example.com',
            privateKey: 'sp-signing-key',
            privateKeyPass: 'sp-key-passphrase',
          },
          idpMetadata: {
            entityID: 'https://idp.saml.example.com',
            encPrivateKey: 'idp-encryption-key',
          },
        }),
      });

      const one = await request(httpServer)
        .get('/sso/providers/acme-saml')
        .set('Cookie', ownerCookie);
      expect(one.status).toBe(200);

      const body = JSON.stringify(one.body);
      for (const secret of [
        'saml-signing-key',
        'saml-decryption-key',
        'sp-signing-key',
        'sp-key-passphrase',
        'idp-encryption-key',
      ]) {
        expect(body).not.toContain(secret);
      }
      // The public half survives, so the row is still describable.
      expect(body).toContain('PUBLIC-IDP-CERTIFICATE');
      expect(body).toContain('https://idp.saml.example.com/sso');
    });

    it('says a secret is held, and leaves the edit form everything else', async () => {
      await sso.register(ownerCtx, ownerHeaders, registered);

      const one = await request(httpServer)
        .get('/sso/providers/acme-oidc')
        .set('Cookie', ownerCookie);
      expect(one.status).toBe(200);
      expect(JSON.stringify(one.body)).not.toContain('acme-secret');

      const provider = one.body as {
        hasClientSecret: boolean;
        oidcConfig: string;
      };
      // Derived, because the value it stands for is gone.
      expect(provider.hasClientSecret).toBe(true);
      expect(
        JSON.parse(provider.oidcConfig) as Record<string, unknown>,
      ).toMatchObject({
        clientId: 'acme-client',
        authorizationEndpoint: 'https://idp.acme.example.com/authorize',
        tokenEndpoint: 'https://idp.acme.example.com/token',
        userInfoEndpoint: 'https://idp.acme.example.com/userinfo',
      });
    });
  });

  describe('secret storage', () => {
    it('encrypts the oidc config at rest, secret and all', async () => {
      await sso.register(ownerCtx, ownerHeaders, {
        ...oidcProvider,
        providerId: 'acme-oidc',
        domains: ['acme.example.com'],
      });

      const stored = await ctx.db.execute<{ oidc_config: string }>(
        sql`select oidc_config from sso_provider where provider_id = 'acme-oidc'`,
      );
      const raw = stored.rows[0].oidc_config;
      expect(raw).not.toContain('acme-secret');
      expect(raw).not.toContain('acme-client');

      // ...and the service still hands back the config an edit form needs,
      // without the credential (`signing in through a provider` is where
      // the retained secret is pinned).
      const provider = await sso.findOne(ownerCtx, 'acme-oidc');
      const config = JSON.parse(provider.oidcConfig ?? '{}') as Record<
        string,
        unknown
      >;
      expect(config).toMatchObject({
        clientId: 'acme-client',
        issuer: 'https://idp.acme.example.com',
        tokenEndpoint: 'https://idp.acme.example.com/token',
      });
      expect(config).not.toHaveProperty('clientSecret');
    });
  });

  describe('updating a provider', () => {
    it('replaces the domains and the oidc config, normalizing the domains', async () => {
      await sso.register(ownerCtx, ownerHeaders, {
        ...oidcProvider,
        providerId: 'acme-oidc',
        domains: ['acme.example.com'],
      });

      await sso.update(ownerCtx, ownerHeaders, {
        ...oidcProvider,
        providerId: 'acme-oidc',
        domains: [
          ' ACME.example.com ',
          'extra.example.com',
          'acme.example.com',
        ],
        oidcConfig: { ...oidcProvider.oidcConfig, clientId: 'rotated-client' },
      });

      const provider = await sso.findOne(ownerCtx, 'acme-oidc');
      expect(provider.domain).toBe('acme.example.com,extra.example.com');
      expect(
        (JSON.parse(provider.oidcConfig ?? '{}') as { clientId: string })
          .clientId,
      ).toBe('rotated-client');
    });

    it('refuses a new issuer that is not a trusted origin', async () => {
      await sso.register(ownerCtx, ownerHeaders, {
        ...oidcProvider,
        providerId: 'acme-oidc',
        domains: ['acme.example.com'],
      });

      const moved = {
        providerId: 'acme-oidc',
        issuer: 'https://idp.moved.example.com',
        domains: ['acme.example.com'],
        oidcConfig: {
          ...oidcProvider.oidcConfig,
          tokenEndpoint: 'https://idp.moved.example.com/token',
          userInfoEndpoint: 'https://idp.moved.example.com/userinfo',
          authorizationEndpoint: 'https://idp.moved.example.com/authorize',
        },
      };

      await expect(sso.update(ownerCtx, ownerHeaders, moved)).rejects.toThrow(
        "The new Issuer URL is not in the organization's trusted origins list. Please add it under Trusted origins before saving.",
      );
      expect((await sso.findOne(ownerCtx, 'acme-oidc')).issuer).toBe(
        'https://idp.acme.example.com',
      );

      await sso.addTrustedOrigin(ownerCtx, 'https://idp.moved.example.com');
      await sso.update(ownerCtx, ownerHeaders, moved);
      expect((await sso.findOne(ownerCtx, 'acme-oidc')).issuer).toBe(
        'https://idp.moved.example.com',
      );
    });

    it('refuses to update a provider that is not the caller organization’s', async () => {
      await sso.register(ownerCtx, ownerHeaders, {
        ...oidcProvider,
        providerId: 'acme-oidc',
        domains: ['acme.example.com'],
      });
      const otherOrgCtx = ctxFor(
        ownerCtx.user.id,
        await createOrganization(httpServer, ctx.db, ownerCookie, 'Second Org'),
      );

      await expect(
        sso.update(otherOrgCtx, ownerHeaders, {
          ...oidcProvider,
          providerId: 'acme-oidc',
          domains: ['hijacked.example.com'],
        }),
      ).rejects.toThrow(
        'SSO provider not found or you do not have permission to update it',
      );
      expect((await sso.findOne(ownerCtx, 'acme-oidc')).domain).toBe(
        'acme.example.com',
      );
    });
  });

  describe('deleting a provider', () => {
    it('removes the provider and frees its domains for another one', async () => {
      await sso.register(ownerCtx, ownerHeaders, {
        ...oidcProvider,
        providerId: 'acme-oidc',
        domains: ['acme.example.com'],
      });

      await sso.remove(ownerCtx, 'acme-oidc');

      expect(await sso.listProviders(ownerCtx)).toEqual([]);
      await expect(sso.findOne(ownerCtx, 'acme-oidc')).rejects.toThrow(
        'SSO provider not found or you do not have permission to access it',
      );

      // The domain is claimable again now that nothing holds it.
      await sso.register(ownerCtx, ownerHeaders, {
        ...oidcProvider,
        providerId: 'replacement-oidc',
        domains: ['acme.example.com'],
      });
      expect((await sso.listProviders(ownerCtx))[0].providerId).toBe(
        'replacement-oidc',
      );
    });

    it('refuses to delete a provider that is not the caller organization’s', async () => {
      await sso.register(ownerCtx, ownerHeaders, {
        ...oidcProvider,
        providerId: 'acme-oidc',
        domains: ['acme.example.com'],
      });
      const otherOrgCtx = ctxFor(
        ownerCtx.user.id,
        await createOrganization(httpServer, ctx.db, ownerCookie, 'Second Org'),
      );

      await expect(sso.remove(otherOrgCtx, 'acme-oidc')).rejects.toThrow(
        'SSO provider not found or you do not have permission to delete it',
      );
      expect(await sso.listProviders(ownerCtx)).toHaveLength(1);
    });
  });
});
