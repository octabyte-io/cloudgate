import { Injectable } from '@nestjs/common';
import type Stripe from 'stripe';

/** What a purchase made outside billing hears from the Stripe webhook. */
export interface PurchasePaymentListener {
  /** `invoice.payment_succeeded`: any paid invoice; the listener picks out its own. */
  invoicePaid(invoice: Stripe.Invoice): Promise<void>;
  /**
   * `customer.subscription.pending_update_expired`: an update made with
   * `pending_if_incomplete` was never paid, and Stripe dropped it.
   */
  pendingUpdateExpired(subscription: Stripe.Subscription): Promise<void>;
  /**
   * `checkout.session.completed`, once billing has stored the plan and run
   * the card check: a purchase that started the plan through this Checkout
   * is charged now, on the plan as it stands.
   */
  checkoutCompleted(session: Stripe.Checkout.Session): Promise<void>;
  /**
   * `customer.subscription.updated`, once billing has stored it: lines
   * charged on their own invoice during the Free trial join the
   * subscription once the trial is over.
   */
  subscriptionUpdated(subscription: Stripe.Subscription): Promise<void>;
}

/**
 * What the **Bought Server** clock hears from the Stripe webhook (#1397):
 * a failed invoice with Bought Server lines starts it, and paying that
 * invoice ends it.
 */
export interface InvoiceOutcomeListener {
  /** `invoice.payment_failed`, once billing has stored the subscription's status. */
  invoiceFailed(invoice: Stripe.Invoice): Promise<void>;
  /** `invoice.payment_succeeded`. */
  invoicePaid(invoice: Stripe.Invoice): Promise<void>;
}

/**
 * Where the billing webhook tells purchases made outside billing about
 * their payments: a **Bought Server** (ADR-0071) is charged on the Hosted
 * plan's subscription, and only the webhook that sees the payment succeed
 * may start its machine.
 *
 * A registry rather than an import, because the Bought Servers module
 * already depends on billing (the Server count, the subscription), and
 * billing depending back on it would close a cycle. The listener registers
 * itself at start.
 */
@Injectable()
export class PurchasePayments {
  private readonly listeners: PurchasePaymentListener[] = [];
  private readonly invoiceListeners: InvoiceOutcomeListener[] = [];

  listen(listener: PurchasePaymentListener): void {
    this.listeners.push(listener);
  }

  /** The Bought Server clock's registration: failed and paid invoices. */
  listenToInvoices(listener: InvoiceOutcomeListener): void {
    this.invoiceListeners.push(listener);
  }

  async invoicePaid(invoice: Stripe.Invoice): Promise<void> {
    for (const listener of this.listeners) await listener.invoicePaid(invoice);
    for (const listener of this.invoiceListeners) {
      await listener.invoicePaid(invoice);
    }
  }

  async invoiceFailed(invoice: Stripe.Invoice): Promise<void> {
    for (const listener of this.invoiceListeners) {
      await listener.invoiceFailed(invoice);
    }
  }

  async pendingUpdateExpired(subscription: Stripe.Subscription): Promise<void> {
    for (const listener of this.listeners) {
      await listener.pendingUpdateExpired(subscription);
    }
  }

  async checkoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    for (const listener of this.listeners) {
      await listener.checkoutCompleted(session);
    }
  }

  async subscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
    for (const listener of this.listeners) {
      await listener.subscriptionUpdated(subscription);
    }
  }
}
