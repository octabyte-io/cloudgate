import type Stripe from 'stripe';
import {
  firstChargePreviewParams,
  isCancelled,
  paymentMethodOf,
  paymentMethodSummaryOf,
  storedTrialView,
  trialSwitchUpdate,
  trialView,
  trialWillCharge,
} from '../../../src/cloud/billing/plan-trial';

// The Billing page during a free trial (ADR-0054): the switch's one
// update, the cancel, the card, and the view the page reads.

const ENDS = new Date('2026-12-05T10:00:00.000Z');

const subscriptionWith = (fields: Record<string, unknown> = {}) =>
  ({
    id: 'sub_1',
    customer: 'cus_1',
    status: 'trialing',
    cancel_at_period_end: false,
    cancel_at: null,
    default_payment_method: null,
    ...fields,
  }) as unknown as Stripe.Subscription;

const visa = {
  id: 'pm_1',
  type: 'card',
  card: { brand: 'visa', last4: '4242' },
} as unknown as Stripe.PaymentMethod;

describe('trialSwitchUpdate', () => {
  it('swaps the plan item’s price with nothing prorated and leaves the trial end alone', () => {
    const update = trialSwitchUpdate(
      { id: 'si_plan' } as Stripe.SubscriptionItem,
      'price_business_plan',
    );

    expect(update).toEqual({
      items: [{ id: 'si_plan', price: 'price_business_plan' }],
      proration_behavior: 'none',
    });
    expect(update).not.toHaveProperty('trial_end');
  });
});

describe('isCancelled', () => {
  it('reads cancel_at_period_end and cancel_at', () => {
    expect(isCancelled(subscriptionWith())).toBe(false);
    expect(isCancelled(subscriptionWith({ cancel_at_period_end: true }))).toBe(
      true,
    );
    expect(isCancelled(subscriptionWith({ cancel_at: 1_790_000_000 }))).toBe(
      true,
    );
  });
});

describe('trialWillCharge', () => {
  it('is true only for a trial not cancelled and with a payment method on file', () => {
    expect(trialWillCharge(subscriptionWith(), visa)).toBe(true);
    expect(trialWillCharge(subscriptionWith(), 'pm_1')).toBe(true);
    expect(trialWillCharge(subscriptionWith(), null)).toBe(false);
    expect(
      trialWillCharge(subscriptionWith({ cancel_at_period_end: true }), visa),
    ).toBe(false);
  });
});

describe('firstChargePreviewParams', () => {
  it('previews the subscription’s next invoice', () => {
    expect(firstChargePreviewParams(subscriptionWith())).toEqual({
      customer: 'cus_1',
      subscription: 'sub_1',
    });
  });
});

describe('paymentMethodSummaryOf', () => {
  it('names a card by brand and last four, another method by its type, and none as null', () => {
    expect(paymentMethodSummaryOf(visa)).toEqual({
      brand: 'visa',
      last4: '4242',
    });
    expect(
      paymentMethodSummaryOf({
        id: 'pm_2',
        type: 'link',
      } as unknown as Stripe.PaymentMethod),
    ).toEqual({ brand: 'link', last4: null });
    expect(paymentMethodSummaryOf('pm_3')).toEqual({
      brand: 'card',
      last4: null,
    });
    expect(paymentMethodSummaryOf(null)).toBeNull();
  });
});

describe('paymentMethodOf', () => {
  const customer = (method: unknown) =>
    ({
      id: 'cus_1',
      invoice_settings: { default_payment_method: method },
    }) as unknown as Stripe.Customer;

  it('takes the subscription’s own card first, then the customer’s invoice default', () => {
    expect(
      paymentMethodOf(
        subscriptionWith({ default_payment_method: visa }),
        customer('pm_other'),
      ),
    ).toBe(visa);
    expect(paymentMethodOf(subscriptionWith(), customer(visa))).toBe(visa);
    expect(paymentMethodOf(subscriptionWith(), customer(null))).toBeNull();
    expect(
      paymentMethodOf(subscriptionWith(), {
        id: 'cus_1',
        deleted: true,
      } as Stripe.DeletedCustomer),
    ).toBeNull();
  });
});

describe('trialView', () => {
  const upcoming = {
    amount_due: 6500,
    currency: 'usd',
  } as unknown as Stripe.Invoice;

  it('says the end, the first charge on that day, and the card', () => {
    expect(trialView(ENDS, subscriptionWith(), visa, upcoming)).toEqual({
      endsAt: ENDS.toISOString(),
      cancelled: false,
      firstCharge: { amount: 6500, currency: 'usd', at: ENDS.toISOString() },
      paymentMethod: { brand: 'visa', last4: '4242' },
      paymentMethodMissing: false,
    });
  });

  it('has no first charge once cancelled', () => {
    expect(
      trialView(
        ENDS,
        subscriptionWith({ cancel_at_period_end: true }),
        visa,
        upcoming,
      ),
    ).toEqual(expect.objectContaining({ cancelled: true, firstCharge: null }));
  });

  it('says the card is missing when Stripe has none on file', () => {
    expect(trialView(ENDS, subscriptionWith(), null, upcoming)).toEqual(
      expect.objectContaining({
        paymentMethod: null,
        paymentMethodMissing: true,
      }),
    );
  });
});

describe('storedTrialView', () => {
  it('claims nothing it could not ask Stripe', () => {
    expect(storedTrialView(ENDS)).toEqual({
      endsAt: ENDS.toISOString(),
      cancelled: false,
      firstCharge: null,
      paymentMethod: null,
      paymentMethodMissing: false,
    });
  });
});
