import type Stripe from 'stripe';
import type { StripeApi } from '../cloud/billing/stripe-api';
import type { RefundedTo } from '../mail/templates';
import { idOf, paidIntentIdOf } from './purchase-payment';

/**
 * A paid purchase or change given back in full (ADR-0071: a failed create or
 * change never costs the customer anything): the card's part refunded, and
 * the part paid from the customer's credit balance credited back to it. Each
 * is asked with a fixed idempotency key, so a restart part-way through asks
 * again without giving back twice.
 */

/** Stripe's refusal of a second full refund: the money is already back. */
export function alreadyRefunded(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === 'charge_already_refunded'
  );
}

/** What a paid invoice took, and from where, in its currency's smallest unit. */
export interface PaidParts {
  /** The card payment's intent, null when no card paid any of it. */
  intentId: string | null;
  /** What the card paid. */
  cardCents: number;
  /** What the customer's credit balance paid. */
  balanceCents: number;
}

/**
 * The parts of a paid invoice: the card's (`amount_paid`) and the credit
 * balance's (how far the invoice moved the balance: a credit is negative, so
 * using it raises the balance toward zero).
 */
export function paidPartsOf(invoice: Stripe.Invoice): PaidParts {
  const starting = invoice.starting_balance ?? 0;
  const ending = invoice.ending_balance ?? starting;
  return {
    intentId: paidIntentIdOf(invoice),
    cardCents: invoice.amount_paid ?? 0,
    balanceCents: Math.max(0, ending - starting),
  };
}

/** What was given back: the whole amount, and where it went. */
export interface GivenBack {
  cents: number;
  to: RefundedTo;
}

/**
 * The Server's share of what an invoice charged, from 0 to 1. An invoice that
 * charges a plan too (the Checkout that started Starter and charged the
 * Server with it) is shared out by its lines' amounts: the Server's lines,
 * and one Add-on of the Add-on line when the purchase took one. Any other
 * invoice is the Server's whole: its own (the Free trial's), or the
 * subscription update that added its lines (with any Add-on they needed).
 */
export function serverShareOf(
  invoice: Stripe.Invoice,
  prices: {
    /** The Server's own lines' prices. */
    lines: readonly string[];
    /** The Add-on's price, when one Add-on of the invoice was the Server's. */
    addOn: string | null;
    /** The plans' prices: an invoice charging one is shared out. */
    plans: readonly string[];
  },
): number {
  const lines = invoice.lines?.data ?? [];
  const priceOf = (line: Stripe.InvoiceLineItem) =>
    idOf(line.pricing?.price_details?.price);
  const chargesPlan = lines.some((line) => {
    const price = priceOf(line);
    return price !== null && prices.plans.includes(price);
  });
  if (!chargesPlan) return 1;
  let total = 0;
  let server = 0;
  for (const line of lines) {
    const amount = line.amount ?? 0;
    total += amount;
    const price = priceOf(line);
    if (price === null) continue;
    if (prices.lines.includes(price)) server += amount;
    else if (price === prices.addOn) {
      server += amount / Math.max(1, line.quantity ?? 1);
    }
  }
  return total > 0 ? Math.min(1, Math.max(0, server / total)) : 0;
}

/**
 * Gives a paid invoice back, in full or the Server's `share` of it (see
 * {@link serverShareOf}), and answers how much went back and where (null
 * when there was nothing to give). The card's part goes first, the credit
 * balance's after. `key` is the idempotency key's stem; `metadata` goes on
 * the refund and the balance credit.
 */
export async function giveBackInFull(
  stripe: StripeApi,
  invoice: Stripe.Invoice,
  key: string,
  metadata: Record<string, string>,
  share = 1,
): Promise<GivenBack | null> {
  const parts = paidPartsOf(invoice);
  const customer = idOf(invoice.customer);
  const cardPaid = parts.intentId ? parts.cardCents : 0;
  const balancePaid = customer ? parts.balanceCents : 0;
  const due = Math.round((cardPaid + balancePaid) * share);
  const card = Math.min(cardPaid, due);
  const balance = Math.min(balancePaid, due - card);

  if (parts.intentId && card > 0) {
    try {
      await stripe.createRefund(
        {
          payment_intent: parts.intentId,
          // Only part of the payment: the rest paid for the plan, which stays.
          ...(card < cardPaid ? { amount: card } : {}),
          reason: 'requested_by_customer',
          metadata,
        },
        key,
      );
    } catch (error) {
      if (!alreadyRefunded(error)) throw error;
    }
  }
  if (balance > 0 && customer) {
    await stripe.createBalanceTransaction(
      customer,
      {
        amount: -balance,
        currency: invoice.currency ?? 'usd',
        description: 'Refund of a Server charge that could not be completed',
        metadata,
      },
      `${key}-balance`,
    );
  }
  if (card + balance <= 0) return null;
  return {
    cents: card + balance,
    to: balance === 0 ? 'card' : card === 0 ? 'balance' : 'both',
  };
}
