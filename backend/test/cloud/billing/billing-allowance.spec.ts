import {
  allowanceOf,
  grantsPaidFeatures,
  isPaidStatus,
  minimumAddOns,
  refusalFor,
} from '../../../src/cloud/billing/billing-allowance';
import {
  checkoutLineItems,
  missingPriceSettings,
  PLAN_NAMES,
  purchasedItems,
} from '../../../src/cloud/billing/billing.plans';

/**
 * The one allowance rule (ADR-0048, ADR-0054) as a pure
 * function: `3 + addOns` of each with either plan, 0/0 without, and the
 * refusal that points at "choose a plan" or at the Add-on. The HTTP behaviour
 * is billing.e2e-spec.ts.
 */
describe('allowanceOf, refusalFor and checkoutLineItems: the Hosted plan allowance', () => {
  const prices = {
    starterPriceId: 'price_starter',
    businessPriceId: 'price_business',
    addOnPriceId: 'price_add_on',
  };

  it.each(PLAN_NAMES)('gives %s the same counts as the other plan', (plan) => {
    expect(allowanceOf({ plan, status: 'active', addOns: 1 })).toEqual({
      plan,
      servers: 4,
      cloudEnvironments: 4,
    });
  });

  it('is 3 + addOns of each while the plan is granted, past due included', () => {
    for (const status of ['active', 'trialing', 'past_due']) {
      expect(allowanceOf({ plan: 'starter', status, addOns: 2 })).toEqual({
        plan: 'starter',
        servers: 5,
        cloudEnvironments: 5,
      });
    }
  });

  it('is 0/0 with no row, no plan, or a status that grants nothing', () => {
    const none = { plan: null, servers: 0, cloudEnvironments: 0 };
    expect(allowanceOf(null)).toEqual(none);
    expect(allowanceOf({ plan: null, status: 'active', addOns: 4 })).toEqual(
      none,
    );
    for (const status of [
      'canceled',
      'unpaid',
      'incomplete',
      'incomplete_expired',
      'paused',
    ]) {
      expect(allowanceOf({ plan: 'starter', status, addOns: 4 })).toEqual(none);
    }
  });

  it('refuses with "choose a plan" without one, and points at the Add-on when full', () => {
    expect(
      refusalFor('servers', allowanceOf(null), {
        servers: 0,
        cloudEnvironments: 0,
      }),
    ).toMatchObject({ code: 'PLAN_REQUIRED' });

    const plan = allowanceOf({ plan: 'starter', status: 'active', addOns: 0 });
    expect(
      refusalFor('servers', plan, { servers: 2, cloudEnvironments: 0 }),
    ).toBeNull();
    expect(
      refusalFor('servers', plan, { servers: 3, cloudEnvironments: 0 }),
    ).toEqual({
      code: 'ALLOWANCE_FULL',
      message:
        'This Organization has 3 Servers, all its plan allows. Buy an Add-on for one more Server and one more Cloud Environment under Settings > Billing.',
    });
    // Over the allowance (Add-ons lowered at Stripe): still only the next one.
    expect(
      refusalFor('servers', plan, { servers: 7, cloudEnvironments: 0 }),
    ).toMatchObject({
      code: 'ALLOWANCE_FULL',
    });
  });

  it('is the hand-set counts for Enterprise, whatever Stripe last said', () => {
    const enterprise = {
      enterprise: true,
      enterpriseServers: 10,
      enterpriseCloudEnvironments: 4,
    };
    for (const standing of [
      { plan: null, status: null, addOns: 0 },
      { plan: 'starter' as const, status: 'canceled', addOns: 2 },
      { plan: 'starter' as const, status: 'active', addOns: 2 },
    ]) {
      expect(allowanceOf({ ...standing, ...enterprise })).toEqual({
        plan: 'enterprise',
        servers: 10,
        cloudEnvironments: 4,
      });
    }
  });

  it('refuses a full Enterprise count without pointing at the Add-on, and counts of 0 are full rather than "choose a plan"', () => {
    const allowance = allowanceOf({
      plan: null,
      status: null,
      addOns: 0,
      enterprise: true,
      enterpriseServers: 2,
      enterpriseCloudEnvironments: 0,
    });
    expect(
      refusalFor('servers', allowance, { servers: 1, cloudEnvironments: 0 }),
    ).toBeNull();
    expect(
      refusalFor('servers', allowance, { servers: 2, cloudEnvironments: 0 }),
    ).toEqual({
      code: 'ALLOWANCE_FULL',
      message:
        'This Organization has 2 Servers, all its Enterprise agreement allows. Contact us at support@octabyte.io to raise its counts.',
    });

    const none = allowanceOf({
      plan: null,
      status: null,
      addOns: 0,
      enterprise: true,
      enterpriseServers: 0,
      enterpriseCloudEnvironments: 0,
    });
    expect(
      refusalFor('servers', none, { servers: 0, cloudEnvironments: 0 }),
    ).toMatchObject({
      code: 'ALLOWANCE_FULL',
    });
  });

  it('needs Add-ons only for what is held beyond the base 3', () => {
    expect(minimumAddOns({ servers: 0, cloudEnvironments: 0 })).toBe(0);
    expect(minimumAddOns({ servers: 3, cloudEnvironments: 0 })).toBe(0);
    expect(minimumAddOns({ servers: 5, cloudEnvironments: 0 })).toBe(2);
  });

  it('covers Cloud Environments in the Add-on floor, by whichever kind holds more', () => {
    expect(minimumAddOns({ servers: 1, cloudEnvironments: 6 })).toBe(3);
    expect(minimumAddOns({ servers: 5, cloudEnvironments: 4 })).toBe(2);
  });

  it('refuses one more Cloud Environment with "choose a plan", or the Add-on once full', () => {
    const usage = (cloudEnvironments: number) => ({
      servers: 0,
      cloudEnvironments,
    });
    expect(
      refusalFor('cloudEnvironments', allowanceOf(null), usage(0)),
    ).toEqual({
      code: 'PLAN_REQUIRED',
      message:
        'Choose a plan to add a Cloud Environment. Starter and Business each include 3 Servers and 3 Cloud Environments; choose one under Settings > Billing.',
    });

    const plan = allowanceOf({ plan: 'starter', status: 'active', addOns: 1 });
    expect(refusalFor('cloudEnvironments', plan, usage(3))).toBeNull();
    expect(refusalFor('cloudEnvironments', plan, usage(4))).toEqual({
      code: 'ALLOWANCE_FULL',
      message:
        'This Organization has 4 Cloud Environments, all its plan allows. Buy an Add-on for one more Server and one more Cloud Environment under Settings > Billing.',
    });
    // Servers and Cloud Environments are counted apart.
    expect(
      refusalFor('servers', plan, { servers: 0, cloudEnvironments: 9 }),
    ).toBeNull();
  });

  it('bills the chosen plan once and the Add-on by quantity, with no zero line', () => {
    expect(checkoutLineItems(prices, 'starter', 0)).toEqual([
      { price: 'price_starter', quantity: 1 },
    ]);
    expect(checkoutLineItems(prices, 'business', 0)).toEqual([
      { price: 'price_business', quantity: 1 },
    ]);
    expect(checkoutLineItems(prices, 'starter', 3)).toEqual([
      { price: 'price_starter', quantity: 1 },
      { price: 'price_add_on', quantity: 3 },
    ]);
    expect(checkoutLineItems(prices, 'business', 2)).toEqual([
      { price: 'price_business', quantity: 1 },
      { price: 'price_add_on', quantity: 2 },
    ]);
  });

  it('reads which plan and how many Add-ons a subscription holds, ignoring prices it does not sell', () => {
    expect(
      purchasedItems(prices, [
        { priceId: 'price_starter', quantity: 1 },
        { priceId: 'price_add_on', quantity: 2 },
      ]),
    ).toEqual({ plan: 'starter', addOns: 2 });
    expect(
      purchasedItems(prices, [
        { priceId: 'price_add_on', quantity: 1 },
        { priceId: 'price_business', quantity: 1 },
      ]),
    ).toEqual({ plan: 'business', addOns: 1 });
    expect(
      purchasedItems(prices, [{ priceId: 'price_hobby', quantity: 5 }]),
    ).toEqual({ plan: null, addOns: 0 });
    // Both plan prices at once — never sold so, but it is paying for Business.
    expect(
      purchasedItems(prices, [
        { priceId: 'price_starter', quantity: 1 },
        { priceId: 'price_business', quantity: 1 },
      ]),
    ).toEqual({ plan: 'business', addOns: 0 });
  });

  it('names each unset price setting, blank counting as unset', () => {
    expect(missingPriceSettings(prices)).toEqual([]);
    expect(missingPriceSettings({ starterPriceId: ' ' })).toEqual([
      'STARTER_PLAN_PRICE_ID',
      'BUSINESS_PLAN_PRICE_ID',
      'ADD_ON_PRICE_ID',
    ]);
    expect(
      missingPriceSettings({ ...prices, businessPriceId: undefined }),
    ).toEqual(['BUSINESS_PLAN_PRICE_ID']);
  });
});

