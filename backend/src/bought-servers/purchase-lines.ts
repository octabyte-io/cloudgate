import type Stripe from 'stripe';
import type {
  BoughtServerChangeLine,
  BoughtServerLineKind,
} from './bought-server.schema';

/**
 * How a Bought Server's lines reach Stripe (ADR-0071), pure: each line is a
 * price made at the sale under one of three **fixed Products**, so the
 * invoice names what it charges for and no price list is kept by hand.
 */

/** The currency every Bought Server is sold in (ADR-0071: customers pay in USD). */
export const BOUGHT_SERVER_CURRENCY = 'usd';

/**
 * The fixed Products, by line kind. Their ids are fixed, so each Stripe
 * account holds each once; their names are what the customer's invoice
 * says, so they never name the provider.
 */
export const BOUGHT_SERVER_PRODUCTS: Record<
  BoughtServerLineKind,
  { id: string; name: string }
> = {
  server: { id: 'cloudgate_bought_server', name: 'Server' },
  backups: { id: 'cloudgate_bought_server_backups', name: 'Server backups' },
  storage: {
    id: 'cloudgate_bought_server_storage',
    name: 'Server extra storage',
  },
};

/** One line to sell: what it is and its monthly price in US cents. */
export interface LineToSell {
  kind: BoughtServerLineKind;
  monthlyCents: number;
}

/** The price one line is sold at, made under its kind's Product. */
export function linePriceParams(
  boughtServerId: string,
  line: LineToSell,
): Stripe.PriceCreateParams {
  return {
    currency: BOUGHT_SERVER_CURRENCY,
    unit_amount: line.monthlyCents,
    recurring: { interval: 'month' },
    product: BOUGHT_SERVER_PRODUCTS[line.kind].id,
    metadata: { boughtServerId, kind: line.kind },
  };
}

/**
 * The purchase: the new lines added to the subscription and charged at once
 * for the rest of the month, as of the proration time the Today box showed.
 * `pending_if_incomplete`: Stripe adds them only once that invoice is paid,
 * so a refused card leaves the subscription as it was.
 */
export function purchaseUpdateParams(
  priceIds: readonly string[],
  prorationDate: number,
  addOn: AddOnChange | null = null,
): Stripe.SubscriptionUpdateParams {
  return {
    items: [
      ...priceIds.map((price) => ({ price, quantity: 1 })),
      ...(addOn ? [addOn] : []),
    ],
    proration_behavior: 'always_invoice',
    proration_date: prorationDate,
    payment_behavior: 'pending_if_incomplete',
  };
}

/**
 * A reduction: the lines taken off the subscription, with the unused part
 * of the month prorated as a credit on the next invoice. ADR-0071: a
 * reduction is never cash back, so nothing is invoiced now. With `credited`
 * false (the clock's automatic deletion, for a payment that failed, a
 * suspension or a lapse) nothing is prorated: the month is not given back.
 */
export function removalUpdateParams(
  itemIds: readonly string[],
  credited = true,
): Stripe.SubscriptionUpdateParams {
  return {
    items: itemIds.map((id) => ({ id, deleted: true })),
    proration_behavior: credited ? 'create_prorations' : 'none',
  };
}

/**
 * The invoice the purchase would make today, previewed with the same lines
 * as inline prices, so nothing is made at Stripe for a page view.
 */
export function todayPreviewParams(
  current: Stripe.Subscription,
  lines: readonly LineToSell[],
  prorationDate: number,
  addOn: AddOnChange | null = null,
): Stripe.InvoiceCreatePreviewParams {
  const customer =
    typeof current.customer === 'string'
      ? current.customer
      : current.customer.id;
  return {
    customer,
    subscription: current.id,
    subscription_details: {
      items: [
        ...lines.map((line) => ({
          price_data: {
            currency: BOUGHT_SERVER_CURRENCY,
            product: BOUGHT_SERVER_PRODUCTS[line.kind].id,
            unit_amount: line.monthlyCents,
            recurring: { interval: 'month' as const },
          },
          quantity: 1,
        })),
        // The Add-on, when the count is full: the same change Buy makes.
        ...(addOn ? [addOn] : []),
      ],
      proration_behavior: 'always_invoice',
      proration_date: prorationDate,
    },
  };
}

/** When the subscription's month ends: the end of the Today box's dates. */
export function renewsAtOf(current: Stripe.Subscription): number | null {
  const ends = current.items.data.map((item) => item.current_period_end);
  return ends.length > 0 ? Math.min(...ends) : null;
}

