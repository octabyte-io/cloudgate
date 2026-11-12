/**
 * The Hosted instance's one catalogue (ADR-0048, amended by ADR-0054):
 * the two monthly plans, Starter and Business, and the monthly Add-on both take,
 * and what is derived from them — the line items a checkout bills, what a
 * subscription's items say it bought, and the Server and Cloud Environment
 * allowance that buys.
 *
 * The ids are resolved from ConfigService into a `StripePriceCatalogue`, not
 * read off `process.env` at module load, so every derivation is a pure,
 * testable function over it.
 */

/**
 * The plans a self-serve Organization buys. Business adds the paid features
 * (SSO, SCIM, custom roles, forward auth); the counts are the same.
 */
export const PLAN_NAMES = ['starter', 'business'] as const;
export type PlanName = (typeof PLAN_NAMES)[number];

/** A plan's name as a sentence says it. */
export const PLAN_LABELS: Record<PlanName, string> = {
  starter: 'Starter',
  business: 'Business',
};

/**
 * Servers, and Cloud Environments, either plan includes before any Add-on.
 * Each Add-on raises both by one.
 */
export const HOSTED_PLAN_INCLUDES = 3;

/** The three Stripe price ids this instance sells, from the environment. */
export interface StripePriceCatalogue {
  /** STARTER_PLAN_PRICE_ID — the monthly Starter plan. */
  starterPriceId?: string;
  /** BUSINESS_PLAN_PRICE_ID — the monthly Business plan. */
  businessPriceId?: string;
  /** ADD_ON_PRICE_ID — one more Server and one more Cloud Environment. */
  addOnPriceId?: string;
}

/** The catalogue once all three of its prices are known to be set. */
export type CompleteCatalogue = Required<StripePriceCatalogue>;

/** A line item as Stripe's checkout/subscription APIs take it. */
export interface StripeLineItem {
  price: string;
  quantity: number;
}

/** The price id a plan is sold at, in a complete catalogue. */
export function planPriceId(prices: CompleteCatalogue, plan: PlanName): string {
  return plan === 'business' ? prices.businessPriceId : prices.starterPriceId;
}

/**
 * The settings a checkout needs and does not have, by name, in the order an
 * operator would set them. Blank counts as unset.
 */
export function missingPriceSettings(prices: StripePriceCatalogue): string[] {
  const missing: string[] = [];
  if (!prices.starterPriceId?.trim()) missing.push('STARTER_PLAN_PRICE_ID');
  if (!prices.businessPriceId?.trim()) missing.push('BUSINESS_PLAN_PRICE_ID');
  if (!prices.addOnPriceId?.trim()) missing.push('ADD_ON_PRICE_ID');
  return missing;
}

/**
 * What a checkout bills: the chosen plan once, and the Add-on by quantity.
 * With no Add-ons the Add-on line is left out, since Stripe refuses a zero
 * quantity.
 */
export function checkoutLineItems(
  prices: CompleteCatalogue,
  plan: PlanName,
  addOns: number,
): StripeLineItem[] {
  return [
    { price: planPriceId(prices, plan), quantity: 1 },
    ...(addOns > 0 ? [{ price: prices.addOnPriceId, quantity: addOns }] : []),
  ];
}

/** What a subscription's items bought, against this instance's catalogue. */
export interface PurchasedItems {
  /** The plan whose price one of the items is; null when none is. */
  plan: PlanName | null;
  /** The Add-on item's quantity; 0 when there is none. */
  addOns: number;
}

/**
 * Reads a subscription's items: which plan it carries, and how many Add-ons. A
 * price this instance does not sell counts for nothing. Should a subscription
 * ever carry both plan prices, it holds Business: it is paying for it.
 */
export function purchasedItems(
  prices: StripePriceCatalogue,
  items: Array<{ priceId: string; quantity: number | null | undefined }>,
): PurchasedItems {
  const carries = (priceId: string | undefined): boolean =>
    !!priceId && items.some((item) => item.priceId === priceId);
  const plan: PlanName | null = carries(prices.businessPriceId)
    ? 'business'
    : carries(prices.starterPriceId)
      ? 'starter'
      : null;
  const addOns = items
    .filter(
      (item) => !!prices.addOnPriceId && item.priceId === prices.addOnPriceId,
    )
    .reduce((sum, item) => sum + (item.quantity ?? 0), 0);
  return { plan, addOns };
}

/**
 * The subscription an invoice belongs to.
 *
 * The 2025-03-31 ("basil") API removed `invoice.subscription` in favour of
 * `invoice.parent.subscription_details.subscription`. The
 * current SDK's types only know the new location; the legacy field is still
 * read as a fallback, because an endpoint pinned to an older API version — or an
 * event replayed from before the migration — still sends it.
 */
export function subscriptionIdOf(invoice: {
  parent?: { subscription_details?: { subscription?: unknown } | null } | null;
  subscription?: unknown;
}): string | null {
  const current = invoice.parent?.subscription_details?.subscription;
  const legacy = invoice.subscription;
  for (const candidate of [current, legacy]) {
    if (typeof candidate === 'string') return candidate;
    // Stripe sends an expanded object when the field was expanded.
    if (
      candidate &&
      typeof candidate === 'object' &&
      typeof (candidate as { id?: unknown }).id === 'string'
    ) {
      return (candidate as { id: string }).id;
    }
  }
  return null;
}

/**
 * When a subscription is set to end, or null while it renews. Stripe
 * puts the moment on `cancel_at`, which it also fills for a cancel at the end
 * of the period; should an event carry only `cancel_at_period_end`, the end
 * is the trial's while trialing and the plan item's period otherwise.
 */
export function cancelAtOf(stripeSubscription: {
  status: string;
  cancel_at?: number | null;
  cancel_at_period_end?: boolean | null;
  trial_end?: number | null;
  items?: { data?: Array<{ current_period_end?: number | null }> } | null;
}): Date | null {
  const seconds =
    stripeSubscription.cancel_at ??
    (stripeSubscription.cancel_at_period_end
      ? stripeSubscription.status === 'trialing'
        ? stripeSubscription.trial_end
        : stripeSubscription.items?.data?.[0]?.current_period_end
      : null);
  return typeof seconds === 'number' ? new Date(seconds * 1000) : null;
}
