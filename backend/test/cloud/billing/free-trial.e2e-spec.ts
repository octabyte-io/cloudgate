// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first import.
import { useHostedMode } from '../../utils/hosted-mode';
const hosted = useHostedMode();

import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import request from 'supertest';
import { App } from 'supertest/types';
import { user } from '../../../src/auth/auth.schema';
import { CONFIRMATION_EMAIL_WINDOW_MS } from '../../../src/auth/confirmation-email-limit';
import {
  subscription,
  trialHistory,
} from '../../../src/cloud/billing/billing.schema';
import { STRIPE_API } from '../../../src/cloud/billing/stripe-api';
import { MailService } from '../../../src/mail/mail.service';
import { organization } from '../../../src/organizations/organizations.schema';
import { fakeStripe } from '../../utils/fake-stripe';
import {
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../../utils/hosted-sign-up';
import type { HostedCustomer } from '../../utils/hosted-sign-up';
import { createTestApp, TestAppContext } from '../../utils/test-app';

jest.setTimeout(180_000);

const STARTER_PRICE = hosted.STARTER_PLAN_PRICE_ID;
const ADD_ON_PRICE = hosted.ADD_ON_PRICE_ID;

const retrieveSubscription = jest.fn<Promise<Stripe.Subscription>, [string]>();
const retrieveCustomer = jest.fn<
  Promise<Stripe.Customer | Stripe.DeletedCustomer>,
  [string]
>();
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
  retrieveCustomer,
  createCheckoutSession,
  updateSubscription,
  retrievePaymentMethod,
  constructEvent,
});

const GRACE = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
  organizationName: 'Hopper Labs',
};

/** 30 days from a fixed start, as Stripe's `trial_end` seconds. */
const TRIAL_END = 1_798_761_600;

/** A Stripe subscription, its customer and the card Checkout took. */
interface CheckoutIds {
  subscription: string;
  customer: string;
  paymentMethod: string;
}

const FIRST_IDS: CheckoutIds = {
  subscription: 'sub_1',
  customer: 'cus_1',
  paymentMethod: 'pm_1',
};

/**
 * `sub_1` for `cus_1` (or `ids`) as Stripe holds it after Checkout: in its
 * free trial when `trial` is given (with the metadata Checkout put on it),
 * paid and active when not; charged to the card Checkout took.
 */
const subscriptionAfterCheckout = (
  metadata: Record<string, string>,
  trial: boolean,
  addOns = 0,
  ids: CheckoutIds = FIRST_IDS,
) =>
  ({
    id: ids.subscription,
    customer: ids.customer,
    status: trial ? 'trialing' : 'active',
    trial_end: trial ? TRIAL_END : null,
    default_payment_method: ids.paymentMethod,
    metadata,
    items: {
      data: [
        { id: 'si_plan', price: { id: STARTER_PRICE }, quantity: 1 },
        ...(addOns > 0
          ? [{ id: 'si_add_on', price: { id: ADD_ON_PRICE }, quantity: addOns }]
          : []),
      ],
    },
  }) as unknown as Stripe.Subscription;

const stripeEvent = (type: string, object: unknown) =>
  ({ type, data: { object } }) as unknown as Stripe.Event;

