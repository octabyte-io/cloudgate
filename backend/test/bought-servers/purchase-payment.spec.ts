import type Stripe from 'stripe';
import {
  PAYMENT_REFUSED_FALLBACK,
  invoiceCharging,
  invoicePriceIds,
  paidIntentIdOf,
  purchasePaymentOf,
} from '../../src/bought-servers/purchase-payment';

const PAY_URL = 'https://invoice.stripe.test/in_1';

function invoice(
  status: Stripe.Invoice.Status,
  intent?: { status: string; last_payment_error?: { message?: string } | null },
): Stripe.Invoice {
  return {
    id: 'in_1',
    status,
    hosted_invoice_url: PAY_URL,
    payments: {
      data: intent
        ? [{ payment: { type: 'payment_intent', payment_intent: intent } }]
        : [],
    },
  } as unknown as Stripe.Invoice;
}

describe('purchasePaymentOf: where a Bought Server purchase payment stands', () => {
  it('is paid once its invoice is', () => {
    expect(purchasePaymentOf(invoice('paid'))).toEqual({ kind: 'paid' });
  });

  it.each(['void', 'uncollectible'] as const)(
    'is dropped once its invoice is %s',
    (status) => {
      expect(purchasePaymentOf(invoice(status))).toEqual({ kind: 'dropped' });
    },
  );

  it('waits for 3D Secure, with where to finish paying', () => {
    expect(
      purchasePaymentOf(invoice('open', { status: 'requires_action' })),
    ).toEqual({ kind: 'waiting', payUrl: PAY_URL });
  });

  it("is refused with the bank's reason once the card was declined", () => {
    expect(
      purchasePaymentOf(
        invoice('open', {
          status: 'requires_payment_method',
          last_payment_error: { message: 'Your card was declined.' },
        }),
      ),
    ).toEqual({ kind: 'refused', message: 'Your card was declined.' });
  });

  it('says the card was refused when the bank gave no reason', () => {
    expect(
      purchasePaymentOf(
        invoice('open', {
          status: 'requires_payment_method',
          last_payment_error: {},
        }),
      ),
    ).toEqual({ kind: 'refused', message: PAYMENT_REFUSED_FALLBACK });
  });

  it('waits while no payment was tried yet', () => {
    expect(
      purchasePaymentOf(
        invoice('open', {
          status: 'requires_payment_method',
          last_payment_error: null,
        }),
      ),
    ).toEqual({ kind: 'waiting', payUrl: PAY_URL });
    expect(purchasePaymentOf(invoice('draft'))).toEqual({
      kind: 'waiting',
      payUrl: PAY_URL,
    });
  });
});

describe('paidIntentIdOf: the payment a refund gives back', () => {
  function paidWith(
    entries: Array<{ status?: string; payment_intent: unknown }>,
  ): Stripe.Invoice {
    return {
      id: 'in_1',
      status: 'paid',
      payments: {
        data: entries.map(({ status, payment_intent }) => ({
          status,
          payment: { type: 'payment_intent', payment_intent },
        })),
      },
    } as unknown as Stripe.Invoice;
  }

  it('names the paid payment intent, expanded or not', () => {
    expect(
      paidIntentIdOf(paidWith([{ status: 'paid', payment_intent: 'pi_1' }])),
    ).toBe('pi_1');
    expect(
      paidIntentIdOf(
        paidWith([
          {
            status: 'paid',
            payment_intent: { id: 'pi_2', status: 'succeeded' },
          },
        ]),
      ),
    ).toBe('pi_2');
  });

  it('skips a payment that was tried and never went through', () => {
    expect(
      paidIntentIdOf(
        paidWith([
          { status: 'canceled', payment_intent: 'pi_refused' },
          { status: 'paid', payment_intent: 'pi_paid' },
        ]),
      ),
    ).toBe('pi_paid');
  });

  it('is null when nothing was paid by card, such as an invoice paid from credit', () => {
    expect(paidIntentIdOf(paidWith([]))).toBeNull();
  });
});

describe('invoicePriceIds', () => {
  const withLines = (prices: unknown[]) =>
    ({
      lines: {
        data: prices.map((price) => ({
          pricing:
            price === null
              ? null
              : { type: 'price_details', price_details: { price } },
        })),
      },
    }) as unknown as Stripe.Invoice;

  it('reads the price of each line, by id or expanded', () => {
    expect(invoicePriceIds(withLines(['price_a', { id: 'price_b' }]))).toEqual([
      'price_a',
      'price_b',
    ]);
  });

  it('skips a line with no price, and an invoice with no lines', () => {
    expect(invoicePriceIds(withLines([null]))).toEqual([]);
    expect(invoicePriceIds({} as Stripe.Invoice)).toEqual([]);
  });
});

describe('invoiceCharging: the invoice a charge made, when its id was never stored', () => {
  const charging = (
    id: string,
    prices: string[],
    metadata: Record<string, string> = {},
  ) =>
    ({
      id,
      metadata,
      lines: {
        data: prices.map((price) => ({
          pricing: { price_details: { price } },
        })),
      },
    }) as unknown as Stripe.Invoice;

  it('is the newest invoice charging one of the prices, or carrying the Bought Server id', () => {
    const invoices = [
      charging('in_renewal', ['price_plan']),
      charging('in_purchase', ['price_plan', 'price_bs_1']),
      charging('in_older', ['price_bs_1']),
    ];
    expect(invoiceCharging(invoices, 'bs_1', ['price_bs_1'])?.id).toBe(
      'in_purchase',
    );
    expect(
      invoiceCharging(
        [charging('in_trial', [], { boughtServerId: 'bs_1' })],
        'bs_1',
        [],
      )?.id,
    ).toBe('in_trial');
  });

  it('is nothing when no invoice charges them', () => {
    expect(
      invoiceCharging([charging('in_renewal', ['price_plan'])], 'bs_1', [
        'price_bs_1',
      ]),
    ).toBeNull();
    expect(invoiceCharging([], 'bs_1', ['price_bs_1'])).toBeNull();
  });
});
