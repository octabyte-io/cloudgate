// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first import.
import { useHostedMode } from '../../utils/hosted-mode';
const hosted = useHostedMode();

import { eq, inArray } from 'drizzle-orm';
import type Stripe from 'stripe';
import request from 'supertest';
import { App } from 'supertest/types';
import { subscription } from '../../../src/cloud/billing/billing.schema';
import { LapseClockService } from '../../../src/cloud/billing/lapse-clock.service';
import { STRIPE_API } from '../../../src/cloud/billing/stripe-api';
import { member, organization } from '../../../src/db/schema';
import { MailService } from '../../../src/mail/mail.service';
import { fakeStripe } from '../../utils/fake-stripe';
import {
  HOSTED_STAFF,
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../../utils/hosted-sign-up';
import type { HostedCustomer } from '../../utils/hosted-sign-up';
import { createTestApp, TestAppContext } from '../../utils/test-app';

jest.setTimeout(180_000);

const DAY = 24 * 60 * 60 * 1000;
const BUSINESS_PRICE = hosted.BUSINESS_PLAN_PRICE_ID;

const retrieveSubscription = jest.fn<Promise<Stripe.Subscription>, [string]>();
const retrieveCustomer = jest.fn<
  Promise<Stripe.Customer | Stripe.DeletedCustomer>,
  [string]
>();
const constructEvent = jest.fn<Stripe.Event, [Buffer | string, string]>();
const stripe = fakeStripe({
  retrieveSubscription,
  retrieveCustomer,
  constructEvent,
});

/** Hopper Labs' Business subscription `sub_1`, as Stripe sends it. */
const stripeSubscription = (
  status: string,
  extra: Partial<Stripe.Subscription> = {},
) =>
  ({
    id: 'sub_1',
    customer: 'cus_1',
    status,
    items: {
      data: [{ id: 'si_plan', price: { id: BUSINESS_PRICE }, quantity: 1 }],
    },
    ...extra,
  }) as unknown as Stripe.Subscription;

const failedInvoice = {
  id: 'in_1',
  number: 'INV-9',
  customer: 'cus_1',
  subscription: 'sub_1',
  amount_due: 4900,
  amount_paid: 0,
  currency: 'usd',
  created: 1_767_225_600,
  hosted_invoice_url: 'https://invoice.stripe.test/INV-9',
  invoice_pdf: null,
};

const stripeEvent = (type: string, object: unknown) =>
  ({ type, data: { object } }) as unknown as Stripe.Event;

const PAYER_OWNER = 'grace@example.com';
const ATTACHED_OWNER = 'alan@example.com';
const ATTACHED_ADMIN = 'edsger@example.com';
const ATTACHED_MEMBER = 'donald@example.com';
const SECOND_OWNER = 'barbara@example.com';

const FROZEN_LAPSED = {
  code: 'ORGANIZATION_FROZEN',
  message: 'Pay to continue',
};

/**
 * **A Paying Organization's lapse reaches its Attached Organizations**
 * (ADR-0059). Hopper Labs, Grace's, is on Business and pays for Turing
 * Works (Alan's, with Edsger an admin and Donald a member) and Liskov Systems
 * (Barbara's). Nothing makes an Attached Organization through the API yet, so
 * the link is arranged on the rows, as "Add an Organization to this plan"
 * will write it; everything after that goes through the Stripe webhook, the
 * Operator's routes, the daily job's tick and the members' own requests.
 *
 * The lapse is written on Hopper Labs' row only, and the Attached
 * Organizations are frozen by reading it through the link: paying again
 * lifts them all, a suspension of Hopper Labs reaches none of them, and on
 * day 30 they are deleted together, with the platform's rows in both logs.
 */
describe("Attached Organizations: the Paying Organization's lapse (e2e)", () => {
  let ctx: TestAppContext;
  let http: App;
  let clock: LapseClockService;
  const mail = new MailRecorder();
  let staffCookie: string;
  let grace: HostedCustomer;
  let alan: HostedCustomer;
  let edsger: HostedCustomer;
  let barbara: HostedCustomer;
  /** Hopper Labs, the Paying Organization. */
  let payingId: string;
  /** Turing Works, attached to Hopper Labs. */
  let attachedId: string;
  /** Liskov Systems, attached to Hopper Labs too. */
  let secondId: string;

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: STRIPE_API, useValue: stripe },
        { provide: MailService, useValue: mail },
      ],
    });
    http = ctx.app.getHttpServer() as App;
    clock = ctx.app.get(LapseClockService);
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    await ctx.resetDb();
    await openHostedSignUp(ctx.db);
    staffCookie = await signIn(HOSTED_STAFF.email, HOSTED_STAFF.password);
    grace = await customer('Grace Hopper', PAYER_OWNER, 'Hopper Labs');
    alan = await customer('Alan Turing', ATTACHED_OWNER, 'Turing Works');
    edsger = await customer('Edsger Dijkstra', ATTACHED_ADMIN, 'Edsger Labs');
    const donald = await customer('Donald Knuth', ATTACHED_MEMBER, 'TeX');
    barbara = await customer('Barbara Liskov', SECOND_OWNER, 'Liskov Systems');
    payingId = grace.organizationId;
    attachedId = alan.organizationId;
    secondId = barbara.organizationId;
    await joins(edsger, attachedId, 'admin');
    await joins(donald, attachedId, 'member');

    await ctx.db.insert(subscription).values({
      organizationId: payingId,
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      plan: 'business',
      status: 'active',
      addOns: 0,
    });
    await givenAttached(attachedId);
    await givenAttached(secondId);
    mail.clear();
  });

  function customer(name: string, email: string, organizationName: string) {
    return signUpHostedCustomer(http, mail, {
      name,
      email,
      password: 'super-secret-password',
      organizationName,
    });
  }

  async function signIn(email: string, password: string): Promise<string> {
    const res = await request(http)
      .post('/api/auth/sign-in/email')
      .send({ email, password });
    expect(res.status).toBe(200);
    return (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
  }

  /** Arrangement only: `person` in `organizationId` with `role`. */
  async function joins(
    person: HostedCustomer,
    organizationId: string,
    role: string,
  ) {
    await ctx.db.insert(member).values({
      organizationId,
      userId: person.id,
      role,
      createdAt: new Date(),
    });
  }

  /**
   * Arrangement only: what "Add an Organization to this plan" will write —
   * the link to Hopper Labs, and the Attached Organization's own row with no
   * plan and its never-cleared mark.
   */
  async function givenAttached(organizationId: string): Promise<void> {
    await ctx.db
      .update(organization)
      .set({ paidByOrganizationId: payingId })
      .where(eq(organization.id, organizationId));
    const values = { firstAttachedAt: new Date('2026-11-01T00:00:00Z') };
    await ctx.db
      .insert(subscription)
      .values({ organizationId, ...values })
      .onConflictDoUpdate({ target: subscription.organizationId, set: values });
  }

  function postWebhook(event: Stripe.Event) {
    constructEvent.mockReturnValue(event);
    return request(http)
      .post('/billing/webhook')
      .set('stripe-signature', 't=1,v1=valid')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(event))
      .expect(200);
  }

  async function paymentFails() {
    retrieveSubscription.mockResolvedValue(stripeSubscription('past_due'));
    await postWebhook(stripeEvent('invoice.payment_failed', failedInvoice));
  }

  async function subscriptionEnds(reason: string | null) {
    await postWebhook(
      stripeEvent(
        'customer.subscription.deleted',
        stripeSubscription('canceled', {
          cancellation_details: { reason } as never,
        }),
      ),
    );
  }

  async function paysAgain() {
    retrieveSubscription.mockResolvedValue(
      stripeSubscription('active', { id: 'sub_2' }),
    );
    await postWebhook(
      stripeEvent('checkout.session.completed', {
        metadata: { organizationId: payingId },
        customer: 'cus_1',
        subscription: 'sub_2',
      }),
    );
  }

  /** Arrangement only: Hopper Labs is in its Business Free trial. */
  async function givenTrial(): Promise<void> {
    await ctx.db
      .update(subscription)
      .set({
        status: 'trialing',
        trialEndsAt: new Date('2026-12-05T12:00:00Z'),
        trialStartedSentAt: new Date(),
      })
      .where(eq(subscription.organizationId, payingId));
  }

  /** Hopper Labs' own marks. */
  async function payerMarks() {
    const [row] = await ctx.db
      .select()
      .from(subscription)
      .where(eq(subscription.organizationId, payingId));
    return row;
  }

  async function standing(person: HostedCustomer) {
    const res = await request(http)
      .get('/billing/standing')
      .set('Cookie', person.cookie);
    expect(res.status).toBe(200);
    return res.body as {
      frozen: boolean;
      causes: string[];
      paymentFailed: boolean;
      lapsedAt: string | null;
      payingOrganization: { name: string; paymentFailed: boolean } | null;
    };
  }

  /** A write any member may make: a new Project. */
  const newProject = (person: HostedCustomer, name = 'shop') =>
    request(http).post('/projects').set('Cookie', person.cookie).send({ name });

  /** The subjects each address received, oldest first. */
  const subjects = (address: string) =>
    mail.to(address).map((sent) => sent.email.subject);

  const after = (from: Date, days: number) =>
    new Date(from.getTime() + days * DAY);

  async function existing(ids: string[]): Promise<string[]> {
    const rows = await ctx.db
      .select({ id: organization.id })
      .from(organization)
      .where(inArray(organization.id, ids));
    return rows.map((row) => row.id).sort();
  }

  /** Nothing is ever written onto the Attached Organizations' own rows. */
  async function attachedLapses(): Promise<Array<Date | null>> {
    const rows = await ctx.db
      .select({ lapsedAt: subscription.lapsedAt })
      .from(subscription)
      .where(inArray(subscription.organizationId, [attachedId, secondId]));
    return rows.map((row) => row.lapsedAt);
  }

  describe('freezing through the link', () => {
    const lapses: Array<[string, () => Promise<void>]> = [
      ['the subscription is deleted', () => subscriptionEnds('payment_failed')],
      [
        'the Stripe customer is deleted',
        () =>
          postWebhook(
            stripeEvent('customer.deleted', { id: 'cus_1', deleted: true }),
          ).then(() => undefined),
      ],
      [
        'the Business Free trial is cancelled',
        async () => {
          await givenTrial();
          await subscriptionEnds('cancellation_requested');
        },
      ],
      [
        "the Business Free trial's first charge fails",
        async () => {
          await givenTrial();
          await subscriptionEnds('payment_failed');
        },
      ],
      [
        'an Operator turns Enterprise off',
        async () => {
          await ctx.db
            .update(subscription)
            .set({
              enterprise: true,
              plan: null,
              status: null,
              stripeSubscriptionId: null,
              enterpriseServers: 10,
              enterpriseCloudEnvironments: 10,
            })
            .where(eq(subscription.organizationId, payingId));
          const res = await request(http)
            .put(`/operator/organizations/${payingId}/enterprise`)
            .set('Cookie', staffCookie)
            .send({ enterprise: false });
          expect(res.status).toBe(200);
        },
      ],
    ];

    it.each(lapses)(
      'freezes every Attached Organization when %s, writing nothing on their rows',
      async (_how, lapse) => {
        await lapse();

        for (const person of [alan, barbara]) {
          await expect(standing(person)).resolves.toMatchObject({
            frozen: true,
            causes: ['lapsed'],
          });
          const refused = await newProject(person);
          expect(refused.status).toBe(403);
          expect(refused.body).toEqual(expect.objectContaining(FROZEN_LAPSED));
        }
        expect(await attachedLapses()).toEqual([null, null]);
      },
    );

    it('lifts the freeze for all of them when the Paying Organization pays again', async () => {
      await subscriptionEnds('payment_failed');
      expect((await standing(alan)).frozen).toBe(true);

      await paysAgain();

      for (const person of [grace, alan, barbara]) {
        await expect(standing(person)).resolves.toMatchObject({
          frozen: false,
          causes: [],
          lapsedAt: null,
        });
        expect((await newProject(person, 'back-again')).status).toBe(201);
      }
    });

    it("does not freeze them when an Operator suspends the Paying Organization, and the payer's lapse still does", async () => {
      const suspended = await request(http)
        .post(`/operator/organizations/${payingId}/suspension`)
        .set('Cookie', staffCookie)
        .send({ reason: 'Sending spam' });
      expect(suspended.status).toBeLessThan(300);

      await expect(standing(grace)).resolves.toMatchObject({
        frozen: true,
        causes: ['suspended'],
      });
      for (const person of [alan, barbara]) {
        await expect(standing(person)).resolves.toMatchObject({
          frozen: false,
          causes: [],
        });
        expect((await newProject(person)).status).toBe(201);
      }

      await subscriptionEnds('payment_failed');
      await expect(standing(alan)).resolves.toMatchObject({
        frozen: true,
        causes: ['lapsed'],
      });
    });

    it("tells an Attached Organization that the Paying Organization's payment is failing, without its own banner's failed payment", async () => {
      await paymentFails();

      await expect(standing(grace)).resolves.toMatchObject({
        frozen: false,
        paymentFailed: true,
        payingOrganization: null,
      });
      await expect(standing(alan)).resolves.toMatchObject({
        frozen: false,
        paymentFailed: false,
        payingOrganization: { name: 'Hopper Labs', paymentFailed: true },
      });
      expect((await newProject(alan)).status).toBe(201);

      retrieveSubscription.mockResolvedValue(stripeSubscription('active'));
      await postWebhook(
        stripeEvent(
          'customer.subscription.updated',
          stripeSubscription('active'),
        ),
      );
      await expect(standing(alan)).resolves.toMatchObject({
        payingOrganization: { name: 'Hopper Labs', paymentFailed: false },
      });
    });
  });

  describe('the emails', () => {
    it("send the Attached Organizations' owners and admins every lapse email but the payment failed, worded for the plan Hopper Labs pays for them with", async () => {
      await paymentFails();
      const failedAt = (await payerMarks()).paymentFailedAt!;
      await clock.tick(after(failedAt, 11));
      await subscriptionEnds('payment_failed');
      const lapsedAt = (await payerMarks()).lapsedAt!;
      await clock.tick(after(lapsedAt, 23));
      const deletesOn = after(lapsedAt, 30);
      await clock.tick(deletesOn);

      const day = (at: Date) =>
        at.toLocaleDateString('en-US', {
          month: 'short',
          day: '2-digit',
          year: 'numeric',
        });
      expect(subjects(PAYER_OWNER)).toEqual([
        'Action required: Cloudgate payment failed - $49.00',
        '3 days left to pay for Hopper Labs on Cloudgate',
        'Hopper Labs is frozen: your Cloudgate payment failed',
        `Hopper Labs will be deleted from Cloudgate on ${day(deletesOn)}`,
        'Hopper Labs has been deleted from Cloudgate',
      ]);
      for (const address of [ATTACHED_OWNER, ATTACHED_ADMIN]) {
        expect(subjects(address)).toEqual([
          '3 days left on the plan Hopper Labs pays for Turing Works with',
          'Turing Works is frozen: the plan Hopper Labs pays for it with has lapsed',
          `Turing Works will be deleted from Cloudgate on ${day(deletesOn)}`,
          'Turing Works has been deleted from Cloudgate',
        ]);
      }
      expect(subjects(SECOND_OWNER)).toEqual([
        '3 days left on the plan Hopper Labs pays for Liskov Systems with',
        'Liskov Systems is frozen: the plan Hopper Labs pays for it with has lapsed',
        `Liskov Systems will be deleted from Cloudgate on ${day(deletesOn)}`,
        'Liskov Systems has been deleted from Cloudgate',
      ]);
      expect(mail.to(ATTACHED_MEMBER)).toEqual([]);

      const [warning] = mail.to(ATTACHED_OWNER).map((sent) => sent.email.html);
      expect(
        warning.replace(/<!-- -->/g, '').replace(/&#x27;|&#39;/g, "'"),
      ).toContain('the plan Hopper Labs pays for this Organization with');
    });

    it('say "the plan has ended" after a cancel, naming who cancelled it', async () => {
      await subscriptionEnds('cancellation_requested');

      expect(subjects(PAYER_OWNER)).toEqual([
        'Your Cloudgate plan for Hopper Labs has ended',
      ]);
      expect(subjects(ATTACHED_OWNER)).toEqual([
        'The plan Hopper Labs pays for Turing Works with has ended',
      ]);
      const [html] = mail.to(ATTACHED_ADMIN).map((sent) => sent.email.html);
      expect(html.replace(/<!-- -->/g, '')).toContain(
        'Hopper Labs cancelled it.',
      );
    });
  });

  describe('day 30', () => {
    interface TrailRow {
      organizationId: string | null;
      userRole: string;
      userId: string | null;
      action: string;
      resourceType: string;
      resourceId: string | null;
      resourceName: string | null;
      metadata: string | null;
      createdAt: string;
    }

    /** The deleted Organizations' trail, as the Instance organization reads it. */
    async function deletedTrail(): Promise<TrailRow[]> {
      const res = await request(http)
        .get('/audit-logs')
        .query({
          scope: 'deleted-organizations',
          resourceType: 'organization',
        })
        .set('Cookie', staffCookie);
      expect(res.status).toBe(200);
      return (res.body as { logs: TrailRow[] }).logs;
    }

    it('deletes the Paying Organization and every Attached Organization together, a suspended one included, as the platform in both logs', async () => {
      await ctx.db
        .update(subscription)
        .set({ suspendedAt: new Date(), suspendedReason: 'Sending spam' })
        .where(eq(subscription.organizationId, secondId));
      await subscriptionEnds('cancellation_requested');
      const lapsedAt = (await payerMarks()).lapsedAt!;
      await clock.tick(after(lapsedAt, 23));
      await clock.tick(after(lapsedAt, 29.9));
      expect(await existing([payingId, attachedId, secondId])).toHaveLength(3);

      await expect(clock.tick(after(lapsedAt, 30))).resolves.toMatchObject({
        deleted: [payingId],
      });

      expect(await existing([payingId, attachedId, secondId])).toEqual([]);
      // The people stay: only the Organizations went.
      expect(await existing([edsger.organizationId])).toHaveLength(1);

      const trail = await deletedTrail();
      const platform = { userRole: 'system', userId: null, action: 'delete' };
      const linkRows = (attached: string) =>
        trail
          .filter((row) => row.resourceId === attached)
          .map((row) => ({
            ...row,
            metadata: JSON.parse(row.metadata ?? '{}') as unknown,
          }));
      const deletedLink = {
        ...platform,
        resourceType: 'organization',
        metadata: {
          link: 'deleted',
          payingOrganizationId: payingId,
          payingOrganizationName: 'Hopper Labs',
        },
      };
      for (const [id, name] of [
        [attachedId, 'Turing Works'],
        [secondId, 'Liskov Systems'],
      ]) {
        // One in its own log and one in Hopper Labs', and no other.
        expect(linkRows(id)).toEqual([
          expect.objectContaining({ ...deletedLink, resourceName: name }),
          expect.objectContaining({ ...deletedLink, resourceName: name }),
        ]);
      }
      const own = trail.filter((row) => row.resourceId === payingId);
      expect(own).toEqual([
        expect.objectContaining({
          ...platform,
          resourceType: 'organization',
          resourceName: 'Hopper Labs',
        }),
      ]);
      // Every link row was written before Hopper Labs' own.
      const ownAt = new Date(own[0].createdAt).getTime();
      for (const row of trail.filter((one) => one.resourceId !== payingId)) {
        expect(new Date(row.createdAt).getTime()).toBeLessThanOrEqual(ownAt);
      }
    });

    it('deletes nothing when the Paying Organization paid again before day 30', async () => {
      await subscriptionEnds('cancellation_requested');
      const lapsedAt = (await payerMarks()).lapsedAt!;
      await clock.tick(after(lapsedAt, 23));
      await paysAgain();

      await clock.tick(after(lapsedAt, 30));
      await clock.tick(after(lapsedAt, 60));

      expect(await existing([payingId, attachedId, secondId])).toHaveLength(3);
    });
  });
});
