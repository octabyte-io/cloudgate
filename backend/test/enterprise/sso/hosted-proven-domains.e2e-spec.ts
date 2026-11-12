// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first load.
import { useHostedMode } from '../../utils/hosted-mode';
useHostedMode();

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { subscription } from '../../../src/cloud/billing/billing.schema';
import { account, member, user } from '../../../src/db/schema';
import { LicenseService } from '../../../src/enterprise/license/license.service';
import { provenDomain } from '../../../src/enterprise/sso/proven-domain.schema';
import { SsoAddressPolicy } from '../../../src/enterprise/sso/sso-addresses';
import { ssoProvider } from '../../../src/enterprise/sso/sso.schema';
import { TXT_RESOLVER } from '../../../src/enterprise/sso/proven-domains.service';
import { InstanceMode } from '../../../src/instance-mode/instance-mode.service';
import { MailService } from '../../../src/mail/mail.service';
import {
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../../utils/hosted-sign-up';
import { givenPlan } from '../../utils/hosted-plan';
import { createTestApp, TestAppContext } from '../../utils/test-app';
import { FakeIdp, providerAtIdp, startFakeIdp } from './fake-idp';

jest.setTimeout(120_000);

// The redirect URI and confirmation links are built from it.
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';

const acmeOwner = {
  name: 'Ada',
  email: 'ada@acme.example.com',
  password: 'super-secret-password',
  organizationName: 'Acme',
};

const grace = {
  name: 'Grace',
  email: 'grace@example.com',
  password: 'another-secret-password',
  organizationName: 'Hopper Labs',
};

const SSO_OFF = {
  code: 'SSO_SIGN_IN_OFF',
  message:
    'SSO sign-in is off for this Organization because it is not on the Business plan. Sign in with your email and password instead; if you have never set one, use "Forgot password"',
};

const NOT_PROVEN = {
  code: 'SSO_DOMAIN_NOT_PROVEN',
  message:
    "This email address is not in a domain the SSO provider's Organization has proven, so it cannot sign in through that provider.",
};

/**
 * SSO on the Hosted instance acts only for Proven domains (ADR-0051).
 *
 * An Enterprise owner proves an email domain with a DNS TXT record, checked on
 * demand against a faked resolver (the `TXT_RESOLVER` port). Until a provider's
 * Organization has proven the domain of the address signing in, the provider
 * routes nobody there and its callback accepts nobody — which is what keeps
 * one Organization's identity provider from signing in as another customer's
 * person. A sign-in for a proven domain joins only the provider's Organization,
 * confirmed. The sign-in screen offers SSO only once an Enterprise
 * Organization has a provider with a proven domain. The Self-hosted
 * counterpart at the bottom flips `InstanceMode` off.
 */
describe('Proven domains for SSO on the Hosted instance (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let idp: FakeIdp;
  const mail = new MailRecorder();
  const resolveTxt = jest.fn<Promise<string[][]>, [string]>();

  /** What the faked DNS holds, by record name. */
  let dnsRecords: Record<string, string[][]>;

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: MailService, useValue: mail },
        { provide: TXT_RESOLVER, useValue: resolveTxt },
      ],
    });
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    jest.restoreAllMocks();
    mail.clear();
    dnsRecords = {};
    resolveTxt.mockReset();
    resolveTxt.mockImplementation((name) => {
      const records = dnsRecords[name];
      if (records) return Promise.resolve(records);
      return Promise.reject(
        Object.assign(new Error(`queryTxt ENODATA ${name}`), {
          code: 'ENODATA',
        }),
      );
    });
    idp = await startFakeIdp({
      sub: 'idp-newhire',
      email: 'newhire@acme.example.com',
      name: 'New Hire',
      email_verified: true,
    });
    await openHostedSignUp(ctx.db);
    // The fake IdP listens on loopback, which a customer's provider may not
    // use on the Hosted instance (ADR-0076, pinned by
    // `sso-addresses.spec.ts`). This suite is about Proven domains, so the
    // address rule is lifted for it; `restoreAllMocks` above puts it back.
    jest
      .spyOn(ctx.app.get(SsoAddressPolicy), 'mustBePublic')
      .mockResolvedValue(false);
  });

  afterEach(async () => {
    await idp.close();
  });

  async function givenEnterprise(organizationId: string, enterprise = true) {
    const values = {
      enterprise,
      enterpriseServers: 0,
      enterpriseCloudEnvironments: 0,
    };
    await ctx.db
      .insert(subscription)
      .values({ organizationId, ...values })
      .onConflictDoUpdate({ target: subscription.organizationId, set: values });
  }

  /**
   * Acme, an Enterprise Organization, with its owner signed in and an OIDC
   * provider at the fake IdP listing `domains`.
   */
  async function givenAcmeWithProvider(
    domains: string[] = ['acme.example.com'],
  ): Promise<{ cookie: string; organizationId: string }> {
    const owner = await signUpHostedCustomer(http, mail, acmeOwner);
    await givenEnterprise(owner.organizationId);
    const trusted = await request(http)
      .post('/sso/trusted-origins')
      .set('Cookie', owner.cookie)
      .send({ origin: idp.origin });
    expect(trusted.status).toBe(200);
    const registered = await request(http)
      .post('/sso/providers')
      .set('Cookie', owner.cookie)
      .send(providerAtIdp(idp, { domains }));
    expect(registered.status).toBe(201);
    mail.clear();
    return { cookie: owner.cookie, organizationId: owner.organizationId };
  }

  /** Adds the domain and publishes its record, then checks it. */
  async function prove(cookie: string, domain: string) {
    const added = await request(http)
      .post('/sso/proven-domains')
      .set('Cookie', cookie)
      .send({ domain });
    const { record } = added.body as {
      record: { name: string; value: string };
    };
    dnsRecords[record.name] = [[record.value]];
    const checked = await request(http)
      .post(`/sso/proven-domains/${domain}/check`)
      .set('Cookie', cookie);
    expect(checked.body).toMatchObject({ proven: true });
  }

  /** `POST /sign-in/sso`: where the browser would be sent. */
  const startSsoSignIn = (body: { email?: string; providerId?: string }) =>
    request(http)
      .post('/api/auth/sign-in/sso')
      .send({ ...body, callbackURL: '/dashboard' });

  /** The IdP's redirect back to the callback, for a started sign-in. */
  function finishSsoSignIn(start: request.Response) {
    const authorizeUrl = new URL((start.body as { url: string }).url);
    return request(http)
      .get('/api/auth/sso/callback/acme-oidc')
      .set('Cookie', start.headers['set-cookie'])
      .query({
        code: 'fake-idp-auth-code',
        state: authorizeUrl.searchParams.get('state'),
      });
  }

  /** `POST /sign-in/sso`, then the IdP's redirect back to the callback. */
  async function ssoSignIn(body: { email?: string; providerId?: string }) {
    const start = await startSsoSignIn(body);
    if (start.status !== 200) return { start, callback: null };
    return { start, callback: await finishSsoSignIn(start) };
  }

  const usersWithEmail = (email: string) =>
    ctx.db.select().from(user).where(eq(user.email, email));

  const showSignIn = async (): Promise<boolean> => {
    const res = await request(http).get('/sso/show-sign-in');
    expect(res.status).toBe(200);
    return (res.body as { enabled: boolean }).enabled;
  };

  describe('proving a domain', () => {
    it('issues a TXT challenge, and a check proves it only once the record is there', async () => {
      const { cookie } = await givenAcmeWithProvider();

      const added = await request(http)
        .post('/sso/proven-domains')
        .set('Cookie', cookie)
        .send({ domain: 'Acme.Example.com' });
      expect(added.status).toBe(201);
      expect(added.body).toMatchObject({
        domain: 'acme.example.com',
        proven: false,
        provenAt: null,
        record: {
          type: 'TXT',
          name: '_cloudgate-challenge.acme.example.com',
        },
      });
      const { record } = added.body as {
        record: { name: string; value: string };
      };
      expect(record.value).toMatch(/^cloudgate-domain-verification=\S{20,}$/);

      const check = () =>
        request(http)
          .post('/sso/proven-domains/acme.example.com/check')
          .set('Cookie', cookie);

      // No record yet.
      const early = await check();
      expect(early.status).toBe(200);
      expect(early.body).toMatchObject({ proven: false });
      expect(resolveTxt).toHaveBeenCalledWith(record.name);

      // A record that says something else proves nothing.
      dnsRecords[record.name] = [
        ['cloudgate-domain-verification=someone-else'],
      ];
      expect((await check()).body).toMatchObject({ proven: false });

      // The challenge, split into chunks as long TXT values are.
      dnsRecords[record.name] = [
        ['v=spf1 -all'],
        [record.value.slice(0, 20), record.value.slice(20)],
      ];
      const proven = await check();
      expect(proven.body).toMatchObject({ proven: true });
      expect(
        (proven.body as { provenAt: string | null }).provenAt,
      ).not.toBeNull();

      const listed = await request(http)
        .get('/sso/proven-domains')
        .set('Cookie', cookie);
      expect(listed.status).toBe(200);
      expect(listed.body).toEqual([
        expect.objectContaining({ domain: 'acme.example.com', proven: true }),
      ]);
    });

    it('hands back the same challenge when the domain is added twice', async () => {
      const { cookie } = await givenAcmeWithProvider();
      const add = () =>
        request(http)
          .post('/sso/proven-domains')
          .set('Cookie', cookie)
          .send({ domain: 'acme.example.com' });

      const first = await add();
      const second = await add();

      expect(second.body).toEqual(first.body);
    });

    it('stops a removed domain from routing anybody', async () => {
      const { cookie } = await givenAcmeWithProvider();
      await prove(cookie, 'acme.example.com');

      const removed = await request(http)
        .delete('/sso/proven-domains/acme.example.com')
        .set('Cookie', cookie);
      expect(removed.status).toBe(200);

      const { start } = await ssoSignIn({ email: 'newhire@acme.example.com' });
      expect(start.status).toBe(403);
      expect(start.body).toMatchObject(NOT_PROVEN);
    });

    it('stays listed and removable below Business, while checking is refused', async () => {
      const { cookie, organizationId } = await givenAcmeWithProvider();
      await request(http)
        .post('/sso/proven-domains')
        .set('Cookie', cookie)
        .send({ domain: 'acme.example.com' })
        .expect(201);
      await givenEnterprise(organizationId, false);

      const listed = await request(http)
        .get('/sso/proven-domains')
        .set('Cookie', cookie);
      expect(listed.status).toBe(200);
      expect(listed.body).toEqual([
        expect.objectContaining({ domain: 'acme.example.com' }),
      ]);

      const checked = await request(http)
        .post('/sso/proven-domains/acme.example.com/check')
        .set('Cookie', cookie);
      expect(checked.status).toBe(403);
      expect(checked.body).toMatchObject({ code: 'BUSINESS_REQUIRED' });

      const removed = await request(http)
        .delete('/sso/proven-domains/acme.example.com')
        .set('Cookie', cookie);
      expect(removed.status).toBe(200);
    });

    it('is refused to an Organization that is neither Business nor Enterprise', async () => {
      const { cookie, organizationId } = await givenAcmeWithProvider();
      await givenEnterprise(organizationId, false);

      const res = await request(http)
        .post('/sso/proven-domains')
        .set('Cookie', cookie)
        .send({ domain: 'acme.example.com' });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'BUSINESS_REQUIRED' });
    });
  });

  describe('signing in through a provider', () => {
    it('routes nobody to a provider whose domain is listed but not proven', async () => {
      await givenAcmeWithProvider();

      const { start } = await ssoSignIn({ email: 'newhire@acme.example.com' });

      expect(start.status).toBe(403);
      expect(start.body).toMatchObject(NOT_PROVEN);
    });

    it('accepts nobody at the callback for an unproven domain, creating no user', async () => {
      await givenAcmeWithProvider();

      // Naming the provider skips the routing check, so the callback is what
      // has to refuse.
      const { callback } = await ssoSignIn({ providerId: 'acme-oidc' });

      expect(callback?.status).toBe(302);
      expect(callback?.headers.location).toContain('error=');
      expect(callback?.headers.location).not.toBe('/dashboard');
      expect(await usersWithEmail('newhire@acme.example.com')).toHaveLength(0);
    });

    it("refuses another customer's address even after the provider's Organization proved its own domain", async () => {
      const victim = await signUpHostedCustomer(http, mail, grace);
      // Acme claims grace's domain too, and proves only its own.
      const { cookie } = await givenAcmeWithProvider([
        'acme.example.com',
        'example.com',
      ]);
      await prove(cookie, 'acme.example.com');
      idp.profile.sub = 'idp-impostor';
      idp.profile.email = grace.email;
      idp.profile.name = 'Not Grace';

      const routed = await ssoSignIn({ email: grace.email });
      expect(routed.start.status).toBe(403);
      expect(routed.start.body).toMatchObject(NOT_PROVEN);

      const { callback } = await ssoSignIn({ providerId: 'acme-oidc' });
      expect(callback?.headers.location).toContain('error=');
      expect(callback?.headers['set-cookie'] ?? []).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/session_token=[^;]+/)]),
      );
      // Nothing was linked onto grace's account.
      const links = await ctx.db
        .select()
        .from(account)
        .where(eq(account.userId, victim.id));
      expect(links.map((row) => row.providerId)).toEqual(['credential']);
    });

    it('joins a person in a proven domain to the provider Organization only, confirmed', async () => {
      const { cookie, organizationId } = await givenAcmeWithProvider();
      await prove(cookie, 'acme.example.com');

      const { start, callback } = await ssoSignIn({
        email: 'newhire@acme.example.com',
      });
      expect(start.status).toBe(200);
      expect(callback?.headers.location).toBe('/dashboard');

      const session = await request(http)
        .get('/api/auth/get-session')
        .set('Cookie', callback?.headers['set-cookie'] as unknown as string[]);
      expect(session.status).toBe(200);

      const [created] = await usersWithEmail('newhire@acme.example.com');
      expect(created.emailVerified).toBe(true);
      const memberships = await ctx.db
        .select({ organizationId: member.organizationId, role: member.role })
        .from(member)
        .where(eq(member.userId, created.id));
      expect(memberships).toEqual([{ organizationId, role: 'member' }]);
      // Confirmed by the sign-in itself: no confirmation email.
      expect(mail.to('newhire@acme.example.com')).toHaveLength(0);
    });
  });

  describe('below Business', () => {
    /** Off Enterprise and onto Starter, as a downgrade would leave the row. */
    async function givenStarter(organizationId: string) {
      await givenEnterprise(organizationId, false);
      await givenPlan(ctx, organizationId, 'starter');
    }

    async function givenBusiness(organizationId: string) {
      await givenEnterprise(organizationId, false);
      await givenPlan(ctx, organizationId, 'business');
    }

    /** Acme with a provider and its domain proven, while it could prove one. */
    async function givenAcmeReadyForSso() {
      const acme = await givenAcmeWithProvider();
      await prove(acme.cookie, 'acme.example.com');
      return acme;
    }

    const sessionCookieOf = (res: request.Response | null) =>
      ((res?.headers['set-cookie'] ?? []) as unknown as string[]).filter(
        (cookie) => /session_token=[^;]+/.test(cookie),
      );

    it('refuses SSO sign-in for a Starter Organization, by address and by provider, and offers no button', async () => {
      const { organizationId } = await givenAcmeReadyForSso();
      await givenStarter(organizationId);

      for (const body of [
        { email: 'newhire@acme.example.com' },
        { providerId: 'acme-oidc' },
      ]) {
        const { start } = await ssoSignIn(body);
        expect(start.status).toBe(403);
        expect(start.body).toMatchObject(SSO_OFF);
      }
      expect(await showSignIn()).toBe(false);
      expect(await usersWithEmail('newhire@acme.example.com')).toHaveLength(0);
    });

    it('lets no sign-in started on Business finish after the move to Starter, creating no user', async () => {
      const { organizationId } = await givenAcmeReadyForSso();
      const start = await startSsoSignIn({
        email: 'newhire@acme.example.com',
      });
      expect(start.status).toBe(200);

      await givenStarter(organizationId);
      const callback = await finishSsoSignIn(start);

      expect(callback.status).toBe(302);
      expect(callback.headers.location).toContain('error=');
      expect(sessionCookieOf(callback)).toEqual([]);
      expect(await usersWithEmail('newhire@acme.example.com')).toHaveLength(0);
    });

    it('signs nobody back in through SSO on Starter, someone who has signed in before included', async () => {
      const { organizationId } = await givenAcmeReadyForSso();
      const first = await ssoSignIn({ email: 'newhire@acme.example.com' });
      expect(first.callback?.headers.location).toBe('/dashboard');

      const start = await startSsoSignIn({
        email: 'newhire@acme.example.com',
      });
      await givenStarter(organizationId);
      const callback = await finishSsoSignIn(start);

      expect(callback.headers.location).toContain('error=');
      expect(sessionCookieOf(callback)).toEqual([]);
    });

    it('keeps the provider and its Proven domain, and SSO works again on Business with no other step', async () => {
      const { organizationId } = await givenAcmeReadyForSso();
      const providersBefore = await ctx.db.select().from(ssoProvider);
      const domainsBefore = await ctx.db.select().from(provenDomain);
      await givenStarter(organizationId);
      const refused = await ssoSignIn({ email: 'newhire@acme.example.com' });
      expect(refused.start.status).toBe(403);

      expect(await ctx.db.select().from(ssoProvider)).toEqual(providersBefore);
      expect(await ctx.db.select().from(provenDomain)).toEqual(domainsBefore);

      await givenBusiness(organizationId);
      expect(await showSignIn()).toBe(true);
      const { start, callback } = await ssoSignIn({
        email: 'newhire@acme.example.com',
      });
      expect(start.status).toBe(200);
      expect(callback?.headers.location).toBe('/dashboard');
      expect(sessionCookieOf(callback)).not.toEqual([]);
    });

    it('counts a Business subscription whose status no longer grants the plan as below Business', async () => {
      const { organizationId } = await givenAcmeReadyForSso();
      await givenEnterprise(organizationId, false);
      await givenPlan(ctx, organizationId, 'business', 'canceled');

      const { start } = await ssoSignIn({ email: 'newhire@acme.example.com' });

      expect(start.status).toBe(403);
      expect(start.body).toMatchObject(SSO_OFF);
    });

    it('lets someone who only ever signed in through SSO set a first password with "Forgot password", and sign in with it', async () => {
      const { organizationId } = await givenAcmeReadyForSso();
      const first = await ssoSignIn({ email: 'newhire@acme.example.com' });
      expect(first.callback?.headers.location).toBe('/dashboard');
      const [person] = await usersWithEmail('newhire@acme.example.com');
      const accountsOf = async () =>
        (
          await ctx.db
            .select({ providerId: account.providerId })
            .from(account)
            .where(eq(account.userId, person.id))
        )
          .map((row) => row.providerId)
          .sort();
      // SSO only: there is no password to sign in with.
      expect(await accountsOf()).toEqual(['acme-oidc']);

      await givenStarter(organizationId);
      mail.clear();
      const requested = await request(http)
        .post('/api/auth/request-password-reset')
        .send({
          email: 'newhire@acme.example.com',
          redirectTo: '/reset-password',
        });
      expect(requested.status).toBe(200);

      const [sent] = mail.to('newhire@acme.example.com');
      expect(sent?.email.subject).toBe('Reset your password');
      const link =
        /https?:\/\/[^"'\s<]*\/reset-password\/[^"'\s<?]+\?[^"'\s<]*/.exec(
          sent.email.html,
        )?.[0];
      expect(link).toBeDefined();
      const url = new URL((link as string).replace(/&amp;/g, '&'));
      const followed = await request(http).get(url.pathname + url.search);
      expect(followed.status).toBe(302);
      const token = new URL(
        followed.headers.location,
        'http://localhost',
      ).searchParams.get('token');
      expect(token).toBeTruthy();

      const reset = await request(http)
        .post('/api/auth/reset-password')
        .send({ newPassword: 'a-first-password-at-last', token });
      expect(reset.status).toBe(200);
      expect(await accountsOf()).toEqual(['acme-oidc', 'credential']);

      const signedIn = await request(http)
        .post('/api/auth/sign-in/email')
        .send({
          email: 'newhire@acme.example.com',
          password: 'a-first-password-at-last',
        });
      expect(signedIn.status).toBe(200);
      const session = await request(http)
        .get('/api/auth/get-session')
        .set('Cookie', sessionCookieOf(signedIn));
      expect((session.body as { user: { id: string } }).user.id).toBe(
        person.id,
      );
    });
  });

  describe('the SSO button', () => {
    it('shows for a Business Organization with a provider and a proven domain, and not once it is on Starter', async () => {
      const { cookie, organizationId } = await givenAcmeWithProvider();
      await prove(cookie, 'acme.example.com');
      await givenEnterprise(organizationId, false);
      await givenPlan(ctx, organizationId, 'business');

      expect(await showSignIn()).toBe(true);

      await givenPlan(ctx, organizationId, 'starter');
      expect(await showSignIn()).toBe(false);
    });

    it('shows only once an Enterprise Organization has a provider with a proven domain', async () => {
      expect(await showSignIn()).toBe(false);

      const { cookie, organizationId } = await givenAcmeWithProvider();
      // Enterprise with a provider, but nothing proven: still nobody to sign in.
      expect(await showSignIn()).toBe(false);

      await prove(cookie, 'acme.example.com');
      expect(await showSignIn()).toBe(true);

      // The same set-up on an Organization that is no longer Enterprise.
      await givenEnterprise(organizationId, false);
      expect(await showSignIn()).toBe(false);
    });
  });

  describe('on a Self-hosted instance', () => {
    const givenSelfHosted = () =>
      jest
        .spyOn(ctx.app.get(InstanceMode), 'isHosted', 'get')
        .mockReturnValue(false);

    it('has no Proven domains routes', async () => {
      const { cookie } = await givenAcmeWithProvider();
      givenSelfHosted();

      const res = await request(http)
        .get('/sso/proven-domains')
        .set('Cookie', cookie);

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        code: 'NO_PROVEN_DOMAINS_ON_SELF_HOSTED',
      });
    });

    it('lets a provider act for the domains it lists, proven or not, as before', async () => {
      const { organizationId } = await givenAcmeWithProvider();
      givenSelfHosted();
      // A valid key, which a Self-hosted provider needs to sign anyone in.
      jest
        .spyOn(ctx.app.get(LicenseService), 'hasValidLicense')
        .mockResolvedValue(true);

      const { start, callback } = await ssoSignIn({
        email: 'newhire@acme.example.com',
      });

      expect(start.status).toBe(200);
      expect(callback?.headers.location).toBe('/dashboard');
      const [created] = await usersWithEmail('newhire@acme.example.com');
      const memberships = await ctx.db
        .select({ organizationId: member.organizationId })
        .from(member)
        .where(eq(member.userId, created.id));
      expect(memberships).toEqual([{ organizationId }]);
    });

    it('decides the SSO button by the license key, not by Proven domains', async () => {
      const { cookie } = await givenAcmeWithProvider();
      await prove(cookie, 'acme.example.com');
      givenSelfHosted();

      expect(await showSignIn()).toBe(false);
    });
  });
});
