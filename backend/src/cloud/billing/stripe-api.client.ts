import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import type { StripeApi } from './stripe-api';

/**
 * The real Stripe SDK behind the STRIPE_API port — a pass-through, so nothing
 * here needs a test double of its own.
 *
 *   * one client for the process, so connections and retries are shared;
 *   * `maxNetworkRetries: 3` on every call, so a transient network failure is
 *     retried;
 *   * no pinned `apiVersion`. The SDK's own default is the version its types
 *     are generated against, so pinning an older one would make the types lie.
 *
 * The key is read lazily: a self-hosted instance has none, and constructing the
 * client at boot with an empty string would throw before anything is served.
 */
@Injectable()
export class StripeApiClient implements StripeApi {
  private client?: Stripe;

  constructor(private readonly config: ConfigService) {}

  private get stripe(): Stripe {
    if (!this.client) {
      const key = this.config.get<string>('STRIPE_SECRET_KEY');
      if (!key) {
        throw new Error('STRIPE_SECRET_KEY is not configured');
      }
      this.client = new Stripe(key, { maxNetworkRetries: 3 });
    }
    return this.client;
  }

  retrievePrice(priceId: string): Promise<Stripe.Price> {
    return this.stripe.prices.retrieve(priceId, { expand: ['product'] });
  }

  retrieveSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
    return this.stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['items.data.price', 'default_payment_method'],
    });
  }

  retrieveCustomer(
    customerId: string,
  ): Promise<Stripe.Customer | Stripe.DeletedCustomer> {
    return this.stripe.customers.retrieve(customerId, {
      expand: ['invoice_settings.default_payment_method'],
    });
  }

  createCheckoutSession(
    params: Stripe.Checkout.SessionCreateParams,
  ): Promise<Stripe.Checkout.Session> {
    return this.stripe.checkout.sessions.create(params);
  }

  createBillingPortalSession(
    params: Stripe.BillingPortal.SessionCreateParams,
  ): Promise<Stripe.BillingPortal.Session> {
    return this.stripe.billingPortal.sessions.create(params);
  }

  async listBillingPortalConfigurations(): Promise<
    Stripe.BillingPortal.Configuration[]
  > {
    const configurations = await this.stripe.billingPortal.configurations.list({
      active: true,
      limit: 100,
    });
    return configurations.data;
  }

  createBillingPortalConfiguration(
    params: Stripe.BillingPortal.ConfigurationCreateParams,
  ): Promise<Stripe.BillingPortal.Configuration> {
    return this.stripe.billingPortal.configurations.create(params);
  }

  updateSubscription(
    subscriptionId: string,
    params: Stripe.SubscriptionUpdateParams,
  ): Promise<Stripe.Subscription> {
    return this.stripe.subscriptions.update(subscriptionId, params);
  }

  async listInvoices(customerId: string): Promise<Stripe.Invoice[]> {
    const invoices = await this.stripe.invoices.list({
      customer: customerId,
      limit: 100,
    });
    return invoices.data;
  }

  previewInvoice(
    params: Stripe.InvoiceCreatePreviewParams,
  ): Promise<Stripe.Invoice> {
    return this.stripe.invoices.createPreview(params);
  }

  createSubscriptionSchedule(
    params: Stripe.SubscriptionScheduleCreateParams,
  ): Promise<Stripe.SubscriptionSchedule> {
    return this.stripe.subscriptionSchedules.create(params);
  }

  retrieveSubscriptionSchedule(
    scheduleId: string,
  ): Promise<Stripe.SubscriptionSchedule> {
    return this.stripe.subscriptionSchedules.retrieve(scheduleId);
  }

  updateSubscriptionSchedule(
    scheduleId: string,
    params: Stripe.SubscriptionScheduleUpdateParams,
  ): Promise<Stripe.SubscriptionSchedule> {
    return this.stripe.subscriptionSchedules.update(scheduleId, params);
  }

  releaseSubscriptionSchedule(
    scheduleId: string,
  ): Promise<Stripe.SubscriptionSchedule> {
    return this.stripe.subscriptionSchedules.release(scheduleId);
  }

  retrievePaymentMethod(
    paymentMethodId: string,
  ): Promise<Stripe.PaymentMethod> {
    return this.stripe.paymentMethods.retrieve(paymentMethodId);
  }

  createProduct(params: Stripe.ProductCreateParams): Promise<Stripe.Product> {
    return this.stripe.products.create(params);
  }

  createPrice(params: Stripe.PriceCreateParams): Promise<Stripe.Price> {
    return this.stripe.prices.create(params);
  }

  retrieveInvoice(invoiceId: string): Promise<Stripe.Invoice> {
    return this.stripe.invoices.retrieve(invoiceId, {
      expand: ['payments.data.payment.payment_intent'],
    });
  }

  voidInvoice(invoiceId: string): Promise<Stripe.Invoice> {
    return this.stripe.invoices.voidInvoice(invoiceId);
  }

  createRefund(
    params: Stripe.RefundCreateParams,
    idempotencyKey: string,
  ): Promise<Stripe.Refund> {
    return this.stripe.refunds.create(params, { idempotencyKey });
  }

  createBalanceTransaction(
    customerId: string,
    params: Stripe.CustomerCreateBalanceTransactionParams,
    idempotencyKey: string,
  ): Promise<Stripe.CustomerBalanceTransaction> {
    return this.stripe.customers.createBalanceTransaction(customerId, params, {
      idempotencyKey,
    });
  }

  createInvoice(params: Stripe.InvoiceCreateParams): Promise<Stripe.Invoice> {
    return this.stripe.invoices.create(params);
  }

  createInvoiceItem(
    params: Stripe.InvoiceItemCreateParams,
  ): Promise<Stripe.InvoiceItem> {
    return this.stripe.invoiceItems.create(params);
  }

  finalizeInvoice(invoiceId: string): Promise<Stripe.Invoice> {
    return this.stripe.invoices.finalizeInvoice(invoiceId, {
      auto_advance: false,
    });
  }

  payInvoice(
    invoiceId: string,
    params: Stripe.InvoicePayParams,
  ): Promise<Stripe.Invoice> {
    return this.stripe.invoices.pay(invoiceId, params);
  }

  retrieveCheckoutSession(sessionId: string): Promise<Stripe.Checkout.Session> {
    return this.stripe.checkout.sessions.retrieve(sessionId);
  }

  expireCheckoutSession(sessionId: string): Promise<Stripe.Checkout.Session> {
    return this.stripe.checkout.sessions.expire(sessionId);
  }

  retrieveCharge(chargeId: string): Promise<Stripe.Charge> {
    return this.stripe.charges.retrieve(chargeId);
  }

  async listWebhookEndpoints(): Promise<Stripe.WebhookEndpoint[]> {
    const endpoints = await this.stripe.webhookEndpoints.list({ limit: 100 });
    return endpoints.data;
  }

  constructEvent(payload: Buffer | string, signature: string): Stripe.Event {
    const secret = this.config.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!secret) {
      throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
    }
    return this.stripe.webhooks.constructEvent(payload, signature, secret);
  }
}
