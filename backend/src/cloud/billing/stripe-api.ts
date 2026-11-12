import type Stripe from 'stripe';

/**
 * Stripe, as a port: a boundary rather than an inline `new Stripe(...)`, so
 * tests never reach the network (the LICENSE_API / FETCH_CLIENT precedent).
 *
 * Stripe's own types are used in the signatures rather than a translated set of
 * domain types: the package is a dependency either way, and a pass-through port
 * keeps `StripeApiClient` free of adaptation logic that could drift from what
 * Stripe actually sends.
 */

export const STRIPE_API = Symbol('STRIPE_API');

export interface StripeApi {
  /** `prices.retrieve(id, { expand: ['product'] })`. */
  retrievePrice(priceId: string): Promise<Stripe.Price>;
  /**
   * `subscriptions.retrieve(id, { expand: ['items.data.price',
   * 'default_payment_method'] })` — the card expanded, so a trial's Billing
   * page names it.
   */
  retrieveSubscription(subscriptionId: string): Promise<Stripe.Subscription>;
  /**
   * `customers.retrieve(id, { expand:
   * ['invoice_settings.default_payment_method'] })`. Resolves to a deleted
   * stub when the customer was removed at Stripe.
   */
  retrieveCustomer(
    customerId: string,
  ): Promise<Stripe.Customer | Stripe.DeletedCustomer>;
  createCheckoutSession(
    params: Stripe.Checkout.SessionCreateParams,
  ): Promise<Stripe.Checkout.Session>;
  createBillingPortalSession(
    params: Stripe.BillingPortal.SessionCreateParams,
  ): Promise<Stripe.BillingPortal.Session>;
  /** `billingPortal.configurations.list({ active: true, limit: 100 })`. */
  listBillingPortalConfigurations(): Promise<
    Stripe.BillingPortal.Configuration[]
  >;
  createBillingPortalConfiguration(
    params: Stripe.BillingPortal.ConfigurationCreateParams,
  ): Promise<Stripe.BillingPortal.Configuration>;
  updateSubscription(
    subscriptionId: string,
    params: Stripe.SubscriptionUpdateParams,
  ): Promise<Stripe.Subscription>;
  listInvoices(customerId: string): Promise<Stripe.Invoice[]>;
  /**
   * `invoices.createPreview(params)` — the invoice a subscription change would
   * make, without making it: what a plan switch charges today, and what the
   * month after costs.
   */
  previewInvoice(
    params: Stripe.InvoiceCreatePreviewParams,
  ): Promise<Stripe.Invoice>;
  /**
   * `subscriptionSchedules.create({ from_subscription })` — a schedule that
   * takes over the subscription as it is: one phase, its current items, to the
   * end of the paid month. A downgrade then adds the Starter phase.
   */
  createSubscriptionSchedule(
    params: Stripe.SubscriptionScheduleCreateParams,
  ): Promise<Stripe.SubscriptionSchedule>;
  retrieveSubscriptionSchedule(
    scheduleId: string,
  ): Promise<Stripe.SubscriptionSchedule>;
  /** `subscriptionSchedules.update(id, params)` — its phases, rewritten. */
  updateSubscriptionSchedule(
    scheduleId: string,
    params: Stripe.SubscriptionScheduleUpdateParams,
  ): Promise<Stripe.SubscriptionSchedule>;
  /**
   * `subscriptionSchedules.release(id)` — the schedule lets go and the
   * subscription runs on as it is now, with no later phase: "Keep Business".
   */
  releaseSubscriptionSchedule(
    scheduleId: string,
  ): Promise<Stripe.SubscriptionSchedule>;
  /**
   * `paymentMethods.retrieve(id)` — the payment method a subscription is
   * charged to; for a card, `card.fingerprint` is the same for every use of
   * that card number, which is what the one-trial-per-card rule reads.
   */
  retrievePaymentMethod(paymentMethodId: string): Promise<Stripe.PaymentMethod>;
  /**
   * `products.create(params)` — one of the fixed Products a Bought Server's
   * lines are priced under (ADR-0071). Made with a fixed id, so it is made
   * once per Stripe account; a second create is refused by Stripe with
   * `resource_already_exists`, which the caller takes as "already there".
   */
  createProduct(params: Stripe.ProductCreateParams): Promise<Stripe.Product>;
  /**
   * `prices.create(params)` — the price one Bought Server line is sold at,
   * made at the sale under its kind's fixed Product, so no price list is
   * kept by hand and the line can be found on the subscription by it.
   */
  createPrice(params: Stripe.PriceCreateParams): Promise<Stripe.Price>;
  /**
   * `invoices.retrieve(id, { expand: ['payments.data.payment.payment_intent'] })`
   * — an invoice with its payment's intent expanded, so a purchase can tell a
   * payment waiting for 3D Secure from a refused one.
   */
  retrieveInvoice(invoiceId: string): Promise<Stripe.Invoice>;
  /**
   * `invoices.voidInvoice(id)` — an open invoice that will never be paid,
   * voided, so nothing is charged for a purchase cancelled while it waited.
   */
  voidInvoice(invoiceId: string): Promise<Stripe.Invoice>;
  /**
   * `refunds.create(params, { idempotencyKey })` — a payment given back, in
   * full unless `amount` says otherwise: a Bought Server paid for but never
   * made (#1391), or a paid change the provider refused twice (ADR-0071).
   * The key makes a second ask within Stripe's 24 hours the same refund; after that Stripe refuses a second full refund with
   * `charge_already_refunded`, which the caller takes as done.
   */
  createRefund(
    params: Stripe.RefundCreateParams,
    idempotencyKey: string,
  ): Promise<Stripe.Refund>;
  /**
   * `customers.createBalanceTransaction(id, params, { idempotencyKey })` —
   * the customer's credit balance moved: a negative amount credits it. A
   * purchase or change paid from the balance and never made is given back
   * this way, as a card payment is refunded.
   */
  createBalanceTransaction(
    customerId: string,
    params: Stripe.CustomerCreateBalanceTransactionParams,
    idempotencyKey: string,
  ): Promise<Stripe.CustomerBalanceTransaction>;
  /**
   * `invoices.create(params)` — a one-off invoice, outside any
   * subscription: a Server bought during the Free trial is charged on its
   * own, from today to the trial's end (the amendment to ADR-0054).
   */
  createInvoice(params: Stripe.InvoiceCreateParams): Promise<Stripe.Invoice>;
  /** `invoiceItems.create(params)` — one line of such an invoice. */
  createInvoiceItem(
    params: Stripe.InvoiceItemCreateParams,
  ): Promise<Stripe.InvoiceItem>;
  /**
   * `invoices.finalizeInvoice(id, { auto_advance: false })` — the draft
   * made final, so it can be paid; Cloudgate pays it itself, at once.
   */
  finalizeInvoice(invoiceId: string): Promise<Stripe.Invoice>;
  /**
   * `invoices.pay(id, params)` — the invoice charged now. A refused card,
   * or one waiting for 3D Secure, throws; the invoice then says which.
   */
  payInvoice(
    invoiceId: string,
    params: Stripe.InvoicePayParams,
  ): Promise<Stripe.Invoice>;
  /**
   * `checkout.sessions.retrieve(id)` — where a Checkout stands: open,
   * complete or expired. A Bought Server bought with no plan waits on one.
   */
  retrieveCheckoutSession(sessionId: string): Promise<Stripe.Checkout.Session>;
  /**
   * `checkout.sessions.expire(id)` — an open Checkout closed, so a purchase
   * cancelled while it waited can no longer be paid.
   */
  expireCheckoutSession(sessionId: string): Promise<Stripe.Checkout.Session>;
  /**
   * `charges.retrieve(id)` — the charge a dispute is about, for the customer
   * it was taken from: a dispute names only its charge.
   */
  retrieveCharge(chargeId: string): Promise<Stripe.Charge>;
  /**
   * `webhookEndpoints.list({ limit: 100 })` — the account's webhook
   * endpoints with the events each is subscribed to, which the start-up check
   * compares with HANDLED_EVENT_TYPES. Stripe allows 16 per account, so one
   * page holds them all.
   */
  listWebhookEndpoints(): Promise<Stripe.WebhookEndpoint[]>;
  /**
   * `webhooks.constructEvent` — verifies the signature over the *raw* request
   * body and throws when it does not match.
   */
  constructEvent(payload: Buffer | string, signature: string): Stripe.Event;
}
