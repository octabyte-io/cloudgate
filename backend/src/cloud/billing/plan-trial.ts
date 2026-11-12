import type Stripe from 'stripe';

/**
 * The Billing page during a free trial (ADR-0054): where the trial
 * stands, switching plans in it, and cancelling it.
 *
 * - **Switching** Starter ↔ Business during a trial takes effect at once, both
 *   ways, and charges nothing: the plan item's price is swapped with
 *   `proration_behavior: 'none'`, and `trial_end` is left out of the update so
 *   the trial clock keeps running. A downgrade is that same swap, never a
 *   subscription schedule: there is no paid month to keep. The first bill, on
 *   the day the trial ends, is for what is held then.
 * - **Cancelling** sets `cancel_at_period_end`; a trialing subscription's
 *   period ends with its trial, so nothing is ever charged and the plan ends
 *   on the trial's last day (what follows then is the trial end's). "Keep <plan>"
 *   clears it again.
 * - **Where it stands** is read live from Stripe while the page is open: the
 *   cancel, the first charge (Stripe's preview of the invoice the trial's end
 *   makes), and the card it goes to, or none — "Add a card at Stripe".
 *
 * Pure functions over Stripe's shapes; BillingService calls Stripe with them.
 */

/** The card (or other payment method) the first charge goes to. */
export interface PaymentMethodSummary {
  /** `visa`, `mastercard`, …, or the method's type when it is not a card. */
  brand: string;
  /** A card's last four digits; null for another kind of method. */
  last4: string | null;
}

/** The first charge, when the trial ends. Amount in minor units. */
export interface FirstChargeView {
  amount: number;
  currency: string;
  /** When it is charged: the trial's end, ISO 8601. */
  at: string;
}

/** Where a free trial stands, as `GET /billing/subscription` reports it. */
export interface TrialView {
  /** When the trial ends, ISO 8601. */
  endsAt: string;
  /** "Cancel trial" was chosen: the plan ends with the trial, unpaid. */
  cancelled: boolean;
  /**
   * The first charge, from Stripe's preview; null when cancelled (nothing is
   * charged), or when Stripe could not be asked.
   */
  firstCharge: FirstChargeView | null;
  /** The payment method on file, when Stripe says there is one. */
  paymentMethod: PaymentMethodSummary | null;
  /**
   * Stripe answered and there is no payment method on file — the card was
   * removed — so the page says "Add a card at Stripe". False when Stripe
   * could not be asked, rather than claiming a card is missing.
   */
  paymentMethodMissing: boolean;
}

/** A trial's view when Stripe could not be asked: the stored end date only. */
export function storedTrialView(endsAt: Date): TrialView {
  return {
    endsAt: endsAt.toISOString(),
    cancelled: false,
    firstCharge: null,
    paymentMethod: null,
    paymentMethodMissing: false,
  };
}

/**
 * The one update a plan switch during a trial makes: the plan item's price
 * swapped, nothing prorated, and no `trial_end`, so the trial keeps its end.
 */
export function trialSwitchUpdate(
  planItem: Stripe.SubscriptionItem,
  priceId: string,
): Stripe.SubscriptionUpdateParams {
  return {
    items: [{ id: planItem.id, price: priceId }],
    proration_behavior: 'none',
  };
}

/** Whether the subscription is set to end rather than renew. */
export function isCancelled(current: Stripe.Subscription): boolean {
  return current.cancel_at_period_end || current.cancel_at != null;
}

/** The customer's id, whether Stripe sent it expanded or not. */
export function customerIdOf(current: Stripe.Subscription): string {
  return typeof current.customer === 'string'
    ? current.customer
    : current.customer.id;
}

/** The preview of the invoice the subscription makes next: the first charge. */
export function firstChargePreviewParams(
  current: Stripe.Subscription,
): Stripe.InvoiceCreatePreviewParams {
  return { customer: customerIdOf(current), subscription: current.id };
}

type MaybePaymentMethod = string | Stripe.PaymentMethod | null | undefined;

/** A payment method as the page names it; null when there is none. */
export function paymentMethodSummaryOf(
  method: MaybePaymentMethod,
): PaymentMethodSummary | null {
  if (!method) return null;
  // Not expanded: there is one, but nothing to name it by.
  if (typeof method === 'string') return { brand: 'card', last4: null };
  if (method.card) {
    return { brand: method.card.brand, last4: method.card.last4 };
  }
  return { brand: method.type, last4: null };
}

/**
 * The payment method the first charge goes to: the subscription's own
 * default, else the customer's invoice default — Stripe's own order.
 */
export function paymentMethodOf(
  current: Stripe.Subscription,
  customer: Stripe.Customer | Stripe.DeletedCustomer | null,
): MaybePaymentMethod {
  if (current.default_payment_method) return current.default_payment_method;
  if (!customer || customer.deleted) return null;
  return customer.invoice_settings?.default_payment_method ?? null;
}

/**
 * Whether the trial's end will charge anything: not cancelled ("Cancel
 * trial", or a cancel made at Stripe), and a payment method on file for the
 * charge. A trial that will not charge ends with "No plan. Nothing is
 * charged." (stories 21, 22), so "your trial ends in 7 days", which quotes the
 * amount, is not for it.
 */
export function trialWillCharge(
  current: Stripe.Subscription,
  method: MaybePaymentMethod,
): boolean {
  return !isCancelled(current) && !!method;
}

/** The trial's view from what Stripe answered. */
export function trialView(
  endsAt: Date,
  current: Stripe.Subscription,
  method: MaybePaymentMethod,
  upcoming: Stripe.Invoice | null,
): TrialView {
  const cancelled = isCancelled(current);
  const paymentMethod = paymentMethodSummaryOf(method);
  return {
    endsAt: endsAt.toISOString(),
    cancelled,
    firstCharge:
      !cancelled && upcoming
        ? {
            amount: upcoming.amount_due,
            currency: upcoming.currency,
            at: endsAt.toISOString(),
          }
        : null,
    paymentMethod,
    paymentMethodMissing: paymentMethod === null,
  };
}
