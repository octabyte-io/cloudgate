import type Stripe from 'stripe';
import { buyPlanStateOf } from '../../src/bought-servers/buy-plan-state';
import {
  oneMoreAddOn,
  purchaseUpdateParams,
  threeDSecureOf,
  trialChargeCents,
  trialInvoiceItemParams,
  trialInvoiceParams,
} from '../../src/bought-servers/purchase-lines';

const DAY = 24 * 60 * 60;

describe('buyPlanStateOf: what a Bought Server is bought on, in each plan state', () => {
  it('goes through Checkout with no plan', () => {
    expect(
      buyPlanStateOf({ enterprise: false, hasPlan: false, status: null }),
    ).toEqual({ kind: 'none' });
  });

  it('joins the subscription on a paid plan', () => {
    expect(
      buyPlanStateOf({ enterprise: false, hasPlan: true, status: 'active' }),
    ).toEqual({ kind: 'plan' });
  });

  it('is charged on its own during the Free trial', () => {
    expect(
      buyPlanStateOf({ enterprise: false, hasPlan: true, status: 'trialing' }),
    ).toEqual({ kind: 'trial' });
  });

  it.each(['past_due', 'unpaid', 'incomplete'] as const)(
    'is refused while a payment is overdue (%s)',
    (status) => {
      expect(
        buyPlanStateOf({ enterprise: false, hasPlan: true, status }),
      ).toEqual({
        kind: 'refused',
        code: 'PAY_OPEN_INVOICE_FIRST',
        message: 'Pay the open invoice first',
      });
    },
  );

  it('is refused for Enterprise, billed by agreement', () => {
    expect(
      buyPlanStateOf({ enterprise: true, hasPlan: true, status: null }),
    ).toMatchObject({ kind: 'refused', code: 'BUY_NOT_AVAILABLE' });
  });
});

describe('trialChargeCents: a Server bought in the Free trial, to its end', () => {
  it('charges the whole month for a whole 30-day trial', () => {
    expect(trialChargeCents(2500, 0, 30 * DAY)).toBe(2500);
  });

  it('charges the share of the month left', () => {
    expect(trialChargeCents(3000, 0, 10 * DAY)).toBe(1000);
  });

  it('rounds to the cent', () => {
    expect(trialChargeCents(2500, 0, 7 * DAY)).toBe(583);
  });

  it('never charges more than a month, nor less than nothing', () => {
    expect(trialChargeCents(2500, 0, 45 * DAY)).toBe(2500);
    expect(trialChargeCents(2500, 10, 0)).toBe(0);
  });
});

describe('trialInvoiceParams: the Free-trial invoice', () => {
  it('asks for 3D Secure only for the first Server', () => {
    const base = {
      customer: 'cus_1',
      boughtServerId: 'b1',
      paymentMethod: 'pm_1',
    };
    expect(
      trialInvoiceParams({ ...base, threeDSecure: true }).payment_settings,
    ).toEqual({
      payment_method_options: { card: { request_three_d_secure: 'any' } },
    });
    expect(
      trialInvoiceParams({ ...base, threeDSecure: false }).payment_settings,
    ).toBeUndefined();
  });

  it('charges the line from today to the trial end, under its fixed Product', () => {
    expect(
      trialInvoiceItemParams({
        customer: 'cus_1',
        invoice: 'in_1',
        boughtServerId: 'b1',
        line: { kind: 'server', monthlyCents: 3000 },
        from: 0,
        to: 10 * DAY,
      }),
    ).toMatchObject({
      invoice: 'in_1',
      price_data: {
        currency: 'usd',
        product: 'cloudgate_bought_server',
        unit_amount: 1000,
      },
      period: { start: 0, end: 10 * DAY },
    });
  });
});

describe('oneMoreAddOn: a full Server count', () => {
  const subscription = (
    items: Array<{ id: string; price: string; quantity: number }>,
  ) =>
    ({
      items: {
        data: items.map((item) => ({ ...item, price: { id: item.price } })),
      },
    }) as unknown as Stripe.Subscription;

  it('raises the Add-on item by exactly one', () => {
    expect(
      oneMoreAddOn(
        subscription([
          { id: 'si_plan', price: 'price_starter', quantity: 1 },
          { id: 'si_addon', price: 'price_addon', quantity: 2 },
        ]),
        'price_addon',
      ),
    ).toEqual({ id: 'si_addon', quantity: 3 });
  });

  it('adds one Add-on item when there is none', () => {
    expect(
      oneMoreAddOn(
        subscription([{ id: 'si_plan', price: 'price_starter', quantity: 1 }]),
        'price_addon',
      ),
    ).toEqual({ price: 'price_addon', quantity: 1 });
  });

  it('goes in the same change as the Server line', () => {
    expect(
      purchaseUpdateParams(['price_server'], 100, {
        price: 'price_addon',
        quantity: 1,
      }).items,
    ).toEqual([
      { price: 'price_server', quantity: 1 },
      { price: 'price_addon', quantity: 1 },
    ]);
  });
});

describe('threeDSecureOf', () => {
  it('reads the setting the subscription has, automatic when unset', () => {
    expect(threeDSecureOf({} as Stripe.Subscription)).toBe('automatic');
    expect(
      threeDSecureOf({
        payment_settings: {
          payment_method_options: {
            card: { request_three_d_secure: 'challenge' },
          },
        },
      } as unknown as Stripe.Subscription),
    ).toBe('challenge');
  });
});
