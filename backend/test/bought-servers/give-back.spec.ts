import type Stripe from 'stripe';
import { serverShareOf } from '../../src/bought-servers/give-back';

const invoiceOf = (
  lines: Array<{ price: string | null; amount: number; quantity?: number }>,
): Stripe.Invoice =>
  ({
    lines: {
      data: lines.map((line) => ({
        amount: line.amount,
        quantity: line.quantity ?? 1,
        pricing: { price_details: { price: line.price } },
      })),
    },
  }) as unknown as Stripe.Invoice;

const prices = {
  lines: ['price_server', 'price_backups'],
  addOn: 'price_add_on',
  plans: ['price_starter'],
};

describe('serverShareOf', () => {
  it('is the whole of an invoice that charges no plan', () => {
    expect(
      serverShareOf(
        invoiceOf([
          { price: 'price_server', amount: 2500 },
          { price: 'price_add_on', amount: 500 },
        ]),
        prices,
      ),
    ).toBe(1);
    // The Free trial's own invoice, priced inline.
    expect(
      serverShareOf(invoiceOf([{ price: null, amount: 900 }]), prices),
    ).toBe(1);
  });

  it("is the Server's lines and one Add-on of a Checkout invoice that started the plan", () => {
    const share = serverShareOf(
      invoiceOf([
        { price: 'price_starter', amount: 1500 },
        { price: 'price_add_on', amount: 1000, quantity: 2 },
        { price: 'price_server', amount: 2500 },
        { price: 'price_backups', amount: 500 },
      ]),
      prices,
    );
    expect(share).toBeCloseTo(3500 / 5500);
  });
});