/**
 * The Hosted paid-feature rule (ADR-0054): Business, or Enterprise,
 * which always counts as Business. The e2e side is hosted-enterprise.e2e-spec.ts.
 */
describe('isPaidStatus', () => {
  it('is true for a paid subscription or one in its free trial, and not for past_due', () => {
    expect(isPaidStatus('active')).toBe(true);
    expect(isPaidStatus('trialing')).toBe(true);
    for (const status of ['past_due', 'canceled', 'unpaid', null]) {
      expect(isPaidStatus(status)).toBe(false);
    }
  });
});

describe('grantsPaidFeatures', () => {
  it('grants on Business while the plan is granted, past due and trialing included', () => {
    for (const status of ['active', 'trialing', 'past_due']) {
      expect(grantsPaidFeatures({ plan: 'business', status, addOns: 0 })).toBe(
        true,
      );
    }
  });

  it('never grants on Starter', () => {
    for (const status of ['active', 'trialing', 'past_due']) {
      expect(grantsPaidFeatures({ plan: 'starter', status, addOns: 2 })).toBe(
        false,
      );
    }
  });

  it('does not grant on Business once the status grants nothing, nor with no row', () => {
    for (const status of ['canceled', 'unpaid', 'incomplete', 'paused']) {
      expect(grantsPaidFeatures({ plan: 'business', status, addOns: 0 })).toBe(
        false,
      );
    }
    expect(grantsPaidFeatures(null)).toBe(false);
    expect(grantsPaidFeatures({ plan: null, status: null, addOns: 0 })).toBe(
      false,
    );
  });

  it('grants on Enterprise, whatever the plan or Stripe last said', () => {
    for (const standing of [
      { plan: null, status: null, addOns: 0 },
      { plan: 'starter' as const, status: 'active', addOns: 0 },
      { plan: 'starter' as const, status: 'canceled', addOns: 0 },
    ]) {
      expect(grantsPaidFeatures({ ...standing, enterprise: true })).toBe(true);
    }
  });
});
