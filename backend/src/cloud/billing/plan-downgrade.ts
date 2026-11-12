import type Stripe from 'stripe';

/**
 * Business → Starter, outside a trial (ADR-0054): the move waits for
 * the end of the paid month, so the Organization keeps what it paid for.
 *
 * The wait is a Stripe subscription schedule. `subscriptionSchedules.create`
 * with `from_subscription` takes the subscription over as it is — one phase,
 * its current items, to the end of the paid month — and the downgrade then
 * rewrites the phases to that phase followed by a Starter phase carrying the
 * same Add-on item. Nothing is prorated and nothing is charged now; Stripe
 * enters the Starter phase at the renewal, and `customer.subscription.updated`
 * reports it. The schedule is released then (`end_behavior: 'release'` would
 * do it a month later), so the subscription carries on as a plain Starter one.
 *
 * While the schedule waits, an Add-on change has to go to both phases: a plain
 * subscription update would change this month and leave the Starter phase
 * with the old count. "Keep Business" releases the schedule, which leaves the
 * subscription as it is now.
 *
 * Bought Server lines (ADR-0071) are every other item: the Starter phase
 * carries them as this month does. A line added, removed or repriced while
 * the schedule waits is a plain subscription update (it needs
 * `pending_if_incomplete`, which a schedule has not), so the webhook's
 * `customer.subscription.updated` then writes the subscription's lines onto
 * every phase still to run (`scheduleFollowingSubscription`).
 *
 * Pure functions over Stripe's shapes; BillingService calls Stripe with them.
 * During a free trial the downgrade is an immediate swap instead.
 */

/** The Starter phase's length: one month, after which the schedule is done. */
const STARTER_PHASE: Stripe.SubscriptionScheduleUpdateParams.Phase.Duration = {
  interval: 'month',
  interval_count: 1,
};

/** The pending move, as `GET /billing/subscription` reports it. */
export interface ScheduledMove {
  scheduledPlan: 'starter';
  /** When it takes effect: the end of the paid month. */
  scheduledAt: Date;
}

/** The price ids the downgrade reads and writes. */
export interface DowngradePrices {
  starterPriceId: string;
  businessPriceId: string;
  addOnPriceId: string;
}

/** An item the subscription holds, by price id. */
export interface HeldItem {
  priceId: string;
  quantity?: number;
}

/** A phase item as `subscriptionSchedules.update` takes it. */
type PhaseItem = Stripe.SubscriptionScheduleUpdateParams.Phase.Item;

/** A price reference's id, whether Stripe sent it expanded or not. */
function priceIdOf(price: string | { id: string }): string {
  return typeof price === 'string' ? price : price.id;
}

/** A phase's items, as an update sends them back: price and quantity. */
function itemsOf(phase: Stripe.SubscriptionSchedule.Phase): PhaseItem[] {
  return phase.items.map((item) => ({
    price: priceIdOf(item.price),
    ...(item.quantity === undefined ? {} : { quantity: item.quantity }),
  }));
}

/** `items` with the Add-on item at `addOns`: added, changed, or dropped at 0. */
function withAddOnQuantity(
  items: PhaseItem[],
  addOnPriceId: string,
  addOns: number,
): PhaseItem[] {
  const others = items.filter((item) => item.price !== addOnPriceId);
  return addOns > 0
    ? [...others, { price: addOnPriceId, quantity: addOns }]
    : others;
}

/** Whether `price` is one of the plans' or the Add-on's, not a Bought Server line's. */
function isPlanPrice(price: string, prices: DowngradePrices): boolean {
  return (
    price === prices.starterPriceId ||
    price === prices.businessPriceId ||
    price === prices.addOnPriceId
  );
}

/** The phase a schedule made from a subscription starts with. */
function firstPhaseOf(
  schedule: Stripe.SubscriptionSchedule,
): Stripe.SubscriptionSchedule.Phase {
  const [first] = schedule.phases;
  if (!first) {
    throw new Error(`Subscription schedule ${schedule.id} has no phases`);
  }
  return first;
}

/**
 * The update that turns a schedule just made from the subscription into the
 * downgrade: this month as it is, then Starter with `addOns` Add-ons. No
 * proration anywhere: the current phase is unchanged, and the move happens at
 * the renewal.
 */
