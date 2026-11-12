// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first import.
import { useHostedMode } from '../../utils/hosted-mode';
const hosted = useHostedMode();

import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  subscription,
  trialHistory,
} from '../../../src/cloud/billing/billing.schema';
import { STRIPE_API } from '../../../src/cloud/billing/stripe-api';
import { fakeStripe } from '../../utils/fake-stripe';
import { MailService } from '../../../src/mail/mail.service';
import {
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../../utils/hosted-sign-up';
import { createTestApp, TestAppContext } from '../../utils/test-app';

jest.setTimeout(180_000);

const PLAN_PRICE = hosted.STARTER_PLAN_PRICE_ID;
const ADD_ON_PRICE = hosted.ADD_ON_PRICE_ID;

const retrieveSubscription = jest.fn<Promise<Stripe.Subscription>, [string]>();
const createCheckoutSession = jest.fn<
  Promise<Stripe.Checkout.Session>,
  [Stripe.Checkout.SessionCreateParams]
>();
const updateSubscription = jest.fn<
  Promise<Stripe.Subscription>,
  [string, Stripe.SubscriptionUpdateParams]
>();
const retrievePaymentMethod = jest.fn<
  Promise<Stripe.PaymentMethod>,
  [string]
>();
const constructEvent = jest.fn<Stripe.Event, [Buffer | string, string]>();

const stripe = fakeStripe({
  retrieveSubscription,
  createCheckoutSession,
  updateSubscription,
  retrievePaymentMethod,
  constructEvent,
});

/**
 * `sub_1` for the new customer `cus_1`, as Stripe holds it at some moment of
 * the first checkout: `incomplete` while the first payment is confirmed, then
 * `active`. `metadata` is what checkout's `subscription_data.metadata` put on
 * it; left out, it is a subscription Cloudgate's checkout did not start.
 */
const firstSubscription = (
  status: 'incomplete' | 'active',
  metadata: Record<string, string> | undefined,
) =>
  ({
    id: 'sub_1',
    customer: 'cus_1',
    status,
    ...(metadata ? { metadata } : {}),
    items: {
      data: [
        { id: 'si_plan', price: { id: PLAN_PRICE }, quantity: 1 },
        { id: 'si_add_on', price: { id: ADD_ON_PRICE }, quantity: 2 },
      ],
    },
  }) as unknown as Stripe.Subscription;

/**
 * `sub_1` in its free trial, as every event of a trial Checkout
 * carries it — created already `trialing` — charged to the card `pm_1`.
 */
const trialingSubscription = (metadata: Record<string, string>) =>
  ({
    ...firstSubscription('active', metadata),
    status: 'trialing',
    trial_end: 1_798_761_600,
    default_payment_method: 'pm_1',
  }) as unknown as Stripe.Subscription;

const stripeEvent = (type: string, object: unknown) =>
  ({ type, data: { object } }) as unknown as Stripe.Event;

/** Every ordering of `items`. */
function orderings<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) =>
    orderings([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
}

type FirstCheckoutEvent =
  | 'customer.subscription.created'
  | 'customer.subscription.updated'
  | 'invoice.payment_succeeded'
  | 'checkout.session.completed';

const FIRST_CHECKOUT_EVENTS: readonly FirstCheckoutEvent[] = [
  'customer.subscription.created',
  'customer.subscription.updated',
  'invoice.payment_succeeded',
  'checkout.session.completed',
];

/** The events of a Checkout that starts a free trial: no invoice is paid. */
const TRIAL_CHECKOUT_EVENTS: readonly FirstCheckoutEvent[] = [
  'customer.subscription.created',
  'customer.subscription.updated',
  'checkout.session.completed',
];

describe('Billing: the first checkout settles in any event order (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let organizationId: string;
  const mail = new MailRecorder();

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: STRIPE_API, useValue: stripe },
        { provide: MailService, useValue: mail },
      ],
    });
    http = ctx.app.getHttpServer() as App;
    await ctx.resetDb();
    await openHostedSignUp(ctx.db);
    ({ organizationId } = await signUpHostedCustomer(http, mail, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    }));
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    // A new customer: nothing stored for the Organization yet.
    await ctx.db
      .delete(subscription)
      .where(eq(subscription.organizationId, organizationId));
  });

  /** Posts an event Stripe has already verified. */
  function postWebhook(event: Stripe.Event) {
    constructEvent.mockReturnValue(event);
    return request(http)
      .post('/billing/webhook')
      .set('stripe-signature', 't=1,v1=valid')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(event));
  }

  /**
   * The event as Stripe delivers it: a subscription event carries the
   * subscription as it was when the event happened — `created` while it was
   * still `incomplete`, `updated` when it turned `active` — and the invoice
   * and the session carry only references.
   */
  function eventOf(type: FirstCheckoutEvent, metadata = { organizationId }) {
    switch (type) {
      case 'customer.subscription.created':
        return stripeEvent(type, firstSubscription('incomplete', metadata));
      case 'customer.subscription.updated':
        return stripeEvent(type, firstSubscription('active', metadata));
      case 'invoice.payment_succeeded':
        return stripeEvent(type, {
          id: 'in_1',
          customer: 'cus_1',
          parent: { subscription_details: { subscription: 'sub_1' } },
        });
      case 'checkout.session.completed':
        return stripeEvent(type, {
          id: 'cs_1',
          customer: 'cus_1',
          subscription: 'sub_1',
          metadata: { organizationId },
        });
    }
  }

  async function storedSubscription() {
    const [row] = await ctx.db
      .select({
        stripeCustomerId: subscription.stripeCustomerId,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        plan: subscription.plan,
        status: subscription.status,
        addOns: subscription.addOns,
      })
      .from(subscription)
      .where(eq(subscription.organizationId, organizationId));
    return row ?? null;
  }

  const SETTLED = {
    stripeCustomerId: 'cus_1',
    stripeSubscriptionId: 'sub_1',
    plan: 'starter',
    status: 'active',
    addOns: 2,
  };

  it('asks checkout to put the Organization on the subscription, so every subscription event names it', async () => {
    createCheckoutSession.mockResolvedValue({
      id: 'cs_1',
      url: 'https://checkout.stripe.com/c/pay/cs_1#fid',
    } as unknown as Stripe.Checkout.Session);
    const customer = await signUpHostedCustomer(http, mail, {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      password: 'super-secret-password',
      organizationName: 'Analytical Engines',
    });

    const res = await request(http)
      .post('/billing/checkout')
      .set('Cookie', customer.cookie)
      .send({ plan: 'starter', addOns: 0 });

    expect(res.status).toBe(200);
    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { organizationId: customer.organizationId },
        subscription_data: expect.objectContaining({
          metadata: expect.objectContaining({
            organizationId: customer.organizationId,
          }) as unknown,
        }) as unknown,
      }),
    );
  });

  describe.each(
    orderings(FIRST_CHECKOUT_EVENTS).map((o) => [o.join(' → '), o]),
  )('delivered as %s', (_name, order) => {
    it('ends with the plan, its Add-ons and the customer stored, each event accepted', async () => {
      // Every event has happened at Stripe by the time any is delivered.
      retrieveSubscription.mockResolvedValue(
        firstSubscription('active', { organizationId }),
      );

      for (const type of order) {
        const res = await postWebhook(eventOf(type));
        expect({ type, status: res.status }).toEqual({ type, status: 200 });
      }

      await expect(storedSubscription()).resolves.toEqual(SETTLED);
    });
  });

  describe.each(
    orderings(TRIAL_CHECKOUT_EVENTS).map((o) => [o.join(' → '), o]),
  )('a trial Checkout delivered as %s', (_name, order) => {
    beforeEach(async () => {
      mail.clear();
      await ctx.db.delete(trialHistory);
      retrieveSubscription.mockResolvedValue(
        trialingSubscription({ organizationId }),
      );
      retrievePaymentMethod.mockResolvedValue({
        id: 'pm_1',
        type: 'card',
        card: { fingerprint: 'fp_card' },
      } as unknown as Stripe.PaymentMethod);
    });

    async function deliver() {
      for (const type of order) {
        const event =
          type === 'checkout.session.completed'
            ? eventOf(type)
            : stripeEvent(type, trialingSubscription({ organizationId }));
        const res = await postWebhook(event);
        expect({ type, status: res.status }).toEqual({ type, status: 200 });
      }
    }

    it("records a first-time card once, with the trial's subscription, and keeps the trial", async () => {
      await deliver();

      expect(retrievePaymentMethod).toHaveBeenCalledTimes(1);
      await expect(
        ctx.db
          .select({
            value: trialHistory.value,
            stripeSubscriptionId: trialHistory.stripeSubscriptionId,
          })
          .from(trialHistory)
          .where(eq(trialHistory.kind, 'card')),
      ).resolves.toEqual([{ value: 'fp_card', stripeSubscriptionId: 'sub_1' }]);
      expect(updateSubscription).not.toHaveBeenCalled();
      await expect(storedSubscription()).resolves.toEqual({
        ...SETTLED,
        status: 'trialing',
      });
    });

    /** The "trial started" emails Grace, the owner, received. */
    const trialStartedMails = () =>
      mail
        .to('grace@example.com')
        .map((sent) => sent.email.subject)
        .filter((subject) =>
          subject.endsWith('free trial for Hopper Labs has started'),
        );

    it('sends "trial started" once for a first-time card', async () => {
      await deliver();

      expect(trialStartedMails()).toEqual([
        'Your 30-day Cloudgate free trial for Hopper Labs has started',
      ]);
    });

    it('sends no "trial started" for a card an earlier trial had, whose trial ends at once', async () => {
      await ctx.db.insert(trialHistory).values({
        kind: 'card',
        value: 'fp_card',
        stripeSubscriptionId: 'sub_earlier',
      });

      await deliver();

      expect(updateSubscription).toHaveBeenCalledTimes(1);
      expect(trialStartedMails()).toEqual([]);
    });

    it('ends the trial once, without cancelling, for a card an earlier trial had', async () => {
      await ctx.db.insert(trialHistory).values({
        kind: 'card',
        value: 'fp_card',
        stripeSubscriptionId: 'sub_earlier',
      });

      await deliver();

      expect(updateSubscription.mock.calls).toEqual([
        ['sub_1', { trial_end: 'now' }],
      ]);
    });
  });

  it('settles when the subscription is created before its first payment is confirmed', async () => {
    // Stripe still says `incomplete` when `created` is handled...
    retrieveSubscription.mockResolvedValue(
      firstSubscription('incomplete', { organizationId }),
    );
    expect(
      (await postWebhook(eventOf('customer.subscription.created'))).status,
    ).toBe(200);
    await expect(storedSubscription()).resolves.toEqual({
      ...SETTLED,
      status: 'incomplete',
    });

    // ...and the paid invoice and the session that follow settle it.
    retrieveSubscription.mockResolvedValue(
      firstSubscription('active', { organizationId }),
    );
    expect(
      (await postWebhook(eventOf('invoice.payment_succeeded'))).status,
    ).toBe(200);
    expect(
      (await postWebhook(eventOf('checkout.session.completed'))).status,
    ).toBe(200);
    await expect(storedSubscription()).resolves.toEqual(SETTLED);
  });

  it('accepts, and stores nothing for, a subscription event that names no known customer or Organization', async () => {
    retrieveSubscription.mockResolvedValue(
      firstSubscription('active', undefined),
    );

    for (const type of [
      'customer.subscription.created',
      'customer.subscription.updated',
      'invoice.payment_succeeded',
    ] as const) {
      const res = await postWebhook(
        stripeEvent(
          type,
          type === 'invoice.payment_succeeded'
            ? eventOf(type).data.object
            : firstSubscription('active', undefined),
        ),
      );
      // A 2xx: Stripe neither retries it nor counts it toward disabling the
      // endpoint.
      expect({ type, status: res.status }).toEqual({ type, status: 200 });
    }
    await expect(storedSubscription()).resolves.toBeNull();

    // The session, which always names the Organization, settles it.
    expect(
      (await postWebhook(eventOf('checkout.session.completed'))).status,
    ).toBe(200);
    await expect(storedSubscription()).resolves.toEqual(SETTLED);
  });

  it('accepts a deleted customer it never stored', async () => {
    const res = await postWebhook(
      stripeEvent('customer.deleted', { id: 'cus_unknown', deleted: true }),
    );

    expect(res.status).toBe(200);
    await expect(storedSubscription()).resolves.toBeNull();
  });
});
