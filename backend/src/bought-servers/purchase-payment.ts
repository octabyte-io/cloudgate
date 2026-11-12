import type Stripe from 'stripe';

/**
 * Where a Bought Server purchase's payment stands, read off its Stripe
 * invoice (pure). The purchase is a subscription update made with
 * `always_invoice` and `pending_if_incomplete` (ADR-0071): its invoice is
 * paid at once, or it stays open while the payment waits for 3D Secure or
 * was refused, and the update is applied only once it is paid.
 */
export type PurchasePayment =
  | { kind: 'paid' }
  /** Open, with the customer's part still to do: *Finish paying*. */
  | { kind: 'waiting'; payUrl: string | null }
  /** Open, but the card was refused; `message` is the bank's reason, as Stripe words it. */
  | { kind: 'refused'; message: string }
  /** Voided or written off: it will never be paid. */
  | { kind: 'dropped' };

/** Said when the bank gave no reason of its own. */
export const PAYMENT_REFUSED_FALLBACK = 'The card was refused';

/** The invoice's payment intent, when it was expanded. */
export function paymentIntentOf(
  invoice: Stripe.Invoice,
): Stripe.PaymentIntent | null {
  for (const entry of invoice.payments?.data ?? []) {
    const intent = entry.payment?.payment_intent;
    if (intent && typeof intent === 'object') return intent;
  }
  return null;
}

/**
 * The payment intent that paid the invoice, expanded or not: what a refund
 * of the purchase gives back. Null when no card payment paid it (an invoice
 * settled from the customer's credit balance has none).
 */
export function paidIntentIdOf(invoice: Stripe.Invoice): string | null {
  for (const entry of invoice.payments?.data ?? []) {
    if (entry.status !== 'paid') continue;
    const id = idOf(entry.payment?.payment_intent);
    if (id) return id;
  }
  return null;
}

/** How the purchase's invoice stands. */
export function purchasePaymentOf(invoice: Stripe.Invoice): PurchasePayment {
  switch (invoice.status) {
    case 'paid':
      return { kind: 'paid' };
    case 'void':
    case 'uncollectible':
      return { kind: 'dropped' };
  }
  const intent = paymentIntentOf(invoice);
  if (
    intent?.status === 'requires_payment_method' &&
    intent.last_payment_error
  ) {
    return {
      kind: 'refused',
      message: intent.last_payment_error.message || PAYMENT_REFUSED_FALLBACK,
    };
  }
  return { kind: 'waiting', payUrl: invoice.hosted_invoice_url ?? null };
}

/**
 * The prices an invoice's lines charge, read off each line's pricing: how a
 * failed invoice is told to carry Bought Server lines (#1397), each of
 * which is sold at a price of its own.
 */
export function invoicePriceIds(invoice: Stripe.Invoice): string[] {
  const ids: string[] = [];
  for (const line of invoice.lines?.data ?? []) {
    const id = idOf(line.pricing?.price_details?.price);
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * The invoice a Bought Server's charge made, found among the customer's
 * invoices (newest first, as Stripe lists them) when its id was never stored:
 * a restart, or an answer lost, between the charge and the write. A charge is
 * told by the prices it adds (each line is sold at a price of its own, made
 * for that sale) or, for an invoice of its own (the Free trial's), by the
 * Bought Server id it carries. Null when none is there: nothing was charged.
 */
export function invoiceCharging(
  invoices: readonly Stripe.Invoice[],
  boughtServerId: string,
  priceIds: readonly string[],
): Stripe.Invoice | null {
  return (
    invoices.find(
      (invoice) =>
        invoice.metadata?.boughtServerId === boughtServerId ||
        invoicePriceIds(invoice).some((id) => priceIds.includes(id)),
    ) ?? null
  );
}

/** The id an expandable field names. */
export function idOf(
  field: string | { id: string } | null | undefined,
): string | null {
  if (!field) return null;
  return typeof field === 'string' ? field : field.id;
}