describe('Billing: the 30-day free trial at Checkout (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
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
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    jest.resetAllMocks();
    mail.clear();
    createCheckoutSession.mockResolvedValue({
      id: 'cs_1',
      url: 'https://checkout.stripe.com/c/pay/cs_1#fid',
    } as unknown as Stripe.Checkout.Session);
    // Every card is one no other trial has had, unless a test says so.
    retrievePaymentMethod.mockImplementation((id) =>
      Promise.resolve(cardPaymentMethod(id, `fp_${id}`)),
    );
    await openHostedSignUp(ctx.db);
  });

  const signUp = (body: Partial<typeof GRACE> = {}) =>
    signUpHostedCustomer(http, mail, { ...GRACE, ...body });

  function checkout(customer: HostedCustomer, addOns = 0) {
    return request(http)
      .post('/billing/checkout')
      .set('Cookie', customer.cookie)
      .send({ plan: 'starter', addOns });
  }

  /** The parameters of the last Checkout session asked of Stripe. */
  function lastCheckout(): Stripe.Checkout.SessionCreateParams {
    const params = createCheckoutSession.mock.calls.at(-1)?.[0];
    if (!params) throw new Error('No Checkout session was created');
    return params;
  }

  async function billing(customer: HostedCustomer) {
    const res = await request(http)
      .get('/billing/subscription')
      .set('Cookie', customer.cookie);
    expect(res.status).toBe(200);
    return res.body as {
      plan: string | null;
      status: string | null;
      allowance: { plan: string | null; servers: number };
      trialAvailable: boolean;
      trialEndsAt: string | null;
    };
  }

  function postWebhook(event: Stripe.Event) {
    constructEvent.mockReturnValue(event);
    return request(http)
      .post('/billing/webhook')
      .set('stripe-signature', 't=1,v1=valid')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(event));
  }

  /**
   * Stripe completes the Checkout `lastCheckout` started, with the metadata
   * it put on the subscription: in a trial exactly when that Checkout asked
   * for one.
   */
  async function completeCheckout(
    organizationId: string,
    addOns = 0,
    ids: CheckoutIds = FIRST_IDS,
  ) {
    const data = lastCheckout().subscription_data;
    const after = subscriptionAfterCheckout(
      data?.metadata as Record<string, string>,
      data?.trial_period_days === 30,
      addOns,
      ids,
    );
    retrieveSubscription.mockResolvedValue(after);
    for (const event of [
      stripeEvent('customer.subscription.created', after),
      checkoutCompleted(organizationId, ids),
    ]) {
      expect((await postWebhook(event)).status).toBe(200);
    }
  }

  /** `checkout.session.completed` for the Checkout that made `ids`. */
  const checkoutCompleted = (organizationId: string, ids: CheckoutIds) =>
    stripeEvent('checkout.session.completed', {
      id: `cs_for_${ids.subscription}`,
      customer: ids.customer,
      subscription: ids.subscription,
      metadata: { organizationId },
    });

  /** The subscription Stripe ended, as `customer.subscription.deleted`. */
  async function endSubscription() {
    const ended = {
      ...subscriptionAfterCheckout({}, false),
      status: 'canceled',
      cancellation_details: { reason: 'cancellation_requested' },
    };
    expect(
      (await postWebhook(stripeEvent('customer.subscription.deleted', ended)))
        .status,
    ).toBe(200);
  }

  /** The person's account and their Organization, gone. */
  async function deleteAccountAndOrganization(customer: HostedCustomer) {
    await ctx.db
      .delete(organization)
      .where(eq(organization.id, customer.organizationId));
    await ctx.db.delete(user).where(eq(user.id, customer.id));
  }

  const TRIAL = {
    trial_period_days: 30,
    trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
  };

  it('gives an eligible Organization a 30-day trial, always collecting a card, and it can add Add-ons during it at no charge', async () => {
    const grace = await signUp();
    expect(await billing(grace)).toMatchObject({
      trialAvailable: true,
      trialEndsAt: null,
    });

    expect((await checkout(grace)).status).toBe(200);
    expect(lastCheckout()).toMatchObject({
      payment_method_collection: 'always',
      subscription_data: {
        ...TRIAL,
        metadata: { organizationId: grace.organizationId },
      },
    });

    await completeCheckout(grace.organizationId);

    // The trial counts as paid: the plan's counts.
    expect(await billing(grace)).toEqual(
      expect.objectContaining({
        plan: 'starter',
        status: 'trialing',
        allowance: { plan: 'starter', servers: 3, cloudEnvironments: 3 },
        trialAvailable: false,
        trialEndsAt: new Date(TRIAL_END * 1000).toISOString(),
      }),
    );

    // Add-ons while trialing: Stripe charges nothing for them until day 30.
    retrieveSubscription.mockResolvedValue(subscriptionAfterCheckout({}, true));
    const addOns = await request(http)
      .post('/billing/add-ons')
      .set('Cookie', grace.cookie)
      .send({ addOns: 2 });
    expect(addOns.status).toBe(200);
    expect(addOns.body).toEqual({ addOns: 2 });
    expect(updateSubscription).toHaveBeenCalledWith('sub_1', {
      items: [{ price: ADD_ON_PRICE, quantity: 2 }],
      proration_behavior: 'create_prorations',
    });
  });

  it('gives an Organization that held a subscription Checkout without a trial, after it lapsed too', async () => {
    const grace = await signUp();
    // Its first subscription is paid at once, so no trial is recorded for
    // Grace herself: only the Organization's own history decides.
    const paid = subscriptionAfterCheckout(
      { organizationId: grace.organizationId },
      false,
    );
    expect(
      (await postWebhook(stripeEvent('customer.subscription.updated', paid)))
        .status,
    ).toBe(200);
    await endSubscription();
    expect(await billing(grace)).toMatchObject({
      plan: null,
      trialAvailable: false,
    });
    expect(await ctx.db.select().from(trialHistory)).toEqual([]);

    retrieveCustomer.mockResolvedValue({
      id: 'cus_1',
    } as unknown as Stripe.Customer);
    expect((await checkout(grace)).status).toBe(200);

    const params = lastCheckout();
    expect(params.payment_method_collection).toBe('always');
    expect(params.subscription_data).toEqual({
      metadata: { organizationId: grace.organizationId },
    });
  });

  it('gives an Organization that was ever Enterprise Checkout without a trial', async () => {
    const grace = await signUp();
    // Enterprise switched on once and off again: only its first
    // moment is left.
    await ctx.db.insert(subscription).values({
      organizationId: grace.organizationId,
      firstEnterpriseAt: new Date('2026-09-01T00:00:00Z'),
    });

    expect(await billing(grace)).toMatchObject({ trialAvailable: false });
    expect((await checkout(grace)).status).toBe(200);
    expect(lastCheckout().subscription_data).toEqual({
      metadata: { organizationId: grace.organizationId },
    });
  });

  it('gives an email that started a trial no second one, even after the account and the Organization are deleted, whatever its case', async () => {
    const first = await signUp();
    await checkout(first);
    await completeCheckout(first.organizationId);
    await deleteAccountAndOrganization(first);
    // Past the one-confirmation-email-per-address window, so she can sign up
    // again at once.
    ctx.advanceConfirmationClock(CONFIRMATION_EMAIL_WINDOW_MS);

    const again = await signUp({
      email: 'Grace@Example.com',
      organizationName: 'Hopper Labs Again',
    });
    expect(await billing(again)).toMatchObject({ trialAvailable: false });
    expect((await checkout(again)).status).toBe(200);
    expect(lastCheckout().payment_method_collection).toBe('always');
    expect(lastCheckout().subscription_data).toEqual({
      metadata: { organizationId: again.organizationId },
    });
  });

  it('uses up nothing for a Checkout that was never completed', async () => {
    const grace = await signUp();
    await checkout(grace);

    expect(await ctx.db.select().from(trialHistory)).toEqual([]);
    expect(await billing(grace)).toMatchObject({ trialAvailable: true });
  });

  it('keeps the trial history with no readable email, once however many events carry it', async () => {
    const grace = await signUp();
    await checkout(grace);
    await completeCheckout(grace.organizationId);
    // Stripe delivers the trialing subscription again.
    await postWebhook(
      stripeEvent(
        'customer.subscription.updated',
        subscriptionAfterCheckout(
          lastCheckout().subscription_data?.metadata as Record<string, string>,
          true,
        ),
      ),
    );

    const rows = await ctx.db
      .select()
      .from(trialHistory)
      .where(eq(trialHistory.kind, 'email'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'email',
      value: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
    });
    const stored = JSON.stringify(rows).toLowerCase();
    expect(stored).not.toContain('grace');
    expect(stored).not.toContain('example.com');
    // And nothing readable went to Stripe either.
    expect(JSON.stringify(lastCheckout().subscription_data)).not.toContain(
      'grace',
    );
  });

  describe('one trial per card', () => {
    const ADA = {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      organizationName: 'Analytical Engines',
    };
    const SECOND_IDS: CheckoutIds = {
      subscription: 'sub_2',
      customer: 'cus_2',
      paymentMethod: 'pm_2',
    };

    /** Every payment method is the same card number. */
    function sameCardEverywhere() {
      retrievePaymentMethod.mockImplementation((id) =>
        Promise.resolve(cardPaymentMethod(id, 'fp_shared_card')),
      );
    }

    const cardRows = () =>
      ctx.db
        .select({
          value: trialHistory.value,
          stripeSubscriptionId: trialHistory.stripeSubscriptionId,
        })
        .from(trialHistory)
        .where(eq(trialHistory.kind, 'card'));

    it("records a first-time card's fingerprint when its trial starts, and keeps the trial", async () => {
      const grace = await signUp();
      await checkout(grace);
      await completeCheckout(grace.organizationId);

      expect(retrievePaymentMethod).toHaveBeenCalledWith('pm_1');
      expect(await cardRows()).toEqual([
        { value: 'fp_pm_1', stripeSubscriptionId: 'sub_1' },
      ]);
      expect(updateSubscription).not.toHaveBeenCalled();
      expect(await billing(grace)).toMatchObject({
        status: 'trialing',
        trialEndsAt: new Date(TRIAL_END * 1000).toISOString(),
      });
    });

    it('ends the trial at once for a card that had one, on a new Organization and email: charged today, the plan kept, never cancelled', async () => {
      sameCardEverywhere();
      const grace = await signUp();
      await checkout(grace);
      await completeCheckout(grace.organizationId);
      expect(updateSubscription).not.toHaveBeenCalled();

      const ada = await signUp(ADA);
      expect(await billing(ada)).toMatchObject({ trialAvailable: true });
      await checkout(ada);
      expect(lastCheckout().subscription_data).toMatchObject(TRIAL);
      await completeCheckout(ada.organizationId, 0, SECOND_IDS);

      // The one Stripe write: the trial ends now. Nothing cancels.
      expect(updateSubscription.mock.calls).toEqual([
        ['sub_2', { trial_end: 'now' }],
      ]);
      // The card's trial stays Grace's, and so does hers.
      expect(await cardRows()).toEqual([
        { value: 'fp_shared_card', stripeSubscriptionId: 'sub_1' },
      ]);
      expect(await billing(grace)).toMatchObject({ status: 'trialing' });

      // Stripe charges the card today and says so.
      const charged = {
        ...subscriptionAfterCheckout(
          lastCheckout().subscription_data?.metadata as Record<string, string>,
          false,
          0,
          SECOND_IDS,
        ),
        trial_end: Math.floor(Date.now() / 1000),
      };
      expect(
        (
          await postWebhook(
            stripeEvent('customer.subscription.updated', charged),
          )
        ).status,
      ).toBe(200);
      expect(await billing(ada)).toMatchObject({
        plan: 'starter',
        status: 'active',
        allowance: { plan: 'starter', servers: 3 },
        trialEndsAt: null,
      });
    });

    it('keeps the trial when the same Checkout is delivered again', async () => {
      const grace = await signUp();
      await checkout(grace);
      await completeCheckout(grace.organizationId);
      expect(
        (await postWebhook(checkoutCompleted(grace.organizationId, FIRST_IDS)))
          .status,
      ).toBe(200);

      expect(updateSubscription).not.toHaveBeenCalled();
      expect(await cardRows()).toHaveLength(1);
    });

    it('looks up no card for a Checkout without a trial', async () => {
      sameCardEverywhere();
      const grace = await signUp();
      await checkout(grace);
      await completeCheckout(grace.organizationId);
      // Grace's Organization, past its trial, subscribes again: no trial, so
      // the card is not looked up and nothing is ended.
      retrievePaymentMethod.mockClear();
      retrieveSubscription.mockResolvedValue(
        subscriptionAfterCheckout({}, false, 0, SECOND_IDS),
      );
      expect(
        (await postWebhook(checkoutCompleted(grace.organizationId, SECOND_IDS)))
          .status,
      ).toBe(200);

      expect(retrievePaymentMethod).not.toHaveBeenCalled();
      expect(updateSubscription).not.toHaveBeenCalled();
    });
  });
});

/** A card payment method as Stripe holds it, with its card's fingerprint. */
function cardPaymentMethod(id: string, fingerprint: string) {
  return {
    id,
    type: 'card',
    card: { fingerprint },
  } as unknown as Stripe.PaymentMethod;
}
