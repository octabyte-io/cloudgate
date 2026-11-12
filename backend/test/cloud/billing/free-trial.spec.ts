import type Stripe from 'stripe';
import {
  defaultPaymentMethodIdOf,
  TRIAL_DAYS,
  endedDuringTrial,
  isTrialStatus,
  monthlyAmountOf,
  trialQuoteOf,
  trialCheckoutParams,
  trialEmailKey,
  trialEmailKeyOf,
  trialEndsAtOf,
  trialFactsOf,
  trialUsedOf,
} from '../../../src/cloud/billing/free-trial';

const SECRET = 'a-test-secret-that-is-at-least-32-characters';

const sub = (fields: Record<string, unknown>) =>
  fields as unknown as Stripe.Subscription;

describe('trialEmailKey', () => {
  it('is the same key for the same address whatever its case or spaces', () => {
    const key = trialEmailKey(SECRET, 'grace@example.com');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(trialEmailKey(SECRET, '  Grace@Example.COM ')).toBe(key);
  });

  it('holds nothing of the address, and differs by address and by secret', () => {
    const key = trialEmailKey(SECRET, 'grace@example.com');
    expect(key).not.toContain('grace');
    expect(trialEmailKey(SECRET, 'ada@example.com')).not.toBe(key);
    expect(trialEmailKey(`${SECRET}-other`, 'grace@example.com')).not.toBe(key);
  });

  it('refuses without a secret rather than keying on nothing', () => {
    expect(() => trialEmailKey('', 'grace@example.com')).toThrow(
      /APP_ENCRYPTION_SECRET is not set/,
    );
  });
});

describe('trialCheckoutParams', () => {
  it('asks for the 30-day trial, cancelled at its end with no card, and carries the email key', () => {
    expect(trialCheckoutParams('k3y')).toEqual({
      payment_method_collection: 'always',
      subscription_data: {
        trial_period_days: TRIAL_DAYS,
        trial_settings: {
          end_behavior: { missing_payment_method: 'cancel' },
        },
        metadata: { trialEmailKey: 'k3y' },
      },
    });
    expect(TRIAL_DAYS).toBe(30);
  });

  it('still collects a card when no trial is given, and asks for none', () => {
    expect(trialCheckoutParams(null)).toEqual({
      payment_method_collection: 'always',
      subscription_data: {},
    });
  });
});

describe('trialFactsOf', () => {
  it('reads the trial end, and counts a trialing or active subscription as begun', () => {
    expect(
      trialFactsOf(sub({ status: 'trialing', trial_end: 1_798_761_600 })),
    ).toEqual({ trialEndsAt: new Date(1_798_761_600_000), begun: true });
    expect(trialFactsOf(sub({ status: 'active', trial_end: null }))).toEqual({
      trialEndsAt: null,
      begun: true,
    });
  });

  it('does not count a first payment that never went through', () => {
    for (const status of ['incomplete', 'incomplete_expired']) {
      expect(trialFactsOf(sub({ status })).begun).toBe(false);
    }
  });
});

describe('trialEmailKeyOf', () => {
  it('is the key Checkout put on a subscription with a trial, and nothing otherwise', () => {
    const metadata = { organizationId: 'org_1', trialEmailKey: 'k3y' };
    expect(trialEmailKeyOf(sub({ trial_end: 1, metadata }))).toBe('k3y');
    expect(trialEmailKeyOf(sub({ trial_end: null, metadata }))).toBeNull();
    expect(
      trialEmailKeyOf(sub({ trial_end: 1, metadata: { organizationId: 'o' } })),
    ).toBeNull();
  });
});

describe('trialUsedOf', () => {
  const none = {
    firstSubscribedAt: null,
    firstEnterpriseAt: null,
    firstAttachedAt: null,
  };

  it('is true once the Organization has held a subscription, been Enterprise or been attached, and never before', () => {
    const at = new Date('2026-11-01T00:00:00Z');
    expect(trialUsedOf(null)).toBe(false);
    expect(trialUsedOf(none)).toBe(false);
    expect(trialUsedOf({ ...none, firstSubscribedAt: at })).toBe(true);
    expect(trialUsedOf({ ...none, firstEnterpriseAt: at })).toBe(true);
    expect(trialUsedOf({ ...none, firstAttachedAt: at })).toBe(true);
  });
});

describe('isTrialStatus', () => {
  it('is true for trialing alone', () => {
    expect(isTrialStatus('trialing')).toBe(true);
    for (const status of ['active', 'past_due', 'canceled', null, undefined]) {
      expect(isTrialStatus(status)).toBe(false);
    }
  });
});