export function downgradeScheduleUpdate(
  schedule: Stripe.SubscriptionSchedule,
  prices: DowngradePrices,
  addOns: number,
): Stripe.SubscriptionScheduleUpdateParams {
  const current = firstPhaseOf(schedule);
  return {
    end_behavior: 'release',
    proration_behavior: 'none',
    phases: [
      {
        items: itemsOf(current),
        start_date: current.start_date,
        end_date: current.end_date,
      },
      {
        items: withAddOnQuantity(
          [
            { price: prices.starterPriceId, quantity: 1 },
            // The Bought Server lines go on into Starter as they are.
            ...itemsOf(current).filter(
              (item) => !isPlanPrice(item.price as string, prices),
            ),
          ],
          prices.addOnPriceId,
          addOns,
        ),
        duration: STARTER_PHASE,
        proration_behavior: 'none',
      },
    ],
  };
}

/**
 * The update that sets the Add-on count on every phase still to run — this
 * month's and the Starter one — keeping each phase's dates. The change to this
 * month is prorated, as a plain Add-on change is.
 */
export function scheduledAddOnsUpdate(
  schedule: Stripe.SubscriptionSchedule,
  addOnPriceId: string,
  addOns: number,
  now: number,
): Stripe.SubscriptionScheduleUpdateParams {
  const running = schedule.phases.filter((phase) => phase.end_date > now);
  return {
    proration_behavior: 'create_prorations',
    phases: running.map((phase, index) => ({
      items: withAddOnQuantity(itemsOf(phase), addOnPriceId, addOns),
      // The first phase sent must say when it started; later ones follow on.
      ...(index === 0 ? { start_date: phase.start_date } : {}),
      end_date: phase.end_date,
      ...(phase.proration_behavior
        ? { proration_behavior: phase.proration_behavior }
        : {}),
    })),
  };
}

/** A phase's items in one comparable form: sorted, quantity 1 when left out. */
function canonical(items: PhaseItem[]): string {
  return items
    .map((item) => `${String(item.price)}x${item.quantity ?? 1}`)
    .sort()
    .join(',');
}

/**
 * The update that makes a waiting downgrade's phases carry the Bought Server
 * lines the subscription holds now, or null when they already do. The phase
 * running now is written as the subscription holds it (the subscription's own
 * update already charged or credited it, so nothing more is prorated); a
 * later phase keeps its plan and Add-on items and takes the subscription's
 * lines in place of its own.
 */
export function scheduleFollowingSubscription(
  schedule: Stripe.SubscriptionSchedule,
  held: HeldItem[],
  prices: DowngradePrices,
  now: number,
): Stripe.SubscriptionScheduleUpdateParams | null {
  const running = schedule.phases.filter((phase) => phase.end_date > now);
  if (running.length === 0) return null;
  const heldItems: PhaseItem[] = held.map((item) => ({
    price: item.priceId,
    ...(item.quantity === undefined ? {} : { quantity: item.quantity }),
  }));
  const lines = heldItems.filter(
    (item) => !isPlanPrice(item.price as string, prices),
  );

  const wanted = running.map((phase) =>
    phase.start_date <= now
      ? heldItems
      : [
          ...itemsOf(phase).filter((item) =>
            isPlanPrice(item.price as string, prices),
          ),
          ...lines,
        ],
  );
  const unchanged = running.every(
    (phase, index) => canonical(itemsOf(phase)) === canonical(wanted[index]),
  );
  if (unchanged) return null;

  return {
    proration_behavior: 'none',
    phases: running.map((phase, index) => ({
      items: wanted[index],
      // The first phase sent must say when it started; later ones follow on.
      ...(index === 0 ? { start_date: phase.start_date } : {}),
      end_date: phase.end_date,
      ...(phase.proration_behavior
        ? { proration_behavior: phase.proration_behavior }
        : {}),
    })),
  };
}

/** When the downgrade takes effect: the end of the schedule's first phase. */
export function downgradeDateOf(schedule: Stripe.SubscriptionSchedule): Date {
  return new Date(firstPhaseOf(schedule).end_date * 1000);
}

/** The pending move a stored schedule id and date describe, if any. */
export function scheduledMoveOf(
  row: { stripeScheduleId: string | null; downgradeAt: Date | null } | null,
): ScheduledMove | null {
  if (!row?.stripeScheduleId || !row.downgradeAt) return null;
  return { scheduledPlan: 'starter', scheduledAt: row.downgradeAt };
}
