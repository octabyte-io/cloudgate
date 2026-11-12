// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first load.
import { useHostedMode } from '../../utils/hosted-mode';
const hosted = useHostedMode();

import type Stripe from 'stripe';
import request from 'supertest';
import { App } from 'supertest/types';
import { eq } from 'drizzle-orm';
import { subscription } from '../../../src/cloud/billing/billing.schema';
import { STRIPE_API } from '../../../src/cloud/billing/stripe-api';
import { MailService } from '../../../src/mail/mail.service';
import { fakeStripe, fakeSubscriptionSchedules } from '../../utils/fake-stripe';
import { givenPlan } from '../../utils/hosted-plan';
import {
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../../utils/hosted-sign-up';
import { createTestApp, TestAppContext } from '../../utils/test-app';

jest.setTimeout(120_000);

const STARTER_PRICE = hosted.STARTER_PLAN_PRICE_ID;
const BUSINESS_PRICE = hosted.BUSINESS_PLAN_PRICE_ID;
const ADD_ON_PRICE = hosted.ADD_ON_PRICE_ID;

const DAY = 24 * 60 * 60;

// Stripe, mocked at its port; the subscription is a small model below, so a
// switch or a cancel is read back the way Stripe would answer it.
const retrieveSubscription = jest.fn<Promise<Stripe.Subscription>, [string]>();
const retrieveCustomer = jest.fn<
  Promise<Stripe.Customer | Stripe.DeletedCustomer>,
  [string]
>();
const updateSubscription = jest.fn<
  Promise<Stripe.Subscription>,
  [string, Stripe.SubscriptionUpdateParams]
>();
const previewInvoice = jest.fn<
  Promise<Stripe.Invoice>,
  [Stripe.InvoiceCreatePreviewParams]
>();
const schedules = fakeSubscriptionSchedules();
const stripe = fakeStripe({
  retrieveSubscription,
  retrieveCustomer,
  updateSubscription,
  previewInvoice,
  ...schedules.methods,
});

const recorder = new MailRecorder();

const visa = {
  id: 'pm_visa',
  object: 'payment_method',
  type: 'card',
  card: { brand: 'visa', last4: '4242' },
};

/**
 * The Billing page during a free trial (ADR-0054).
 *
 * Switching Starter ↔ Business takes effect at once, both ways, charging
 * nothing and keeping the trial's end; a downgrade is a direct swap, never a
 * subscription schedule. "Cancel trial" sets the subscription to end with the
 * trial, and "Keep <plan>" takes it back. The page reads the end, the first
 * charge and the card live from Stripe.
 */
describe('Billing during a free trial (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;

  /** The subscription as Stripe holds it now. */
  let atStripe: Stripe.Subscription;

  const trialStart = Math.floor(Date.now() / 1000) - 10 * DAY;
  const trialEnd = trialStart + 30 * DAY;
  const trialEndIso = new Date(trialEnd * 1000).toISOString();

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: STRIPE_API, useValue: stripe },
        { provide: MailService, useValue: recorder },
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
    atStripe = trialAtStripe();
    retrieveSubscription.mockImplementation(() => Promise.resolve(atStripe));
    retrieveCustomer.mockResolvedValue({
      id: 'cus_1',
      object: 'customer',
      invoice_settings: { default_payment_method: null },
    } as unknown as Stripe.Customer);
    updateSubscription.mockImplementation((_id, params) => {
      atStripe = applied(atStripe, params);
      return Promise.resolve(atStripe);
    });
    // The next invoice: the plan and 2 Add-ons at $10, with a previewed
    // change in place.
    previewInvoice.mockImplementation((params) => {
      const items = params.subscription_details?.items;
      const previewed = items
        ? applied(atStripe, {
            items: items,
          })
        : atStripe;
      return Promise.resolve(invoice(planPrice(previewed) + 2 * 1000));
    });
    schedules.reset(() => atStripe);
  });

  /** A trialing subscription at Stripe: `plan`'s item and 2 Add-ons. */
  function trialAtStripe({
    plan = STARTER_PRICE,
    card = true,
  }: { plan?: string; card?: boolean } = {}): Stripe.Subscription {
    const item = (id: string, price: string, quantity: number) => ({
      id,
      price: { id: price },
      quantity,
      current_period_start: trialStart,
      current_period_end: trialEnd,
    });
    return {
      id: 'sub_1',
      customer: 'cus_1',
      status: 'trialing',
      trial_start: trialStart,
      trial_end: trialEnd,
      cancel_at_period_end: false,
      cancel_at: null,
      schedule: null,
      default_payment_method: card ? visa : null,
      metadata: {},
      items: {
        data: [item('si_plan', plan, 1), item('si_add_on', ADD_ON_PRICE, 2)],
      },
    } as unknown as Stripe.Subscription;
  }

  /** What Stripe holds after an update: prices swapped, the cancel set. */
  function applied(
    current: Stripe.Subscription,
    params: Stripe.SubscriptionUpdateParams,
  ): Stripe.Subscription {
    const swaps = new Map(
      (params.items ?? []).map((item) => [item.id, item.price]),
    );
    return {
      ...current,
      ...(params.cancel_at_period_end === undefined
        ? {}
        : { cancel_at_period_end: params.cancel_at_period_end }),
      items: {
        ...current.items,
        data: current.items.data.map((item) => {
          const price = swaps.get(item.id);
          return price ? { ...item, price: { id: price } } : item;
        }),
      },
    } as unknown as Stripe.Subscription;
  }

  const planPrice = (current: Stripe.Subscription) =>
    current.items.data.some((item) => item.price.id === BUSINESS_PRICE)
      ? 4500
      : 1500;

  const invoice = (amount: number) =>
    ({
      amount_due: amount,
      total: amount,
      currency: 'usd',
    }) as unknown as Stripe.Invoice;

  /** A customer Organization in its trial on `plan`, its owner signed in. */
  async function givenTrialOn(plan: 'starter' | 'business' = 'starter') {
    await openHostedSignUp(ctx.db);
    const owner = await signUpHostedCustomer(http, recorder, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
    await givenPlan(ctx, owner.organizationId, plan, 'trialing', {
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      addOns: 2,
      trialEndsAt: new Date(trialEnd * 1000),
      firstSubscribedAt: new Date(trialStart * 1000),
    });
    atStripe = trialAtStripe({
      plan: plan === 'business' ? BUSINESS_PRICE : STARTER_PRICE,
    });
    return owner;
  }

  /** Someone invited to the owner's Organization as a member, acting in it. */
  async function givenMember(owner: {
    cookie: string;
    organizationId: string;
  }): Promise<string> {
    const email = 'member@example.com';
    const invite = await request(http)
      .post('/organizations/invitations')
      .set('Cookie', owner.cookie)
      .send({ email, role: 'member' });
    expect(invite.status).toBe(201);
    const inviteId = (invite.body as { id: string }).id;

    const signUp = await request(http)
      .post('/api/auth/sign-up/email')
      .set('x-cloudgate-token', inviteId)
      .send({ name: 'Ida Rhodes', email, password: 'super-secret-password' });
    const cookie = signUp.headers['set-cookie'];
    const accept = await request(http)
      .post(`/organizations/invitations/${inviteId}/accept`)
      .set('Cookie', cookie);
    expect(accept.status).toBe(201);
    const active = await request(http)
      .post('/api/auth/organization/set-active')
      .set('Cookie', cookie)
      .send({ organizationId: owner.organizationId });
    expect(active.status).toBe(200);
    return cookie;
  }

  const billing = async (cookie: string) =>
    (await request(http).get('/billing/subscription').set('Cookie', cookie))
      .body as Record<string, unknown>;

  const licensed = async (cookie: string) =>
    (
      (await request(http).get('/license/status').set('Cookie', cookie))
        .body as { licensed: boolean }
    ).licensed;

  async function storedRow(organizationId: string) {
    const [row] = await ctx.db
      .select({
        plan: subscription.plan,
        status: subscription.status,
        trialEndsAt: subscription.trialEndsAt,
        stripeScheduleId: subscription.stripeScheduleId,
      })
      .from(subscription)
      .where(eq(subscription.organizationId, organizationId));
    return row;
  }

  /** No schedule, no proration, no charge, and the trial's end untouched. */
  function expectFreeSwapTo(price: string) {
    expect(updateSubscription).toHaveBeenCalledTimes(1);
    expect(updateSubscription).toHaveBeenCalledWith('sub_1', {
      items: [{ id: 'si_plan', price }],
      proration_behavior: 'none',
    });
    expect(schedules.methods.createSubscriptionSchedule).not.toHaveBeenCalled();
    expect(schedules.methods.updateSubscriptionSchedule).not.toHaveBeenCalled();
  }

  it('shows the trial’s end, the first charge on that day and the card it goes to', async () => {
    const owner = await givenTrialOn('starter');

    expect(await billing(owner.cookie)).toEqual(
      expect.objectContaining({
        plan: 'starter',
        status: 'trialing',
        addOns: 2,
        trialEndsAt: trialEndIso,
        trial: {
          endsAt: trialEndIso,
          cancelled: false,
          firstCharge: { amount: 3500, currency: 'usd', at: trialEndIso },
          paymentMethod: { brand: 'visa', last4: '4242' },
          paymentMethodMissing: false,
        },
      }),
    );
    expect(previewInvoice).toHaveBeenCalledWith({
      customer: 'cus_1',
      subscription: 'sub_1',
    });
  });

  it('says the card is missing once it was removed at Stripe, and finds the customer’s default card otherwise', async () => {
    const owner = await givenTrialOn('starter');
    atStripe = trialAtStripe({ card: false });

    expect((await billing(owner.cookie)).trial).toEqual(
      expect.objectContaining({
        paymentMethod: null,
        paymentMethodMissing: true,
      }),
    );

    retrieveCustomer.mockResolvedValue({
      id: 'cus_1',
      object: 'customer',
      invoice_settings: { default_payment_method: visa },
    } as unknown as Stripe.Customer);
    expect((await billing(owner.cookie)).trial).toEqual(
      expect.objectContaining({
        paymentMethod: { brand: 'visa', last4: '4242' },
        paymentMethodMissing: false,
      }),
    );
  });

  it('answers the stored end date alone when Stripe cannot be asked', async () => {
    const owner = await givenTrialOn('starter');
    retrieveSubscription.mockRejectedValue(new Error('Stripe is down'));

    expect((await billing(owner.cookie)).trial).toEqual({
      endsAt: trialEndIso,
      cancelled: false,
      firstCharge: null,
      paymentMethod: null,
      paymentMethodMissing: false,
    });
  });

  it('has no trial outside one', async () => {
    const owner = await givenTrialOn('starter');
    await givenPlan(ctx, owner.organizationId, 'starter', 'active');

    expect(await billing(owner.cookie)).toEqual(
      expect.objectContaining({ trialEndsAt: null, trial: null }),
    );
  });

  it('upgrades to Business at once and free, keeping the trial’s end, and the paid features pass straight away', async () => {
    const owner = await givenTrialOn('starter');
    expect(await licensed(owner.cookie)).toBe(false);

    const preview = await request(http)
      .get('/billing/upgrade-preview')
      .set('Cookie', owner.cookie);
    expect(preview.status).toBe(200);
    expect(preview.body).toEqual(
      expect.objectContaining({
        today: 0,
        monthlyAfter: 6500,
        renewsAt: trialEnd,
        daysLeft: 20,
      }),
    );

    const res = await request(http)
      .post('/billing/upgrade')
      .set('Cookie', owner.cookie)
      .send({
        prorationDate: (preview.body as { prorationDate: number })
          .prorationDate,
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ plan: 'business' });
    expectFreeSwapTo(BUSINESS_PRICE);
    expect(await storedRow(owner.organizationId)).toEqual({
      plan: 'business',
      status: 'trialing',
      trialEndsAt: new Date(trialEnd * 1000),
      stripeScheduleId: null,
    });
    expect(await licensed(owner.cookie)).toBe(true);
    const after = await billing(owner.cookie);
    expect(after.trialEndsAt).toBe(trialEndIso);
    expect(after.trial).toEqual(
      expect.objectContaining({
        firstCharge: { amount: 6500, currency: 'usd', at: trialEndIso },
      }),
    );
  });

  it('downgrades to Starter at once and free, as a direct swap with no subscription schedule, keeping the trial’s end', async () => {
    const owner = await givenTrialOn('business');
    expect(await licensed(owner.cookie)).toBe(true);

    const res = await request(http)
      .post('/billing/downgrade')
      .set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ plan: 'starter' });
    expectFreeSwapTo(STARTER_PRICE);
    expect(schedules.ids()).toEqual([]);
    expect(await storedRow(owner.organizationId)).toEqual({
      plan: 'starter',
      status: 'trialing',
      trialEndsAt: new Date(trialEnd * 1000),
      stripeScheduleId: null,
    });
    expect(await licensed(owner.cookie)).toBe(false);
    expect(await billing(owner.cookie)).toEqual(
      expect.objectContaining({
        scheduledPlan: null,
        scheduledAt: null,
        trialEndsAt: trialEndIso,
      }),
    );
  });

  it('cancels the trial so nothing is charged, and Keep takes it back', async () => {
    const owner = await givenTrialOn('business');

    const cancel = await request(http)
      .post('/billing/cancel-trial')
      .set('Cookie', owner.cookie);

    expect(cancel.status).toBe(200);
    expect(updateSubscription).toHaveBeenCalledWith('sub_1', {
      cancel_at_period_end: true,
    });
    expect(cancel.body).toEqual(
      expect.objectContaining({
        endsAt: trialEndIso,
        cancelled: true,
        firstCharge: null,
      }),
    );
    // The plan is held to the trial's end as before.
    expect(await licensed(owner.cookie)).toBe(true);
    expect((await billing(owner.cookie)).trial).toEqual(
      expect.objectContaining({ cancelled: true, firstCharge: null }),
    );

    const keep = await request(http)
      .delete('/billing/cancel-trial')
      .set('Cookie', owner.cookie);

    expect(keep.status).toBe(200);
    expect(updateSubscription).toHaveBeenLastCalledWith('sub_1', {
      cancel_at_period_end: false,
    });
    expect(keep.body).toEqual(
      expect.objectContaining({
        cancelled: false,
        firstCharge: { amount: 6500, currency: 'usd', at: trialEndIso },
      }),
    );
  });

  it('refuses Cancel trial and Keep outside a trial, and to a member', async () => {
    const owner = await givenTrialOn('starter');
    const member = await givenMember(owner);

    expect(
      (await request(http).post('/billing/cancel-trial').set('Cookie', member))
        .status,
    ).toBe(403);
    expect(
      (
        await request(http)
          .delete('/billing/cancel-trial')
          .set('Cookie', member)
      ).status,
    ).toBe(403);

    await givenPlan(ctx, owner.organizationId, 'starter', 'active');
    atStripe = { ...trialAtStripe(), status: 'active' };
    const paid = await request(http)
      .post('/billing/cancel-trial')
      .set('Cookie', owner.cookie);
    expect(paid.status).toBe(409);
    expect(paid.body).toEqual(
      expect.objectContaining({ code: 'NOT_IN_TRIAL' }),
    );
    expect(updateSubscription).not.toHaveBeenCalled();
  });

  it('shows no console-wide strip for a trial', async () => {
    const owner = await givenTrialOn('starter');

    const standing = await request(http)
      .get('/billing/standing')
      .set('Cookie', owner.cookie);

    expect(standing.status).toBe(200);
    expect(standing.body).toEqual(
      expect.objectContaining({ frozen: false, paymentFailed: false }),
    );
  });
});
