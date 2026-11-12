import type Stripe from 'stripe';

/**
 * The Stripe event types the billing webhook handles — the one list. The
 * controller refuses any other type, `BillingWebhookService` keeps one handler
 * per entry (a `Record` over this type, so a type with no handler does not
 * compile), and the Stripe endpoint (Developers > Webhooks in the Stripe
 * Dashboard) must be subscribed to exactly these. Subscribed to fewer, a first checkout or
 * a lapse goes unseen; to more, Stripe gets a 400 for every extra event,
 * retries it for days and eventually disables the endpoint.
 *
 * `docs/deploy.md` lists them for whoever sets the endpoint up, held to this
 * list by `test/coding-standards/stripe-webhook-events-docs.spec.ts`, and the
 * Hosted instance warns on start about an endpoint that differs
 * (`StripeWebhookEndpointCheck`).
 */
export const HANDLED_EVENT_TYPES = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.deleted',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
  // A Bought Server purchase whose payment never came (ADR-0071): the
  // update it was made with expired, so the purchase is dropped.
  'customer.subscription.pending_update_expired',
  // A waiting downgrade's schedule ending, however it ends.
  'subscription_schedule.released',
  'subscription_schedule.completed',
  'subscription_schedule.canceled',
  'subscription_schedule.aborted',
  // A disputed payment of an Organization with Bought Servers emails the
  // Operators (ADR-0071).
  'charge.dispute.created',
] as const satisfies readonly Stripe.Event.Type[];

export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];

/** A verified event of one of the handled types. */
export type HandledEvent = Extract<Stripe.Event, { type: HandledEventType }>;

export function isHandledEvent(event: Stripe.Event): event is HandledEvent {
  return (HANDLED_EVENT_TYPES as readonly string[]).includes(event.type);
}