/** The subscription item carrying each price, by price id. */
export function itemsByPrice(
  current: Stripe.Subscription,
  priceIds: readonly string[],
): Map<string, string> {
  const found = new Map<string, string>();
  for (const item of current.items.data) {
    if (priceIds.includes(item.price.id)) found.set(item.price.id, item.id);
  }
  return found;
}

/** A line the subscription holds now, as its row stores it. */
export interface HeldLine {
  kind: BoughtServerLineKind;
  stripePriceId: string;
  stripeSubscriptionItemId: string | null;
}

function itemOf(
  held: readonly HeldLine[],
  kind: BoughtServerLineKind,
): string | null {
  return (
    held.find((line) => line.kind === kind)?.stripeSubscriptionItemId ?? null
  );
}

/**
 * A change's lines made on the subscription (ADR-0071): a new line added, a
 * line already held moved to its new price, a line the change ends deleted.
 * One that costs more is charged at once, as a purchase is
 * (`always_invoice`, `pending_if_incomplete`, so a refused card leaves the
 * subscription as it was); one that costs less is credited on the next
 * invoice.
 */
export function changeUpdateParams(
  held: readonly HeldLine[],
  lines: readonly BoughtServerChangeLine[],
  charged: boolean,
): Stripe.SubscriptionUpdateParams {
  const items = lines.flatMap(
    (line): Stripe.SubscriptionUpdateParams.Item[] => {
      const item = itemOf(held, line.kind);
      if (line.stripePriceId === null) {
        return item ? [{ id: item, deleted: true }] : [];
      }
      return item
        ? [{ id: item, price: line.stripePriceId, quantity: 1 }]
        : [{ price: line.stripePriceId, quantity: 1 }];
    },
  );
  return charged
    ? {
        items,
        proration_behavior: 'always_invoice',
        payment_behavior: 'pending_if_incomplete',
      }
    : { items, proration_behavior: 'create_prorations' };
}

/**
 * The subscription put back as it was before a paid change, once its
 * payment is refunded in full: a line the change added is deleted, a line it
 * moved goes back to its old price. Nothing is prorated, since the refund
 * already gave back every cent the change charged.
 */
export function restoreUpdateParams(
  held: readonly HeldLine[],
  lines: readonly BoughtServerChangeLine[],
  current: Stripe.Subscription,
): Stripe.SubscriptionUpdateParams {
  const made = itemsByPrice(
    current,
    lines.flatMap((line) => (line.stripePriceId ? [line.stripePriceId] : [])),
  );
  const items = lines.flatMap(
    (line): Stripe.SubscriptionUpdateParams.Item[] => {
      const before = held.find((entry) => entry.kind === line.kind);
      const now = line.stripePriceId ? made.get(line.stripePriceId) : undefined;
      if (!before) return now ? [{ id: now, deleted: true }] : [];
      if (now) return [{ id: now, price: before.stripePriceId, quantity: 1 }];
      // Ended by the change and gone from the subscription: back again.
      const stillHeld = current.items.data.some(
        (item) => item.price.id === before.stripePriceId,
      );
      return line.stripePriceId === null && !stillHeld
        ? [{ price: before.stripePriceId, quantity: 1 }]
        : [];
    },
  );
  return { items, proration_behavior: 'none' };
}

/**
 * One more Add-on on the subscription, for a purchase made while the Server
 * count is full (ADR-0071: the Add-on comes in the same step): the Add-on
 * item's quantity raised by one, or a new Add-on item.
 */
export type AddOnChange =
  { id: string; quantity: number } | { price: string; quantity: 1 };

/** {@link AddOnChange} for this subscription and the instance's Add-on price. */
export function oneMoreAddOn(
  current: Stripe.Subscription,
  addOnPriceId: string,
): AddOnChange {
  const item = current.items.data.find(
    (candidate) => candidate.price.id === addOnPriceId,
  );
  return item
    ? { id: item.id, quantity: (item.quantity ?? 0) + 1 }
    : { price: addOnPriceId, quantity: 1 };
}

const DAY_SECONDS = 24 * 60 * 60;

/** The month a Free-trial charge is counted in: the trial's own 30 days. */
const TRIAL_MONTH_SECONDS = 30 * DAY_SECONDS;

