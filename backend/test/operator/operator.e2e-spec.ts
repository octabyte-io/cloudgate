// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first load.
import { useHostedMode } from '../utils/hosted-mode';
const hosted = useHostedMode();

import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import request from 'supertest';
import { App } from 'supertest/types';

import { subscription } from '../../src/cloud/billing/billing.schema';
import { STRIPE_API } from '../../src/cloud/billing/stripe-api';
import {
  cloudAccount,
  environment,
  server as serverTable,
} from '../../src/db/schema';
import { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import { MailService } from '../../src/mail/mail.service';
import { organization } from '../../src/organizations/organizations.schema';
import { fakeStripe } from '../utils/fake-stripe';
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

const constructEvent = jest.fn<Stripe.Event, [Buffer | string, string]>();
const stripe = fakeStripe({ constructEvent });

const DAY = 24 * 60 * 60 * 1000;

const OPERATOR_REFUSAL =
  'Only an owner or admin of the Instance organization can use the Operator page';

/** Exactly what one listed Organization carries (ADR-0050). */
const LISTED_FIELDS = [
  'attached',
  'cloudEnvironments',
  'createdAt',
  'enterprise',
  'id',
  'memberCount',
  'name',
  'ownerEmail',
  'paidBy',
  'plan',
  'servers',
  'state',
  'suspension',
  'trialUsed',
].sort();

interface Listed {
  id: string;
  name: string;
  createdAt: string;
  ownerEmail: string;
  memberCount: number;
  plan: string | null;
  state: { kind: string; endsAt?: string; on?: string };
  trialUsed: boolean;
  servers: { used: number; allowed: number };
  cloudEnvironments: { used: number; allowed: number };
  enterprise: boolean;
  suspension: { reason: string; suspendedAt: string } | null;
  paidBy: { id: string; name: string } | null;
  attached: Array<{ id: string; name: string }>;
}

/**
 * The Operator page's read (ADR-0050): on the Hosted instance an owner
 * or admin of the Instance organization — a person, never an Agent — lists
 * every Organization's account facts and nothing from inside a Project.
 * Anybody else is refused, and on a Self-hosted instance the API does not
 * exist.
 */
describe('The Operator page (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let staffCookie: string;
  let instanceOrganizationId: string;
  let grace: HostedCustomer;
  let lin: HostedCustomer;
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
    mail.clear();
    instanceOrganizationId = (await openHostedSignUp(ctx.db)).organizationId;
    staffCookie = await signIn(HOSTED_STAFF.email, HOSTED_STAFF.password);
    grace = await signUpHostedCustomer(http, mail, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
    lin = await signUpHostedCustomer(http, mail, {
      name: 'Lin Wu',
      email: 'lin@example.com',
      password: 'super-secret-password',
      organizationName: 'Wu Contracting',
    });
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

  const list = (cookie: string) =>
    request(http).get('/operator/organizations').set('Cookie', cookie);

  function postWebhook(type: string, object: unknown) {
    const event = { type, data: { object } } as unknown as Stripe.Event;
    constructEvent.mockReturnValue(event);
    return request(http)
      .post('/billing/webhook')
      .set('stripe-signature', 't=1,v1=valid')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(event));
  }

  /** What the page reads about a row's billing. */
  function pick(row: Listed | undefined) {
    return {
      plan: row?.plan,
      state: row?.state,
      trialUsed: row?.trialUsed,
    };
  }

  /** Arrangement only: Hopper Labs on the Hosted plan with one Add-on, two Servers and one Cloud Environment. */
  async function givenHopperLabsHoldings() {
    await ctx.db.insert(subscription).values({
      organizationId: grace.organizationId,
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      plan: 'starter',
      status: 'past_due',
      addOns: 1,
      firstSubscribedAt: new Date(),
    });
    await ctx.db.insert(serverTable).values([
      {
        name: 'box-1',
        ipAddress: '203.0.113.10',
        port: 22,
        organizationId: grace.organizationId,
      },
      {
        name: 'box-2',
        ipAddress: '203.0.113.11',
        port: 22,
        organizationId: grace.organizationId,
      },
    ]);
    const project = await request(http)
      .post('/projects')
      .set('Cookie', grace.cookie)
      .send({ name: 'shop' });
    expect(project.status).toBe(201);
    const [account] = await ctx.db
      .insert(cloudAccount)
      .values({
        organizationId: grace.organizationId,
        name: 'Production AWS',
        cloud: 'aws',
        cloudId: '123456789012',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        deployRoleArn: 'arn:aws:iam::123456789012:role/cloudgate-deploy',
        taskExecutionRoleArn:
          'arn:aws:iam::123456789012:role/cloudgate-task-execution',
        externalId: 'external-id-1',
        policyVersion: 3,
        lastCheckedAt: new Date().toISOString(),
        lastCheckResult: 'passed',
      })
      .returning();
    await ctx.db.insert(environment).values({
      name: 'cloud',
      projectId: (project.body as { projectId: string }).projectId,
      deployTarget: {
        kind: 'cloud',
        cloudAccountId: account.cloudAccountId,
        region: 'eu-central-1',
      },
    });
  }

  /** Arrangement only: what an Operator's Enterprise switch will write. */
  async function givenEnterprise(organizationId: string) {
    await ctx.db.insert(subscription).values({
      organizationId,
      enterprise: true,
      enterpriseServers: 10,
      enterpriseCloudEnvironments: 5,
      firstEnterpriseAt: new Date(),
    });
  }

  describe('for an Operator', () => {
    it("lists every Organization's account facts, with exactly the listed fields", async () => {
      await givenHopperLabsHoldings();
      await givenEnterprise(lin.organizationId);
      // A second person in Hopper Labs, and an Agent, which is not a person.
      await signUpMember(http, grace.cookie, { email: 'ida@example.com' });
      const agent = await request(http)
        .post('/agents')
        .set('Cookie', grace.cookie)
        .send({ name: 'deploy-bot' });
      expect(agent.status).toBe(201);

      const res = await list(staffCookie);

      expect(res.status).toBe(200);
      const rows = res.body as Listed[];
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(LISTED_FIELDS);
      }
      expect(rows.map((row) => row.name)).toEqual([
        HOSTED_STAFF.organizationName,
        'Hopper Labs',
        'Wu Contracting',
      ]);
      const [instance, hopper, wu] = rows;
      expect(instance).toMatchObject({
        id: instanceOrganizationId,
        ownerEmail: HOSTED_STAFF.email,
        memberCount: 1,
        plan: null,
        state: { kind: 'none' },
        trialUsed: false,
        servers: { used: 0, allowed: 0 },
        cloudEnvironments: { used: 0, allowed: 0 },
        enterprise: false,
      });
      expect(hopper).toEqual({
        id: grace.organizationId,
        name: 'Hopper Labs',
        createdAt: expect.any(String) as string,
        ownerEmail: 'grace@example.com',
        memberCount: 2,
        plan: 'starter',
        state: { kind: 'payment-failing' },
        trialUsed: true,
        servers: { used: 2, allowed: 4 },
        cloudEnvironments: { used: 1, allowed: 4 },
        enterprise: false,
        suspension: null,
        paidBy: null,
        attached: [],
      });
      expect(wu).toMatchObject({
        id: lin.organizationId,
        ownerEmail: 'lin@example.com',
        memberCount: 1,
        plan: 'enterprise',
        state: { kind: 'paid' },
        trialUsed: true,
        servers: { used: 0, allowed: 10 },
        cloudEnvironments: { used: 0, allowed: 5 },
        enterprise: true,
      });
      expect(Number.isNaN(Date.parse(hopper.createdAt))).toBe(false);
    });

    it('shows nothing from inside a Project: no Server address, Project or Environment', async () => {
      await givenHopperLabsHoldings();

      const res = await list(staffCookie);

      expect(res.status).toBe(200);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('203.0.113');
      expect(text).not.toContain('shop');
      expect(text).not.toContain('Production AWS');
      expect(text).not.toContain('123456789012');
    });

    it('answers an admin of the Instance organization too', async () => {
      const admin = await signUpMember(http, staffCookie, {
        email: 'ops-admin@octabyte.test',
        role: 'admin',
      });

      const res = await list(admin.cookie);

      expect(res.status).toBe(200);
      expect((res.body as Listed[]).map((row) => row.name)).toContain(
        'Hopper Labs',
      );
      const access = await request(http)
        .get('/operator/access')
        .set('Cookie', admin.cookie);
      expect(access.body).toEqual({ operator: true });
    });

    it('records nothing in any audit log for viewing', async () => {
      const before = await request(http)
        .get('/audit-logs')
        .set('Cookie', staffCookie);

      expect((await list(staffCookie)).status).toBe(200);

      const after = await request(http)
        .get('/audit-logs')
        .set('Cookie', staffCookie);
      expect(before.status).toBe(200);
      expect(after.status).toBe(200);
      expect(after.body).toEqual(before.body);
    });
  });

  describe('Plan, State and Trial used', () => {
    const TRIAL_ENDS = new Date(Date.now() + 20 * DAY);
    const MONTH_ENDS = new Date(Date.now() + 12 * DAY);
    const LONG_AGO = new Date(Date.now() - 40 * DAY);

    /** A Stripe subscription row, as the webhook stores one. */
    const paying = {
      stripeCustomerId: 'cus_x',
      stripeSubscriptionId: 'sub_x',
      plan: 'business',
      status: 'active',
      firstSubscribedAt: LONG_AGO,
    } as const;

    /**
     * Arrangement only: one Organization per State, owned by Grace, each with
     * the row the webhook, the downgrade or an Operator leaves behind.
     */
    const STATES: Array<{
      name: string;
      row: Omit<typeof subscription.$inferInsert, 'organizationId'> | null;
      plan: string | null;
      state: Listed['state'];
      trialUsed: boolean;
    }> = [
      {
        name: 'No plan yet',
        row: null,
        plan: null,
        state: { kind: 'none' },
        trialUsed: false,
      },
      {
        name: 'On a trial',
        row: {
          ...paying,
          stripeCustomerId: 'cus_trial',
          stripeSubscriptionId: 'sub_trial',
          status: 'trialing',
          trialEndsAt: TRIAL_ENDS,
          firstSubscribedAt: new Date(),
        },
        plan: 'business',
        state: { kind: 'trial', endsAt: TRIAL_ENDS.toISOString() },
        trialUsed: true,
      },
      {
        name: 'Paying',
        row: { ...paying, stripeCustomerId: 'cus_paid', plan: 'starter' },
        plan: 'starter',
        state: { kind: 'paid' },
        trialUsed: true,
      },
      {
        name: 'Card failing',
        row: {
          ...paying,
          stripeCustomerId: 'cus_failing',
          status: 'past_due',
          paymentFailedAt: new Date(),
        },
        plan: 'business',
        state: { kind: 'payment-failing' },
        trialUsed: true,
      },
      {
        name: 'Cancelled at month end',
        row: { ...paying, stripeCustomerId: 'cus_ends', cancelAt: MONTH_ENDS },
        plan: 'business',
        state: { kind: 'ends', endsAt: MONTH_ENDS.toISOString() },
        trialUsed: true,
      },
      {
        name: 'Downgrading',
        row: {
          ...paying,
          stripeCustomerId: 'cus_downgrade',
          stripeScheduleId: 'sub_sched_1',
          downgradeAt: MONTH_ENDS,
        },
        plan: 'business',
        state: { kind: 'moves-to-starter', on: MONTH_ENDS.toISOString() },
        trialUsed: true,
      },
      {
        name: 'Lapsed',
        row: {
          ...paying,
          stripeCustomerId: 'cus_lapsed',
          status: 'canceled',
          lapsedAt: LONG_AGO,
        },
        plan: null,
        state: { kind: 'lapsed' },
        trialUsed: true,
      },
      {
        name: 'Suspended',
        row: {
          ...paying,
          stripeCustomerId: 'cus_suspended',
          suspendedAt: new Date(),
          suspendedReason: 'Abuse',
        },
        plan: 'business',
        state: { kind: 'suspended' },
        trialUsed: true,
      },
      {
        name: 'Was Enterprise',
        row: {
          firstEnterpriseAt: LONG_AGO,
          lapsedAt: new Date(),
        },
        plan: null,
        state: { kind: 'lapsed' },
        trialUsed: true,
      },
      {
        name: 'Enterprise',
        row: {
          enterprise: true,
          enterpriseServers: 4,
          enterpriseCloudEnvironments: 2,
          firstEnterpriseAt: new Date(),
        },
        plan: 'enterprise',
        state: { kind: 'paid' },
        trialUsed: true,
      },
    ];

    it('shows each Organization in its State, with its plan and whether its trial is used', async () => {
      for (const [index, given] of STATES.entries()) {
        const id = `org-state-${index}`;
        await ctx.db.insert(organization).values({
          id,
          name: given.name,
          slug: id,
          createdAt: new Date(),
          ownerId: grace.id,
        });
        if (given.row) {
          await ctx.db
            .insert(subscription)
            .values({ organizationId: id, ...given.row });
        }
      }

      const res = await list(staffCookie);

      expect(res.status).toBe(200);
      const rows = res.body as Listed[];
      for (const given of STATES) {
        expect({
          name: given.name,
          ...pick(rows.find((row) => row.name === given.name)),
        }).toEqual({
          name: given.name,
          plan: given.plan,
          state: given.state,
          trialUsed: given.trialUsed,
        });
      }
    });

    it('follows the webhook: a trial cancelled at Stripe ends on its last day, and kept, is a trial again', async () => {
      await ctx.db.insert(subscription).values({
        organizationId: grace.organizationId,
        stripeCustomerId: 'cus_trial',
        stripeSubscriptionId: 'sub_trial',
        plan: 'starter',
        status: 'incomplete',
      });
      const trialEnd = Math.floor(TRIAL_ENDS.getTime() / 1000);
      const trialing = (cancel: boolean) =>
        ({
          id: 'sub_trial',
          customer: 'cus_trial',
          status: 'trialing',
          trial_end: trialEnd,
          cancel_at: cancel ? trialEnd : null,
          cancel_at_period_end: cancel,
          items: {
            data: [
              {
                id: 'si_plan',
                price: { id: hosted.STARTER_PLAN_PRICE_ID },
                quantity: 1,
              },
            ],
          },
        }) as unknown as Stripe.Subscription;
      const hopper = async () =>
        pick(
          ((await list(staffCookie)).body as Listed[]).find(
            (row) => row.id === grace.organizationId,
          ),
        );
      const endsAt = new Date(trialEnd * 1000).toISOString();

      expect(
        (await postWebhook('customer.subscription.updated', trialing(false)))
          .status,
      ).toBe(200);
      expect(await hopper()).toEqual({
        plan: 'starter',
        state: { kind: 'trial', endsAt },
        trialUsed: true,
      });

      await postWebhook('customer.subscription.updated', trialing(true));
      expect((await hopper()).state).toEqual({ kind: 'ends', endsAt });

      await postWebhook('customer.subscription.updated', trialing(false));
      expect((await hopper()).state).toEqual({ kind: 'trial', endsAt });
    });
  });

  describe('Paying and Attached Organizations', () => {
    let alan: HostedCustomer;
    const hopperLabs = () => ({
      id: grace.organizationId,
      name: 'Hopper Labs',
    });

    beforeEach(async () => {
      alan = await signUpHostedCustomer(http, mail, {
        name: 'Alan Turing',
        email: 'alan@example.com',
        password: 'super-secret-password',
        organizationName: 'Turing Works',
      });
    });

    /**
     * Arrangement only: what "Add an Organization to this plan" will write —
     * the link, and the Attached Organization's own row with no plan and its
     * never-cleared mark. Nothing on the Operator page can write it.
     */
    async function givenAttached(organizationId: string, paidBy: string) {
      await ctx.db
        .update(organization)
        .set({ paidByOrganizationId: paidBy })
        .where(eq(organization.id, organizationId));
      const values = { firstAttachedAt: new Date() };
      await ctx.db
        .insert(subscription)
        .values({ organizationId, ...values })
        .onConflictDoUpdate({
          target: subscription.organizationId,
          set: values,
        });
    }

    /** Arrangement only: `count` Servers in the Organization. */
    async function givenServers(organizationId: string, count: number) {
      await ctx.db.insert(serverTable).values(
        Array.from({ length: count }, (_, index) => ({
          name: `${organizationId}-server-${index + 1}`,
          ipAddress: `198.51.100.${index + 1}`,
          port: 22,
          organizationId,
        })),
      );
    }

    /**
     * Arrangement only: Wu Contracting and then Turing Works attached to
     * Hopper Labs, which holds 1 Server to Wu's 2 and Turing's none.
     */
    async function givenHopperPaysForWuAndTuring() {
      await givenAttached(lin.organizationId, grace.organizationId);
      await givenAttached(alan.organizationId, grace.organizationId);
      await givenServers(grace.organizationId, 1);
      await givenServers(lin.organizationId, 2);
    }

    /** The same, with Hopper Labs on Business with 7 Add-ons: 10 of each. */
    async function givenHopperOnBusinessPaysForTwo() {
      await ctx.db.insert(subscription).values({
        organizationId: grace.organizationId,
        stripeCustomerId: 'cus_hopper',
        stripeSubscriptionId: 'sub_hopper',
        plan: 'business',
        status: 'active',
        addOns: 7,
        firstSubscribedAt: new Date(),
      });
      await givenHopperPaysForWuAndTuring();
    }

    async function rowsByName(): Promise<Record<string, Listed>> {
      const res = await list(staffCookie);
      expect(res.status).toBe(200);
      return Object.fromEntries(
        (res.body as Listed[]).map((row) => [row.name, row]),
      );
    }

    it('keeps the list flat: a Paying row with the whole pool and who it pays for, and Attached rows with their share', async () => {
      await givenHopperOnBusinessPaysForTwo();

      const res = await list(staffCookie);

      expect(res.status).toBe(200);
      const rows = res.body as Listed[];
      expect(rows.map((row) => row.name)).toEqual([
        HOSTED_STAFF.organizationName,
        'Hopper Labs',
        'Wu Contracting',
        'Turing Works',
      ]);
      const [, hopper, wu, turing] = rows;
      expect(hopper).toMatchObject({
        plan: 'business',
        state: { kind: 'paid' },
        paidBy: null,
        attached: [
          { id: lin.organizationId, name: 'Wu Contracting' },
          { id: alan.organizationId, name: 'Turing Works' },
        ],
        servers: { used: 3, allowed: 10 },
        cloudEnvironments: { used: 0, allowed: 10 },
      });
      expect(wu).toMatchObject({
        plan: 'business',
        state: { kind: 'paid' },
        trialUsed: true,
        paidBy: hopperLabs(),
        attached: [],
        servers: { used: 2, allowed: 10 },
        cloudEnvironments: { used: 0, allowed: 10 },
        enterprise: false,
        suspension: null,
      });
      expect(turing).toMatchObject({
        plan: 'business',
        state: { kind: 'paid' },
        trialUsed: true,
        paidBy: hopperLabs(),
        attached: [],
        servers: { used: 0, allowed: 10 },
      });
    });

    it("shows an Attached Organization its Paying Organization's State when it has none of its own", async () => {
      await givenHopperOnBusinessPaysForTwo();
      const TRIAL_ENDS = new Date(Date.now() + 20 * DAY);

      await ctx.db
        .update(subscription)
        .set({ status: 'past_due' })
        .where(eq(subscription.organizationId, grace.organizationId));
      expect((await rowsByName())['Turing Works'].state).toEqual({
        kind: 'payment-failing',
      });

      await ctx.db
        .update(subscription)
        .set({ status: 'trialing', trialEndsAt: TRIAL_ENDS })
        .where(eq(subscription.organizationId, grace.organizationId));
      expect((await rowsByName())['Turing Works'].state).toEqual({
        kind: 'trial',
        endsAt: TRIAL_ENDS.toISOString(),
      });
    });

    it('suspends a Paying Organization alone: its Attached Organizations stay running', async () => {
      await givenHopperOnBusinessPaysForTwo();

      const suspended = await request(http)
        .post(`/operator/organizations/${grace.organizationId}/suspension`)
        .set('Cookie', staffCookie)
        .send({ reason: 'Abuse report' });
      expect(suspended.status).toBe(200);

      const rows = await rowsByName();
      expect(rows['Hopper Labs'].state).toEqual({ kind: 'suspended' });
      for (const name of ['Wu Contracting', 'Turing Works']) {
        expect(rows[name]).toMatchObject({
          state: { kind: 'paid' },
          suspension: null,
        });
      }
    });

    it("shows an Attached Organization its own suspension over its Paying Organization's State", async () => {
      await givenHopperOnBusinessPaysForTwo();

      const suspended = await request(http)
        .post(`/operator/organizations/${alan.organizationId}/suspension`)
        .set('Cookie', staffCookie)
        .send({ reason: 'Abuse report' });
      expect(suspended.status).toBe(200);

      const rows = await rowsByName();
      expect(rows['Turing Works']).toMatchObject({
        state: { kind: 'suspended' },
        paidBy: hopperLabs(),
        suspension: { reason: 'Abuse report' },
      });
      expect(rows['Hopper Labs'].state).toEqual({ kind: 'paid' });
      expect(rows['Wu Contracting'].state).toEqual({ kind: 'paid' });
    });

    it('measures Enterprise counts against the whole pool, and turning Enterprise off lapses its Attached Organizations with it', async () => {
      await givenHopperPaysForWuAndTuring();

      const on = await request(http)
        .put(`/operator/organizations/${grace.organizationId}/enterprise`)
        .set('Cookie', staffCookie)
        .send({ enterprise: true, servers: 2, cloudEnvironments: 1 });
      expect(on.status).toBe(200);

      let rows = await rowsByName();
      expect(rows['Hopper Labs']).toMatchObject({
        plan: 'enterprise',
        enterprise: true,
        servers: { used: 3, allowed: 2 },
        cloudEnvironments: { used: 0, allowed: 1 },
      });
      expect(rows['Wu Contracting']).toMatchObject({
        plan: 'enterprise',
        state: { kind: 'paid' },
        servers: { used: 2, allowed: 2 },
      });

      const off = await request(http)
        .put(`/operator/organizations/${grace.organizationId}/enterprise`)
        .set('Cookie', staffCookie)
        .send({ enterprise: false });
      expect(off.status).toBe(200);

      rows = await rowsByName();
      expect(rows['Hopper Labs']).toMatchObject({
        state: { kind: 'lapsed' },
        attached: [
          { id: lin.organizationId, name: 'Wu Contracting' },
          { id: alan.organizationId, name: 'Turing Works' },
        ],
      });
      for (const name of ['Wu Contracting', 'Turing Works']) {
        expect(rows[name]).toMatchObject({
          plan: null,
          state: { kind: 'lapsed' },
          paidBy: hopperLabs(),
        });
      }
    });

    it('shows an Organization lapsed after "Stop paying for it" as an ordinary lapsed one, its trial used', async () => {
      await givenHopperOnBusinessPaysForTwo();
      // What "Stop paying for it" will write: the link cleared and its own
      // row lapsed.
      await ctx.db
        .update(organization)
        .set({ paidByOrganizationId: null })
        .where(eq(organization.id, lin.organizationId));
      await ctx.db
        .update(subscription)
        .set({ lapsedAt: new Date() })
        .where(eq(subscription.organizationId, lin.organizationId));

      const rows = await rowsByName();
      expect(rows['Wu Contracting']).toMatchObject({
        plan: null,
        state: { kind: 'lapsed' },
        trialUsed: true,
        paidBy: null,
        attached: [],
        servers: { used: 2, allowed: 0 },
      });
      expect(rows['Hopper Labs']).toMatchObject({
        attached: [{ id: alan.organizationId, name: 'Turing Works' }],
        servers: { used: 1, allowed: 10 },
      });
    });

    it('offers no write that attaches, detaches or re-points an Organization', async () => {
      await givenHopperOnBusinessPaysForTwo();
      const attempts = [
        () =>
          request(http).put(
            `/operator/organizations/${alan.organizationId}/paid-by`,
          ),
        () =>
          request(http).delete(
            `/operator/organizations/${alan.organizationId}/paid-by`,
          ),
        () =>
          request(http).post(
            `/operator/organizations/${grace.organizationId}/attached`,
          ),
        () =>
          request(http).patch(`/operator/organizations/${alan.organizationId}`),
      ];

      for (const attempt of attempts) {
        const res = await attempt()
          .set('Cookie', staffCookie)
          .send({ paidByOrganizationId: lin.organizationId });
        expect(res.status).toBe(404);
      }
      expect((await rowsByName())['Turing Works'].paidBy).toEqual(hopperLabs());
    });
  });

  describe('for anybody else', () => {
    it('refuses an owner of another Organization', async () => {
      const res = await list(grace.cookie);

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ message: OPERATOR_REFUSAL });
      const access = await request(http)
        .get('/operator/access')
        .set('Cookie', grace.cookie);
      expect(access.status).toBe(200);
      expect(access.body).toEqual({ operator: false });
    });

    it('refuses a member of the Instance organization below admin', async () => {
      const member = await signUpMember(http, staffCookie, {
        email: 'ops-member@octabyte.test',
        role: 'member',
      });

      const res = await list(member.cookie);

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ message: OPERATOR_REFUSAL });
    });

    it("refuses an Agent key, even one of the Instance organization's", async () => {
      const created = await request(http)
        .post('/agents')
        .set('Cookie', staffCookie)
        .send({ name: 'ops-bot' });
      expect(created.status).toBe(201);
      const { key } = created.body as { key: string };

      for (const path of ['/operator/organizations', '/operator/access']) {
        const res = await request(http).get(path).set('x-api-key', key);
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code: 'AGENT_NOT_ALLOWED_HERE' });
      }
    });

    it('refuses a caller who is not signed in', async () => {
      const res = await request(http).get('/operator/organizations');

      expect(res.status).toBe(401);
    });
  });

  describe('on a Self-hosted instance', () => {
    it('does not exist, even for the Instance organization owner', async () => {
      jest
        .spyOn(ctx.app.get(InstanceMode), 'isHosted', 'get')
        .mockReturnValue(false);

      for (const path of ['/operator/organizations', '/operator/access']) {
        const res = await request(http).get(path).set('Cookie', staffCookie);
        expect(res.status).toBe(404);
      }
    });
  });
});
