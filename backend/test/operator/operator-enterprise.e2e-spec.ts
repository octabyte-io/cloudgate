// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first load.
import { useHostedMode } from '../utils/hosted-mode';
const hosted = useHostedMode();

import { format } from 'date-fns';
import { and, eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import request from 'supertest';
import { App } from 'supertest/types';

import { subscription } from '../../src/cloud/billing/billing.schema';
import { hasBeenEnterprise } from '../../src/cloud/billing/enterprise';
import { LapseClockService } from '../../src/cloud/billing/lapse-clock.service';
import { STRIPE_API } from '../../src/cloud/billing/stripe-api';
import { fakeStripe } from '../utils/fake-stripe';
import { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import { MailService } from '../../src/mail/mail.service';
import { member, organizationRole } from '../../src/db/schema';
import { server as serverTable } from '../../src/servers/server.schema';
import {
  HOSTED_STAFF,
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../utils/hosted-sign-up';
import type { HostedCustomer } from '../utils/hosted-sign-up';
import { signUpMember } from '../utils/test-auth';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

const OPERATOR_REFUSAL =
  'Only an owner or admin of the Instance organization can use the Operator page';

const DAY = 24 * 60 * 60 * 1000;

const retrieveSubscription = jest.fn<Promise<Stripe.Subscription>, [string]>();
const constructEvent = jest.fn<Stripe.Event, [Buffer | string, string]>();
const stripe = fakeStripe({ retrieveSubscription, constructEvent });

/** Hopper Labs' new Starter subscription, as Stripe hands it to the webhook. */
const activeStarter = {
  id: 'sub_after_enterprise',
  customer: 'cus_after_enterprise',
  status: 'active',
  items: {
    data: [
      {
        id: 'si_plan',
        price: { id: hosted.STARTER_PLAN_PRICE_ID },
        quantity: 1,
      },
    ],
  },
} as unknown as Stripe.Subscription;

interface AuditRow {
  organizationId: string | null;
  userEmail: string | null;
  userRole: string;
  userName: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  resourceName: string | null;
  metadata: string | null;
}

interface Listed {
  id: string;
  enterprise: boolean;
  plan: string | null;
  state: { kind: string };
  servers: { used: number; allowed: number };
  cloudEnvironments: { used: number; allowed: number };
}

/**
 * The Operator's Enterprise switch (ADR-0048, ADR-0050): on with the
 * Server and Cloud Environment counts of the agreement, refused while a Stripe
 * subscription is live so nobody is billed twice; off is a lapse (ADR-0052):
 * frozen, the deletion clock started, "your plan has ended" to owners
 * and admins, lifted by paying for a plan. A count below use refuses only new
 * additions. Each write leaves
 * a row in the customer's own audit log and a copy in the Instance
 * organization's, as suspension does.
 */
describe('The Operator switches an Organization to Enterprise (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let staffCookie: string;
  let instanceOrganizationId: string;
  let grace: HostedCustomer;
  const mail = new MailRecorder();

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: STRIPE_API, useValue: stripe },
        { provide: MailService, useValue: mail },
      ],
    });
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await ctx.resetDb();
    instanceOrganizationId = (await openHostedSignUp(ctx.db)).organizationId;
    staffCookie = await signIn(HOSTED_STAFF.email, HOSTED_STAFF.password);
    grace = await signUpHostedCustomer(http, mail, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
    mail.clear();
  });

  async function signIn(email: string, password: string): Promise<string> {
    const res = await request(http)
      .post('/api/auth/sign-in/email')
      .send({ email, password });
    expect(res.status).toBe(200);
    return (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
  }

  /** Arrangement only: Hopper Labs' Stripe subscription in `status`. */
  async function givenStripeSubscription(
    status: string,
    marks: Partial<typeof subscription.$inferInsert> = {},
  ): Promise<void> {
    await ctx.db.insert(subscription).values({
      organizationId: grace.organizationId,
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      plan: 'starter',
      status,
      ...marks,
    });
  }

  /** Arrangement only: `count` Servers in Hopper Labs, inserted directly. */
  async function givenServers(count: number): Promise<void> {
    await ctx.db.insert(serverTable).values(
      Array.from({ length: count }, (_, index) => ({
        name: `server-${index + 1}`,
        ipAddress: `203.0.113.${index + 1}`,
        port: 22,
        organizationId: grace.organizationId,
      })),
    );
  }

  const setEnterprise = (
    body: unknown,
    organizationId = grace.organizationId,
    cookie = staffCookie,
  ) =>
    request(http)
      .put(`/operator/organizations/${organizationId}/enterprise`)
      .set('Cookie', cookie)
      .send(body as object);

  const on = (servers: number, cloudEnvironments: number) =>
    setEnterprise({ enterprise: true, servers, cloudEnvironments });

  const off = () => setEnterprise({ enterprise: false });

  /** What Hopper Labs' own billing page reads. */
  async function allowance() {
    const res = await request(http)
      .get('/billing/subscription')
      .set('Cookie', grace.cookie);
    expect(res.status).toBe(200);
    return (res.body as { allowance: unknown }).allowance;
  }

  async function listed(): Promise<Listed> {
    const res = await request(http)
      .get('/operator/organizations')
      .set('Cookie', staffCookie);
    expect(res.status).toBe(200);
    return (res.body as Listed[]).find(
      (row) => row.id === grace.organizationId,
    )!;
  }

  const addServer = () =>
    request(http).post('/servers').set('Cookie', grace.cookie).send({
      name: 'one-more',
      ipAddress: '203.0.113.200',
      port: 22,
      username: 'root',
      sshKeyId: 'any-key',
    });

  async function serverCount(): Promise<number> {
    const res = await request(http).get('/servers').set('Cookie', grace.cookie);
    expect(res.status).toBe(200);
    return (res.body as unknown[]).length;
  }

  async function row() {
    const [found] = await ctx.db
      .select()
      .from(subscription)
      .where(eq(subscription.organizationId, grace.organizationId));
    return found;
  }

  async function trail(cookie: string): Promise<AuditRow[]> {
    const res = await request(http)
      .get('/audit-logs')
      .query({ resourceType: 'organization' })
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return (res.body as { logs: AuditRow[] }).logs;
  }

  it('switching it on with counts sets the allowance to them', async () => {
    const res = await on(5, 2);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enterprise: true,
      servers: 5,
      cloudEnvironments: 2,
    });
    expect(await allowance()).toEqual({
      plan: 'enterprise',
      servers: 5,
      cloudEnvironments: 2,
    });
    expect(await listed()).toMatchObject({
      enterprise: true,
      servers: { used: 0, allowed: 5 },
      cloudEnvironments: { used: 0, allowed: 2 },
    });

    // Setting it again changes the counts.
    expect((await on(7, 3)).status).toBe(200);
    expect(await allowance()).toEqual({
      plan: 'enterprise',
      servers: 7,
      cloudEnvironments: 3,
    });
  });

  const LIVE_SUBSCRIPTION_REFUSAL =
    'Hopper Labs has an active Stripe subscription, which must end before the Organization can be Enterprise so it is not billed twice';
  const TRIAL_REFUSAL =
    'Hopper Labs is on a free trial, which charges its card when the trial ends. The trial must end before the Organization can be Enterprise, so it is not billed twice';

  it.each([
    ['active', LIVE_SUBSCRIPTION_REFUSAL, 'paid'],
    ['trialing', TRIAL_REFUSAL, 'trial'],
    ['past_due', LIVE_SUBSCRIPTION_REFUSAL, 'payment-failing'],
  ])(
    'is refused while a Stripe subscription is %s, saying why, and changes nothing',
    async (status, message, state) => {
      await givenStripeSubscription(status, {
        trialEndsAt:
          status === 'trialing' ? new Date(Date.now() + 9 * DAY) : null,
      });

      const res = await on(5, 2);

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'STRIPE_SUBSCRIPTION_ACTIVE',
        message,
      });
      expect((await row()).enterprise).toBe(false);
      expect(await allowance()).toEqual({
        plan: 'starter',
        servers: 3,
        cloudEnvironments: 3,
      });
      expect(
        (await trail(grace.cookie)).filter(
          (r) => r.userEmail === HOSTED_STAFF.email,
        ),
      ).toEqual([]);
      expect(await listed()).toMatchObject({
        enterprise: false,
        plan: 'starter',
        state: { kind: state },
      });
    },
  );

  it('is allowed once the Stripe subscription has ended, and the lapse no longer freezes it', async () => {
    const lapsedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await givenStripeSubscription('canceled', {
      lapsedAt,
      lapseWarnedAt: lapsedAt,
    });
    const frozen = await request(http)
      .post('/projects')
      .set('Cookie', grace.cookie)
      .send({ name: 'shop' });
    expect(frozen.status).toBe(403);

    expect((await on(4, 1)).status).toBe(200);

    expect(await allowance()).toMatchObject({ plan: 'enterprise' });
    const standing = await request(http)
      .get('/billing/standing')
      .set('Cookie', grace.cookie);
    expect(standing.body).toMatchObject({ frozen: false, causes: [] });
    const created = await request(http)
      .post('/projects')
      .set('Cookie', grace.cookie)
      .send({ name: 'shop' });
    expect(created.status).toBe(201);
  });

  async function standing() {
    const res = await request(http)
      .get('/billing/standing')
      .set('Cookie', grace.cookie);
    expect(res.status).toBe(200);
    return res.body as { frozen: boolean; causes: string[] };
  }

  const createProject = (name = 'shop') =>
    request(http).post('/projects').set('Cookie', grace.cookie).send({ name });

  function postWebhook(type: string, object: unknown) {
    const event = { type, data: { object } } as unknown as Stripe.Event;
    constructEvent.mockReturnValue(event);
    return request(http)
      .post('/billing/webhook')
      .set('stripe-signature', 't=1,v1=valid')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(event));
  }

  describe('switching it off', () => {
    it('returns the Organization to the no-plan allowance and freezes it', async () => {
      await on(5, 2);

      const res = await off();

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        enterprise: false,
        servers: 0,
        cloudEnvironments: 0,
      });
      expect(await allowance()).toEqual({
        plan: null,
        servers: 0,
        cloudEnvironments: 0,
      });
      expect(await listed()).toMatchObject({
        enterprise: false,
        servers: { allowed: 0 },
        cloudEnvironments: { allowed: 0 },
      });
      expect(await standing()).toMatchObject({
        frozen: true,
        causes: ['lapsed'],
      });
      const refused = await createProject();
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({
        code: 'ORGANIZATION_FROZEN',
        message: 'Pay to continue',
      });
    });

    it('emails "your plan has ended" to the owners and admins, once', async () => {
      await on(5, 2);
      await signUpMember(http, grace.cookie, {
        email: 'ada@example.com',
        name: 'Ada Lovelace',
        role: 'admin',
      });
      await signUpMember(http, grace.cookie, {
        email: 'ida@example.com',
        role: 'member',
      });
      mail.clear();

      const before = Date.now();
      await off();
      await off();

      const deletesOn = format(new Date(before + 30 * DAY), 'MMM dd, yyyy');
      for (const address of ['grace@example.com', 'ada@example.com']) {
        const sent = mail.to(address);
        expect(sent).toHaveLength(1);
        expect(sent[0].email.subject).toBe(
          'Your Cloudgate plan for Hopper Labs has ended',
        );
        const html = sent[0].email.html.replace(/<!-- -->/g, '');
        expect(html).toContain('Enterprise agreement with Octabyte has ended');
        expect(html).toContain(`deleted on ${deletesOn}`);
        expect(html).not.toContain('cancellation');
      }
      expect(mail.to('ida@example.com')).toEqual([]);
    });

    it('names the members left on a custom role to the owners and admins, once', async () => {
      await on(5, 2);
      await signUpMember(http, grace.cookie, {
        email: 'ada@example.com',
        name: 'Ada Lovelace',
        role: 'admin',
      });
      const ida = await signUpMember(http, grace.cookie, {
        email: 'ida@example.com',
        name: 'Ida Rhodes',
        role: 'member',
      });
      await ctx.db.insert(organizationRole).values({
        organizationId: grace.organizationId,
        role: 'auditor',
        permission: { auditLog: ['read'] },
      });
      await ctx.db
        .update(member)
        .set({ role: 'auditor' })
        .where(
          and(
            eq(member.organizationId, grace.organizationId),
            eq(member.userId, ida.id),
          ),
        );
      mail.clear();

      await off();
      await off();

      for (const address of ['grace@example.com', 'ada@example.com']) {
        const sent = mail
          .to(address)
          .filter((one) => /custom role/.test(one.email.subject));
        expect(sent).toHaveLength(1);
        expect(sent[0].email.subject).toBe(
          '1 member of Hopper Labs is on a custom role that no longer works',
        );
        const html = sent[0].email.html.replace(/<!-- -->/g, '');
        expect(html).toContain(
          'Hopper Labs&#x27;s Enterprise agreement with Octabyte has ended.',
        );
        expect(html).toContain('Ida Rhodes (ida@example.com)');
      }
      expect(mail.to('ida@example.com')).toEqual([]);
    });

    it('starts the deletion clock', async () => {
      await on(5, 2);
      await off();
      const { lapsedAt } = await row();
      expect(lapsedAt).not.toBeNull();
      const clock = ctx.app.get(LapseClockService);

      expect(
        (await clock.tick(new Date(lapsedAt!.getTime() + 22.9 * DAY)))
          .deletionWarned,
      ).toEqual([]);
      expect(
        (await clock.tick(new Date(lapsedAt!.getTime() + 23 * DAY)))
          .deletionWarned,
      ).toEqual([grace.organizationId]);
    });

    it('sends nothing for an Organization that was not Enterprise', async () => {
      await givenStripeSubscription('active');

      expect((await off()).status).toBe(200);

      expect((await row()).lapsedAt).toBeNull();
      expect(mail.to('grace@example.com')).toEqual([]);
      expect(await standing()).toMatchObject({ frozen: false });
    });

    it('subscribing afterwards lifts the freeze', async () => {
      await on(5, 2);
      await off();
      retrieveSubscription.mockResolvedValue(activeStarter);

      const res = await postWebhook('checkout.session.completed', {
        metadata: { organizationId: grace.organizationId },
        customer: 'cus_after_enterprise',
        subscription: 'sub_after_enterprise',
      });

      expect(res.status).toBe(200);
      expect(await standing()).toMatchObject({ frozen: false, causes: [] });
      expect(await allowance()).toEqual({
        plan: 'starter',
        servers: 3,
        cloudEnvironments: 3,
      });
      expect((await createProject('back-again')).status).toBe(201);
    });
  });

  it('remembers that the Organization was Enterprise, from the first switch-on, after it is switched off', async () => {
    expect(await hasBeenEnterprise(ctx.db, grace.organizationId)).toBe(false);

    await on(5, 2);
    const first = (await row()).firstEnterpriseAt;
    expect(first).not.toBeNull();
    await on(7, 3);
    await off();
    await on(1, 1);
    await off();

    expect((await row()).firstEnterpriseAt).toEqual(first);
    expect(await hasBeenEnterprise(ctx.db, grace.organizationId)).toBe(true);
  });

  it('counts lowered below use stop nothing, and refuse the next addition', async () => {
    await on(5, 2);
    await givenServers(3);

    expect((await on(1, 0)).status).toBe(200);

    expect(await serverCount()).toBe(3);
    expect(await listed()).toMatchObject({
      servers: { used: 3, allowed: 1 },
    });
    const refused = await addServer();
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      code: 'ALLOWANCE_FULL',
      message:
        'This Organization has 3 Servers, all its Enterprise agreement allows. Contact us at support@octabyte.io to raise its counts.',
    });
    expect(await serverCount()).toBe(3);
  });

  it("writes each in the Organization's own log, naming the Operator and marked as Octabyte, with a copy in the Instance organization's", async () => {
    await on(5, 2);
    await off();

    const operatorRow = (organizationId: string, enterprise: boolean) =>
      expect.objectContaining({
        organizationId,
        userEmail: HOSTED_STAFF.email,
        userName: `${HOSTED_STAFF.firstName} ${HOSTED_STAFF.lastName}`,
        action: 'update',
        resourceType: 'organization',
        resourceId: grace.organizationId,
        resourceName: 'Hopper Labs',
        metadata: expect.stringContaining(
          `"enterprise":${enterprise}`,
        ) as string,
      }) as AuditRow;

    const customers = await trail(grace.cookie);
    expect(customers).toEqual(
      expect.arrayContaining([
        operatorRow(grace.organizationId, true),
        operatorRow(grace.organizationId, false),
      ]),
    );
    const byOperator = customers.filter(
      (r) => r.userEmail === HOSTED_STAFF.email,
    );
    expect(byOperator).toHaveLength(2);
    for (const written of byOperator) {
      expect(written.userRole).toBe('operator');
      expect(JSON.parse(written.metadata!)).toMatchObject({
        actedBy: 'Octabyte',
        type: 'setEnterprise',
      });
    }
    expect(byOperator.map((r) => JSON.parse(r.metadata!) as object)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          enterprise: true,
          servers: 5,
          cloudEnvironments: 2,
        }),
      ]),
    );

    const instance = await trail(staffCookie);
    expect(instance).toEqual(
      expect.arrayContaining([
        operatorRow(instanceOrganizationId, true),
        operatorRow(instanceOrganizationId, false),
      ]),
    );
  });

  describe('refusals', () => {
    it('refuses anybody but an Operator, and writes nothing', async () => {
      const member = await signUpMember(http, staffCookie, {
        email: 'ops-member@octabyte.test',
        role: 'member',
      });

      for (const cookie of [grace.cookie, member.cookie]) {
        const res = await setEnterprise(
          { enterprise: true, servers: 5, cloudEnvironments: 2 },
          grace.organizationId,
          cookie,
        );
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ message: OPERATOR_REFUSAL });
      }
      expect(await row()).toBeUndefined();
    });

    it('lets an admin of the Instance organization switch it', async () => {
      const admin = await signUpMember(http, staffCookie, {
        email: 'ops-admin@octabyte.test',
        role: 'admin',
      });

      const res = await setEnterprise(
        { enterprise: true, servers: 1, cloudEnvironments: 1 },
        grace.organizationId,
        admin.cookie,
      );
      expect(res.status).toBe(200);
    });

    it.each([
      ['no counts', { enterprise: true }],
      [
        'a negative count',
        { enterprise: true, servers: -1, cloudEnvironments: 1 },
      ],
      [
        'a fractional count',
        { enterprise: true, servers: 1.5, cloudEnvironments: 1 },
      ],
      ['no switch', { servers: 1, cloudEnvironments: 1 }],
    ])('refuses %s with 400', async (_case, body) => {
      expect((await setEnterprise(body)).status).toBe(400);
      expect(await row()).toBeUndefined();
    });

    it('answers 404 for an unknown Organization', async () => {
      const res = await setEnterprise(
        { enterprise: true, servers: 1, cloudEnvironments: 1 },
        'no-such-organization',
      );
      expect(res.status).toBe(404);
    });

    it('does not exist on a Self-hosted instance', async () => {
      jest
        .spyOn(ctx.app.get(InstanceMode), 'isHosted', 'get')
        .mockReturnValue(false);

      expect((await on(5, 2)).status).toBe(404);
      expect((await off()).status).toBe(404);
      expect(await row()).toBeUndefined();
    });
  });
});