/**
 * What a line bought during the Free trial is charged on its own invoice,
 * from `from` to the trial's end `to` (Unix seconds): its monthly price for
 * that share of a 30-day month, rounded to the cent and never more than a
 * month. The amendment to ADR-0054: the trial covers Starter, not the
 * Server.
 */
export function trialChargeCents(
  monthlyCents: number,
  from: number,
  to: number,
): number {
  const seconds = Math.max(0, to - from);
  return Math.min(
    monthlyCents,
    Math.round((monthlyCents * seconds) / TRIAL_MONTH_SECONDS),
  );
}

/** `days` after `from`, in Unix seconds. */
export function daysAfter(from: number, days: number): number {
  return from + days * DAY_SECONDS;
}

/**
 * The invoice a purchase made during the Free trial is charged on: its own,
 * outside the subscription, charged at once to the subscription's card,
 * with 3D Secure asked for when this is the first Server.
 */
export function trialInvoiceParams(input: {
  customer: string;
  boughtServerId: string;
  paymentMethod: string | null;
  threeDSecure: boolean;
}): Stripe.InvoiceCreateParams {
  return {
    customer: input.customer,
    currency: BOUGHT_SERVER_CURRENCY,
    collection_method: 'charge_automatically',
    auto_advance: false,
    pending_invoice_items_behavior: 'exclude',
    description: 'Server, from today to the end of the Free trial',
    metadata: { boughtServerId: input.boughtServerId },
    ...(input.paymentMethod
      ? { default_payment_method: input.paymentMethod }
      : {}),
    ...(input.threeDSecure
      ? {
          payment_settings: {
            payment_method_options: {
              card: { request_three_d_secure: 'any' as const },
            },
          },
        }
      : {}),
  };
}

/** One line of that invoice: the line's price from `from` to the trial's end `to`. */
export function trialInvoiceItemParams(input: {
  customer: string;
  invoice: string;
  boughtServerId: string;
  line: LineToSell;
  from: number;
  to: number;
}): Stripe.InvoiceItemCreateParams {
  return {
    customer: input.customer,
    invoice: input.invoice,
    currency: BOUGHT_SERVER_CURRENCY,
    price_data: {
      currency: BOUGHT_SERVER_CURRENCY,
      product: BOUGHT_SERVER_PRODUCTS[input.line.kind].id,
      unit_amount: trialChargeCents(
        input.line.monthlyCents,
        input.from,
        input.to,
      ),
    },
    quantity: 1,
    period: { start: input.from, end: input.to },
    metadata: { boughtServerId: input.boughtServerId, kind: input.line.kind },
  };
}

/**
 * What is left unused, at `now` (seconds), of a Free-trial invoice's lines:
 * each line's amount for the part of its period still to come. What Delete
 * credits for a Server bought during the trial, as a proration credits one
 * on the subscription.
 */
export function unusedTrialCents(invoice: Stripe.Invoice, now: number): number {
  let unused = 0;
  for (const line of invoice.lines?.data ?? []) {
    const { start, end } = line.period ?? { start: 0, end: 0 };
    if (end <= start || now >= end) continue;
    const left = Math.min(1, (end - Math.max(now, start)) / (end - start));
    unused += Math.round((line.amount ?? 0) * left);
  }
  return unused;
}

/**
 * Lines bought during the Free trial joining the subscription once it is
 * over: charged at once for the month that has just started, so the Server
 * stays paid in advance (ADR-0071).
 */
export function joinParams(
  priceIds: readonly string[],
): Stripe.SubscriptionUpdateParams {
  return {
    items: priceIds.map((price) => ({ price, quantity: 1 })),
    proration_behavior: 'always_invoice',
  };
}

/** A subscription's 3D Secure setting, as an update sets it. */
export type ThreeDSecure = 'any' | 'automatic' | 'challenge';

/**
 * The 3D Secure setting a subscription's next invoice is paid under: `any`
 * asks for it on the payment that buys the first Server, and the setting the
 * subscription had is put back after (ADR-0071).
 */
export function threeDSecureParams(
  value: ThreeDSecure,
): Stripe.SubscriptionUpdateParams {
  return {
    payment_settings: {
      payment_method_options: { card: { request_three_d_secure: value } },
    },
  };
}

/** The 3D Secure setting a subscription has now. */
export function threeDSecureOf(current: Stripe.Subscription): ThreeDSecure {
  return (
    current.payment_settings?.payment_method_options?.card
      ?.request_three_d_secure ?? 'automatic'
  );
}
