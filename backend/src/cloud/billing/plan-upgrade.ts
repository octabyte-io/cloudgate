import type Stripe from 'stripe';

/**
 * Starter → Business, outside a trial (ADR-0054): the switch takes
 * effect at once and is charged today, prorated over what is left of the paid
 * month. The price on the subscription's existing plan item is swapped, so the
 * Add-on item, the billing day and the subscription itself stay as they are.
 *
 * The amount the confirm shows is Stripe's own, read from an invoice preview
 * of exactly the change the upgrade makes, at the same proration time: the
 * preview answers `prorationDate`, the upgrade is sent with it, and Stripe
 * prorates the real change as of that second. So what was shown is what is
 * charged. A preview older than {@link PRORATION_DATE_MAX_AGE_SECONDS} is
 * refused rather than honoured, since it would charge for a month that has
 * since got shorter.
 *
 * Pure functions over Stripe's shapes; BillingService calls Stripe with them.
 * The downgrade goes at the end of the month through a subscription
 * schedule, and has nothing here.
 */

/** How long a preview's proration time is honoured, in seconds. */
export const PRORATION_DATE_MAX_AGE_SECONDS = 60 * 60;

const DAY_SECONDS = 24 * 60 * 60;

/** What `GET /billing/upgrade-preview` answers. Amounts in minor units. */
export interface UpgradePreviewView {
  /** Charged today for the rest of this month on Business, less Starter's unused part. */
  today: number;
  /** Every month after, on Business with the same Add-ons. */
  monthlyAfter: number;
  /** Stripe's lowercase ISO code. */
  currency: string;
  /** Whole days left of the paid month, today counted. */
  daysLeft: number;
  /** When the month ends and the first full Business month is charged, Unix seconds. */
  renewsAt: number;
  /** The proration time the amount was worked out at; the upgrade sends it back. */
  prorationDate: number;
}

/** The subscription item that carries `priceId`, if any. */
export function itemCarrying(
  current: Stripe.Subscription,
  priceId: string,
): Stripe.SubscriptionItem | undefined {
  return current.items.data.find((item) => item.price.id === priceId);
}

/** The one item change an upgrade makes: the plan item's price, swapped. */
export function upgradeItems(
  planItem: Stripe.SubscriptionItem,
  businessPriceId: string,
): Stripe.SubscriptionUpdateParams.Item[] {
  return [{ id: planItem.id, price: businessPriceId }];
}

/**
 * The two previews behind the confirm: the invoice the upgrade makes today
 * (`always_invoice`, so it holds only the prorations), and the next month's
 * renewal with the swap in place and nothing prorated.
 */
export function upgradePreviewParams(
  current: Stripe.Subscription,
  planItem: Stripe.SubscriptionItem,
  businessPriceId: string,
  prorationDate: number,
): {
  today: Stripe.InvoiceCreatePreviewParams;
  next: Stripe.InvoiceCreatePreviewParams;
} {
  const customer =
    typeof current.customer === 'string'
      ? current.customer
      : current.customer.id;
  const items = upgradeItems(planItem, businessPriceId);
  return {
    today: {
      customer,
      subscription: current.id,
      subscription_details: {
        items,
        proration_behavior: 'always_invoice',
        proration_date: prorationDate,
      },
    },
    next: {
      customer,
      subscription: current.id,
      subscription_details: { items, proration_behavior: 'none' },
    },
  };
}

/** Whole days from `now` to `periodEnd`, a part day counted, never below 0. */
export function daysLeftOf(periodEnd: number, now: number): number {
  return Math.max(0, Math.ceil((periodEnd - now) / DAY_SECONDS));
}

/** The confirm's figures, from the two previews. */
export function upgradePreviewView(
  today: Stripe.Invoice,
  next: Stripe.Invoice,
  planItem: Stripe.SubscriptionItem,
  prorationDate: number,
): UpgradePreviewView {
  return {
    today: today.amount_due,
    monthlyAfter: next.total,
    currency: today.currency,
    daysLeft: daysLeftOf(planItem.current_period_end, prorationDate),
    renewsAt: planItem.current_period_end,
    prorationDate,
  };
}

/**
 * Whether a proration time sent back with an upgrade can be honoured: not in
 * the future, and no older than {@link PRORATION_DATE_MAX_AGE_SECONDS}.
 */
export function isFreshProrationDate(
  prorationDate: number,
  now: number,
): boolean {
  return (
    prorationDate <= now &&
    now - prorationDate <= PRORATION_DATE_MAX_AGE_SECONDS
  );
}
