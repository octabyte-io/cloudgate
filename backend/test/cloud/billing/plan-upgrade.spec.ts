import type Stripe from 'stripe';
import {
  daysLeftOf,
  isFreshProrationDate,
  PRORATION_DATE_MAX_AGE_SECONDS,
  upgradePreviewParams,
  upgradePreviewView,
} from '../../../src/cloud/billing/plan-upgrade';

// Starter → Business at once, charged today (ADR-0054): the previews
// behind the confirm, and the figures it reads off them.

const DAY = 24 * 60 * 60;
const NOW = 1_780_000_000;

const planItem = {
  id: 'si_plan',
  price: { id: 'price_starter_plan' },
  current_period_end: NOW + 23 * DAY - 60,
} as unknown as Stripe.SubscriptionItem;

const current = {
  id: 'sub_1',
  customer: 'cus_1',
  items: {
    data: [planItem, { id: 'si_add_on', price: { id: 'price_add_on' } }],
  },
} as unknown as Stripe.Subscription;

const invoice = (fields: Partial<Stripe.Invoice>) =>
  fields as unknown as Stripe.Invoice;

describe('upgradePreviewParams', () => {
  it('previews today’s invoice of the swap at the proration time, and the next month with it in place', () => {
    const params = upgradePreviewParams(
      current,
      planItem,
      'price_business_plan',
      NOW,
    );

    const items = [{ id: 'si_plan', price: 'price_business_plan' }];
    expect(params.today).toEqual({
      customer: 'cus_1',
      subscription: 'sub_1',
      subscription_details: {
        items,
        proration_behavior: 'always_invoice',
        proration_date: NOW,
      },
    });
    expect(params.next).toEqual({
      customer: 'cus_1',
      subscription: 'sub_1',
      subscription_details: { items, proration_behavior: 'none' },
    });
  });
});

describe('upgradePreviewView', () => {
  it('reads today’s amount due and the next month’s total off the previews', () => {
    const view = upgradePreviewView(
      invoice({ amount_due: 1533, currency: 'usd' }),
      invoice({ total: 4000, currency: 'usd' }),
      planItem,
      NOW,
    );

    expect(view).toEqual({
      today: 1533,
      monthlyAfter: 4000,
      currency: 'usd',
      daysLeft: 23,
      renewsAt: planItem.current_period_end,
      prorationDate: NOW,
    });
  });
});

describe('daysLeftOf', () => {
  it('counts a part day as a day, and never goes below 0', () => {
    expect(daysLeftOf(NOW + DAY, NOW)).toBe(1);
    expect(daysLeftOf(NOW + DAY + 1, NOW)).toBe(2);
    expect(daysLeftOf(NOW - 5, NOW)).toBe(0);
  });
});

describe('isFreshProrationDate', () => {
  it('honours a preview up to its maximum age, and none from the future', () => {
    expect(isFreshProrationDate(NOW, NOW)).toBe(true);
    expect(
      isFreshProrationDate(NOW - PRORATION_DATE_MAX_AGE_SECONDS, NOW),
    ).toBe(true);
    expect(
      isFreshProrationDate(NOW - PRORATION_DATE_MAX_AGE_SECONDS - 1, NOW),
    ).toBe(false);
    expect(isFreshProrationDate(NOW + 1, NOW)).toBe(false);
  });
});