describe('trialEndsAtOf', () => {
  const end = new Date('2026-12-05T00:00:00Z');

  it('answers the trial end while a held subscription is trialing', () => {
    expect(
      trialEndsAtOf({
        status: 'trialing',
        trialEndsAt: end,
        stripeSubscriptionId: 'sub_1',
      }),
    ).toEqual(end);
  });

  it('is null once the trial is over, or the subscription gone', () => {
    expect(
      trialEndsAtOf({
        status: 'active',
        trialEndsAt: end,
        stripeSubscriptionId: 'sub_1',
      }),
    ).toBeNull();
    expect(
      trialEndsAtOf({
        status: 'trialing',
        trialEndsAt: end,
        stripeSubscriptionId: null,
      }),
    ).toBeNull();
    expect(trialEndsAtOf(null)).toBeNull();
  });
});

describe('defaultPaymentMethodIdOf', () => {
  it("is the id of the subscription's payment method, expanded or not", () => {
    expect(
      defaultPaymentMethodIdOf(sub({ default_payment_method: 'pm_1' })),
    ).toBe('pm_1');
    expect(
      defaultPaymentMethodIdOf(sub({ default_payment_method: { id: 'pm_2' } })),
    ).toBe('pm_2');
  });

  it('is null for a subscription with none', () => {
    expect(
      defaultPaymentMethodIdOf(sub({ default_payment_method: null })),
    ).toBeNull();
    expect(defaultPaymentMethodIdOf(sub({}))).toBeNull();
  });
});

describe('endedDuringTrial', () => {
  const TRIAL_END = 1_800_000_000;

  it('is a subscription the row still held as trialing', () => {
    expect(endedDuringTrial('trialing')).toBe(true);
  });

  it('is one Stripe ended no later than its trial did', () => {
    expect(
      endedDuringTrial('active', { trial_end: TRIAL_END, ended_at: TRIAL_END }),
    ).toBe(true);
    expect(
      endedDuringTrial(null, {
        trial_end: TRIAL_END,
        ended_at: TRIAL_END - 86_400,
      }),
    ).toBe(true);
  });

  it('is not one paid for after its trial, nor one that never had a trial', () => {
    expect(
      endedDuringTrial('active', {
        trial_end: TRIAL_END,
        ended_at: TRIAL_END + 40 * 86_400,
      }),
    ).toBe(false);
    expect(
      endedDuringTrial('active', { trial_end: null, ended_at: TRIAL_END }),
    ).toBe(false);
    expect(endedDuringTrial('past_due')).toBe(false);
  });
});

describe('trialQuoteOf', () => {
  const prices = {
    starterPriceId: 'price_starter',
    businessPriceId: 'price_business',
    addOnPriceId: 'price_add_on',
  };
  const trialing = (status = 'trialing') =>
    sub({
      status,
      trial_end: 1_800_000_000,
      items: {
        data: [
          {
            price: { id: 'price_business', unit_amount: 4900, currency: 'usd' },
            quantity: 1,
          },
          {
            price: { id: 'price_add_on', unit_amount: 500, currency: 'usd' },
            quantity: 3,
          },
        ],
      },
    });

  it('quotes the end, the plan and Add-ons held now, and their monthly amount', () => {
    expect(trialQuoteOf(prices, trialing())).toEqual({
      endsOn: new Date(1_800_000_000 * 1000),
      plan: 'business',
      addOns: 3,
      monthly: { amount: 6400, currency: 'usd' },
    });
  });

  it('quotes nothing outside a trial', () => {
    expect(trialQuoteOf(prices, trialing('active'))).toBeNull();
  });
});

describe('monthlyAmountOf', () => {
  const item = (
    unit_amount: number | null,
    quantity: number,
    currency = 'usd',
  ) => ({
    price: { unit_amount, currency },
    quantity,
  });
  const items = (...data: unknown[]) => sub({ items: { data } });

  it('adds the plan and the Add-ons by quantity', () => {
    expect(monthlyAmountOf(items(item(1500, 1), item(500, 2)))).toEqual({
      amount: 2500,
      currency: 'usd',
    });
  });

  it('quotes nothing it cannot total', () => {
    expect(monthlyAmountOf(items())).toBeNull();
    expect(monthlyAmountOf(items(item(1500, 1), item(null, 2)))).toBeNull();
    expect(
      monthlyAmountOf(items(item(1500, 1), item(500, 2, 'eur'))),
    ).toBeNull();
  });
});
