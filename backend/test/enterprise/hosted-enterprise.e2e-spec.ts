// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first load.
import { useHostedMode } from '../utils/hosted-mode';
useHostedMode();

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { createInstanceOrganization } from '../../src/auth/instance-organization';
import { subscription } from '../../src/cloud/billing/billing.schema';
import { CLOUD_RUN_SETTINGS } from '../../src/deployment-queue/cloud-runs-concurrency.provider';
import type { CloudRunSettings } from '../../src/deployment-queue/cloud-runs-concurrency.provider';
import { BUILDS_CONCURRENCY } from '../../src/deployment-queue/concurrency';
import { LOCAL_PARTITION } from '../../src/deployment-queue/job-types';
import { licenseKey } from '../../src/enterprise/license/license.schema';
import { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import { MailService } from '../../src/mail/mail.service';
import { server as serverTable } from '../../src/servers/server.schema';
import { givenPlan } from '../utils/hosted-plan';
import { MailRecorder, signUpHostedCustomer } from '../utils/hosted-sign-up';
import { ADDRESS_RESOLVER } from '../../src/outbound/outbound-address';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * Business or Enterprise instead of a license key (ADR-0048, ADR-0054).
 *
 * On the Hosted instance the paid-feature gates — SSO, SCIM, custom roles and
 * forward auth — ask whether the Organization is on Business or carries the
 * Enterprise marker, which only an Operator sets and which always counts as
 * Business; Starter does not pass them. The install-wide features (white-labelling,
 * parallel builds, parallel cloud runs) are Octabyte's and simply on; and an
 * Enterprise Organization's allowance is its hand-set counts. The Self-hosted
 * counterpart at the bottom flips `InstanceMode` off and shows the license key
 * still deciding, with the marker ignored.
 */
describe('Enterprise on the Hosted instance (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  const mail = new MailRecorder();

  const staff = {
    email: 'ops@octabyte.test',
    firstName: 'Ada',
    lastName: 'Lovelace',
    organizationName: 'Octabyte',
    password: 'staff-only-password',
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: MailService, useValue: mail },
        // A customer's trusted origin must resolve to a public address on the
        // Hosted instance (ADR-0076); this keeps the check off real DNS.
        {
          provide: ADDRESS_RESOLVER,
          useValue: () => Promise.resolve(['93.184.215.14']),
        },
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
  });

  async function signIn(email: string, password: string): Promise<string> {
    const res = await request(http)
      .post('/api/auth/sign-in/email')
      .send({ email, password });
    expect(res.status).toBe(200);
    return res.headers['set-cookie'];
  }

  /** The Instance organization, and its owner signed in. */
  async function givenStaff(): Promise<{ cookie: string; orgId: string }> {
    const created = await createInstanceOrganization(ctx.db, staff);
    return {
      cookie: await signIn(staff.email, staff.password),
      orgId: created.organizationId,
    };
  }

  /**
   * A customer Organization, not the Instance organization, with its owner
   * signed in and acting in it. Created and activated by the staff account:
   * what matters to every gate here is which Organization is active, and a
   * Hosted sign-up does not make one of its own.
   */
  async function givenCustomer(): Promise<{ cookie: string; orgId: string }> {
    const { cookie } = await givenStaff();
    const created = await request(http)
      .post('/organizations')
      .set('Cookie', cookie)
      .send({ name: 'Hopper Labs', slug: 'hopper-labs' });
    expect(created.status).toBe(201);
    const orgId = (created.body as { id: string }).id;
    const activated = await request(http)
      .post('/api/auth/organization/set-active')
      .set('Cookie', cookie)
      .send({ organizationId: orgId });
    expect(activated.status).toBe(200);
    return { cookie, orgId };
  }

  /** Arrangement only: what an Operator's switch will write. */
  async function givenEnterprise(
    organizationId: string,
    counts: { servers: number; cloudEnvironments: number } = {
      servers: 0,
      cloudEnvironments: 0,
    },
  ) {
    const values = {
      enterprise: true,
      enterpriseServers: counts.servers,
      enterpriseCloudEnvironments: counts.cloudEnvironments,
    };
    await ctx.db
      .insert(subscription)
      .values({ organizationId, ...values })
      .onConflictDoUpdate({ target: subscription.organizationId, set: values });
  }

  /** Arrangement only: a Self-hosted license key that is valid now. */
  async function givenLicenseKey(organizationId: string) {
    await ctx.db.insert(licenseKey).values({
      organizationId,
      enableEnterpriseFeatures: true,
      key: 'LICENSE-KEY-1',
      status: 'active',
    });
  }

  async function givenServers(organizationId: string, count: number) {
    return ctx.db
      .insert(serverTable)
      .values(
        Array.from({ length: count }, (_, index) => ({
          name: `server-${index + 1}`,
          ipAddress: `203.0.113.${index + 1}`,
          port: 22,
          organizationId,
        })),
      )
      .returning({ serverId: serverTable.serverId });
  }

  /**
   * One request through each of the four paid-feature gates, and the status it
   * answers once past it. SCIM and forward auth are probed with a write, since
   * their reads and removals stay open on any plan; the forward-auth
   * proxy deploy, past the plan, stops at the auth domain the Server has not got
   * yet, which is as far as it goes without a real Server.
   */
  const paidFeatures: Array<
    [
      string,
      (cookie: string, orgId: string) => Promise<request.Response>,
      number,
    ]
  > = [
    [
      'SSO',
      // Reads stay open on any plan; adding a trusted origin is
      // setting up, and exists Self-hosted too, where Proven domains do not.
      async (cookie) =>
        request(http)
          .post('/sso/trusted-origins')
          .set('Cookie', cookie)
          .send({ origin: 'https://idp.example.com' }),
      200,
    ],
    [
      'SCIM',
      async (cookie) =>
        request(http)
          .post('/scim/providers')
          .set('Cookie', cookie)
          .send({ providerId: 'okta' }),
      201,
    ],
    [
      'custom roles',
      async (cookie) =>
        request(http)
          .post('/custom-roles')
          .set('Cookie', cookie)
          .send({ roleName: 'auditor', permissions: { auditLog: ['read'] } }),
      201,
    ],
    [
      'forward auth',
      async (cookie, orgId) => {
        const [found] = await ctx.db
          .select({ serverId: serverTable.serverId })
          .from(serverTable)
          .where(eq(serverTable.organizationId, orgId));
        const serverId =
          found?.serverId ?? (await givenServers(orgId, 1))[0].serverId;
        return request(http)
          .post('/forward-auth/proxy')
          .set('Cookie', cookie)
          .send({ serverId, providerId: 'okta' });
      },
      412,
    ],
  ];

  const BUSINESS_REQUIRED = {
    code: 'BUSINESS_REQUIRED',
    message:
      'SSO, SCIM, custom roles and forward auth come with the Business plan. Choose Business under Settings > Billing',
  };

  describe('the paid features', () => {
    it.each(paidFeatures)(
      '%s is refused for a Hosted Organization with no plan, with a license key or without',
      async (_feature, call) => {
        const { cookie, orgId } = await givenCustomer();
        // A key stored before the switch to hosted unlocks nothing here.
        await givenLicenseKey(orgId);

        const res = await call(cookie, orgId);

        expect(res.status).toBe(403);
        expect(res.body).toMatchObject(BUSINESS_REQUIRED);
      },
    );

    it.each(paidFeatures)(
      '%s is refused for a Starter Organization, paid and in good standing',
      async (_feature, call) => {
        const { cookie, orgId } = await givenCustomer();
        await givenPlan(ctx, orgId, 'starter', 'active', { addOns: 2 });

        const res = await call(cookie, orgId);

        expect(res.status).toBe(403);
        expect(res.body).toMatchObject(BUSINESS_REQUIRED);
      },
    );

    it.each(paidFeatures)(
      '%s is allowed for a Business Organization',
      async (_feature, call, allowed) => {
        const { cookie, orgId } = await givenCustomer();
        await givenPlan(ctx, orgId, 'business');

        const res = await call(cookie, orgId);

        expect(res.status).toBe(allowed);
      },
    );

    it.each(paidFeatures)(
      '%s is refused for a Business Organization whose subscription has ended',
      async (_feature, call) => {
        const { cookie, orgId } = await givenCustomer();
        await givenPlan(ctx, orgId, 'business', 'canceled');

        const res = await call(cookie, orgId);

        expect(res.status).toBe(403);
        expect(res.body).toMatchObject(BUSINESS_REQUIRED);
      },
    );

    it.each(paidFeatures)(
      '%s is allowed once the Organization is Enterprise, which counts as Business',
      async (_feature, call, allowed) => {
        const { cookie, orgId } = await givenCustomer();
        await givenEnterprise(orgId);

        const res = await call(cookie, orgId);

        expect(res.status).toBe(allowed);
      },
    );

    it('GET /license/status reports Business or Enterprise as what licenses the Organization', async () => {
      const { cookie, orgId } = await givenCustomer();
      const status = () =>
        request(http).get('/license/status').set('Cookie', cookie);

      expect((await status()).body).toMatchObject({ licensed: false });
      await givenPlan(ctx, orgId, 'starter');
      expect((await status()).body).toMatchObject({
        licensed: false,
        status: 'inactive',
      });
      await givenPlan(ctx, orgId, 'business');
      expect((await status()).body).toMatchObject({
        licensed: true,
        status: 'active',
      });
      await givenPlan(ctx, orgId, 'starter');
      await givenEnterprise(orgId);
      expect((await status()).body).toMatchObject({ licensed: true });
    });

    it('has no license key to activate, read or release', async () => {
      const { cookie } = await givenCustomer();

      const calls = [
        request(http)
          .post('/license/activate')
          .set('Cookie', cookie)
          .send({ licenseKey: 'LICENSE-KEY-1' }),
        request(http).get('/license/settings').set('Cookie', cookie),
        request(http)
          .patch('/license/settings')
          .set('Cookie', cookie)
          .send({ enableEnterpriseFeatures: true }),
        request(http).post('/license/validate').set('Cookie', cookie),
        request(http).post('/license/deactivate').set('Cookie', cookie),
        request(http).post('/license/check-now').set('Cookie', cookie),
      ];
      for (const res of await Promise.all(calls)) {
        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({
          code: 'NO_LICENSE_KEY_ON_HOSTED',
          message:
            'The Hosted instance has no license key. SSO, SCIM, custom roles and forward auth come with the Business plan, under Settings > Billing',
        });
      }
    });

    // Enterprise alone is not enough: the button waits for a
    // provider with a Proven domain (`sso/hosted-proven-domains.e2e-spec.ts`).
    it('does not show the SSO button for an Enterprise Organization with no SSO set up', async () => {
      const { orgId } = await givenCustomer();
      const shown = async () =>
        (await request(http).get('/sso/show-sign-in')).body as {
          enabled: boolean;
        };

      expect(await shown()).toEqual({ enabled: false });
      await givenEnterprise(orgId);
      expect(await shown()).toEqual({ enabled: false });
    });
  });

  /**
   * SCIM and forward auth below Business (ADR-0054): adding is refused,
   * removing always works, and what was set up stays readable and is never
   * changed by a plan change.
   */
  describe('SCIM and forward auth below Business', () => {
    const HOSTED_ADD_REFUSED = {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: '403',
      detail:
        'Adding members through SCIM comes with the Business plan. Deactivations and deletions are still accepted',
    };

    /** A SCIM token issued while the Organization was on Business. */
    async function scimTokenFor(cookie: string, orgId: string) {
      await givenPlan(ctx, orgId, 'business');
      const res = await request(http)
        .post('/scim/providers')
        .set('Cookie', cookie)
        .send({ providerId: 'okta' });
      expect(res.status).toBe(201);
      return (res.body as { scimToken: string }).scimToken;
    }

    const pushCreate = (token: string, email: string) =>
      request(http)
        .post('/api/auth/scim/v2/Users')
        .set('Authorization', `Bearer ${token}`)
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: email,
          emails: [{ value: email, primary: true }],
          active: true,
        });

    const pushDelete = (token: string, userId: string) =>
      request(http)
        .delete(`/api/auth/scim/v2/Users/${userId}`)
        .set('Authorization', `Bearer ${token}`);

    it('refuses a SCIM create on Starter and still takes a delete, then adds again on Business and on Enterprise', async () => {
      const { cookie, orgId } = await givenCustomer();
      const token = await scimTokenFor(cookie, orgId);
      const ada = await pushCreate(token, 'ada@example.com');
      expect(ada.status).toBe(201);

      await givenPlan(ctx, orgId, 'starter');
      const refused = await pushCreate(token, 'alan@example.com');
      expect([refused.status, refused.body]).toEqual([403, HOSTED_ADD_REFUSED]);
      const removed = await pushDelete(token, (ada.body as { id: string }).id);
      expect(removed.status).toBe(204);

      const page = await request(http)
        .get('/scim/providers')
        .set('Cookie', cookie);
      expect(page.status).toBe(200);
      expect(page.body).toEqual([
        expect.objectContaining({
          providerId: 'okta',
          lastRefusedAddEmail: 'alan@example.com',
          lastRefusedAddAt: expect.any(String) as string,
        }),
      ]);

      await givenPlan(ctx, orgId, 'business');
      expect((await pushCreate(token, 'alan@example.com')).status).toBe(201);

      await givenPlan(ctx, orgId, 'starter');
      await givenEnterprise(orgId);
      expect((await pushCreate(token, 'grace@example.com')).status).toBe(201);
    });

    it('refuses a SCIM create with no plan at all', async () => {
      const { cookie, orgId } = await givenCustomer();
      const token = await scimTokenFor(cookie, orgId);
      await ctx.db
        .delete(subscription)
        .where(eq(subscription.organizationId, orgId));

      const res = await pushCreate(token, 'ada@example.com');

      expect([res.status, res.body]).toEqual([403, HOSTED_ADD_REFUSED]);
    });

    it('Self-hosted, follows the license key, with or without the Enterprise marker', async () => {
      const { cookie, orgId } = await givenCustomer();
      const token = await scimTokenFor(cookie, orgId);
      jest
        .spyOn(ctx.app.get(InstanceMode), 'isHosted', 'get')
        .mockReturnValue(false);
      await givenEnterprise(orgId);

      const refused = await pushCreate(token, 'ada@example.com');
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({
        detail:
          'Adding members through SCIM needs a valid enterprise license. Deactivations and deletions are still accepted',
      });

      await givenLicenseKey(orgId);
      expect((await pushCreate(token, 'ada@example.com')).status).toBe(201);
    });

    it('keeps the SCIM and forward-auth pages readable on Starter, and the SCIM provider removable', async () => {
      const { cookie, orgId } = await givenCustomer();
      await scimTokenFor(cookie, orgId);
      await givenPlan(ctx, orgId, 'starter');

      for (const path of ['/scim/providers', '/forward-auth/providers']) {
        const res = await request(http).get(path).set('Cookie', cookie);
        expect({ path, status: res.status }).toEqual({ path, status: 200 });
      }
      const removed = await request(http)
        .delete('/scim/providers/okta')
        .set('Cookie', cookie);
      expect(removed.status).toBe(200);
    });
  });

  describe('the install-wide features', () => {
    it('white-labelling is open to the Instance organization with no license', async () => {
      const { cookie } = await givenStaff();

      const res = await request(http)
        .patch('/settings/whitelabeling')
        .set('Cookie', cookie)
        .send({ appName: 'Octabyte Cloud' });

      expect(res.status).toBe(200);
    });

    it('parallel builds and parallel cloud runs take their configured limits with no license', async () => {
      const { cookie } = await givenStaff();
      for (const [path, body] of [
        ['/settings/builds-concurrency', { buildsConcurrency: 4 }],
        ['/settings/cloud-runs-concurrency', { cloudRunsConcurrency: 3 }],
      ] as const) {
        const res = await request(http)
          .post(path)
          .set('Cookie', cookie)
          .send(body);
        expect(res.status).toBe(200);
      }

      const builds =
        ctx.app.get<(partition: string) => Promise<number>>(BUILDS_CONCURRENCY);
      const cloudRuns = ctx.app.get<CloudRunSettings>(CLOUD_RUN_SETTINGS);
      await expect(builds(LOCAL_PARTITION)).resolves.toBe(4);
      await expect(cloudRuns.resolveLimit()).resolves.toBe(3);
    });

    it("refuses a customer's owner the parallel cloud runs limit, which stays at one", async () => {
      await givenStaff();
      const customer = await signUpHostedCustomer(http, mail, {
        name: 'Grace Hopper',
        email: 'grace@example.com',
        password: 'super-secret-password',
        organizationName: 'Hopper Labs',
      });

      const res = await request(http)
        .post('/settings/cloud-runs-concurrency')
        .set('Cookie', customer.cookie)
        .send({ cloudRunsConcurrency: 4 });

      expect(res.status).toBe(403);
      expect((res.body as { code: string }).code).toBe(
        'INSTANCE_AUTHORITY_REQUIRED',
      );
      const cloudRuns = ctx.app.get<CloudRunSettings>(CLOUD_RUN_SETTINGS);
      await expect(cloudRuns.resolveLimit()).resolves.toBe(1);
    });
  });

  describe("an Enterprise Organization's allowance", () => {
    function billing(cookie: string) {
      return request(http).get('/billing/subscription').set('Cookie', cookie);
    }
    function room(cookie: string) {
      return request(http)
        .get('/billing/can-create-server')
        .set('Cookie', cookie);
    }

    it('is its hand-set counts, with no Stripe plan', async () => {
      const { cookie, orgId } = await givenCustomer();
      await givenEnterprise(orgId, { servers: 5, cloudEnvironments: 2 });

      const res = await billing(cookie);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        plan: null,
        allowance: { plan: 'enterprise', servers: 5, cloudEnvironments: 2 },
      });
      expect((await room(cookie)).body).toMatchObject({
        canCreateMoreServers: true,
      });
    });

    it('refuses the next Server once the count is full, and points at Octabyte rather than the Add-on', async () => {
      const { cookie, orgId } = await givenCustomer();
      await givenEnterprise(orgId, { servers: 2, cloudEnvironments: 2 });
      await givenServers(orgId, 2);

      expect((await room(cookie)).body).toEqual({
        canCreateMoreServers: false,
        code: 'ALLOWANCE_FULL',
        message:
          'This Organization has 2 Servers, all its Enterprise agreement allows. Contact us at support@octabyte.io to raise its counts.',
      });
    });
  });

  describe('the Self-hosted counterpart', () => {
    function givenSelfHosted() {
      jest
        .spyOn(ctx.app.get(InstanceMode), 'isHosted', 'get')
        .mockReturnValue(false);
    }

    it.each(paidFeatures)(
      '%s still follows the license key, and the Enterprise marker unlocks nothing',
      async (_feature, call, allowed) => {
        const { cookie, orgId } = await givenCustomer();
        givenSelfHosted();
        await givenEnterprise(orgId);

        const refused = await call(cookie, orgId);
        expect(refused.status).toBe(403);
        expect(refused.body).toMatchObject({
          message: 'Valid enterprise license required',
        });

        await givenLicenseKey(orgId);
        expect((await call(cookie, orgId)).status).toBe(allowed);
      },
    );

    it('white-labelling and the two limits still need the license', async () => {
      const { cookie, orgId } = await givenStaff();
      givenSelfHosted();

      const refused = await request(http)
        .patch('/settings/whitelabeling')
        .set('Cookie', cookie)
        .send({ appName: 'Octabyte Cloud' });
      expect(refused.status).toBe(403);
      await request(http)
        .post('/settings/builds-concurrency')
        .set('Cookie', cookie)
        .send({ buildsConcurrency: 4 })
        .expect(200);
      const builds =
        ctx.app.get<(partition: string) => Promise<number>>(BUILDS_CONCURRENCY);
      await expect(builds(LOCAL_PARTITION)).resolves.toBe(1);

      await givenLicenseKey(orgId);
      const allowed = await request(http)
        .patch('/settings/whitelabeling')
        .set('Cookie', cookie)
        .send({ appName: 'Octabyte Cloud' });
      expect(allowed.status).toBe(200);
      await expect(builds(LOCAL_PARTITION)).resolves.toBe(4);
    });

    it('still lets an owner activate a license key', async () => {
      const { cookie } = await givenCustomer();
      givenSelfHosted();

      const res = await request(http)
        .get('/license/settings')
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
    });
  });
});
