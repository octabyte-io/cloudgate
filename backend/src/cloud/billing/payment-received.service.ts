import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { renderPaymentReceivedEmail } from '../../mail/templates/payment-received';
import type { PaymentLifted } from '../../mail/templates/payment-received';
import { organization } from '../../organizations/organizations.schema';
import { isPaidStatus } from './billing-allowance';
import { BillingConfig } from './billing.config';
import { subscription } from './billing.schema';
import { FrozenOrganizations } from './frozen-organizations.service';
import { LapseNotifications } from './lapse-notifications.service';

/**
 * What a payment pays, as the event that saw it knows: the plan's own
 * failure (`plan`: the subscription is paid for again, which lifts a
 * recorded payment failure and a lapse), and the invoice whose failure put
 * the Bought Servers on their 7-day clock, when that one is now paid.
 */
export interface Payment {
  plan: boolean;
  boughtServersInvoiceId: string | null;
}

/**
 * **Payment received** (spec #69, #71): a failure recorded on the Paying
 * Organization's row is cleared by a payment, and its owners and admins
 * hear it, once.
 *
 * Both of Stripe's events for one payment (`customer.subscription.updated`
 * and `invoice.payment_succeeded`) arrive in no fixed order and may be
 * delivered again. Each clear is one conditional write, made under the
 * row's lock, that clears everything this payment lifts — the plan's failure
 * and the Bought Servers' failed invoice together — and whoever finds
 * something to clear sends the one email covering all of it. A renewal with
 * nothing recorded clears nothing and sends nothing.
 */
@Injectable()
export class PaymentReceived {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly config: BillingConfig,
    private readonly notifications: LapseNotifications,
    private readonly frozen: FrozenOrganizations,
  ) {}

  /**
   * What a subscription's own state says was paid: a paid status pays the
   * plan, and an `active` one whose latest invoice is the Bought Servers'
   * failed invoice has paid that too.
   */
  static of(stripeSubscription: Stripe.Subscription): Payment {
    const latest = stripeSubscription.latest_invoice;
    const latestInvoiceId =
      typeof latest === 'string' ? latest : (latest?.id ?? null);
    return {
      plan: isPaidStatus(stripeSubscription.status),
      boughtServersInvoiceId:
        stripeSubscription.status === 'active' ? latestInvoiceId : null,
    };
  }

  /**
   * Clears what `payment` lifts on the Organization's row and, when that
   * was a recorded failure, sends "payment received". Returns what it
   * lifted, or null when nothing was recorded.
   */
  async paid(
    organizationId: string,
    payment: Payment,
  ): Promise<PaymentLifted | null> {
    if (!payment.plan && payment.boughtServersInvoiceId === null) return null;
    const lifted = await this.clear(organizationId, payment);
    if (lifted) await this.send(organizationId, lifted);
    return lifted;
  }

  /**
   * The conditional write. Paying the plan clears the lapse and the
   * deletion clock's marks, and only those: a suspension is an Operator's
   * to lift (ADR-0052).
   */
  private clear(
    organizationId: string,
    payment: Payment,
  ): Promise<PaymentLifted | null> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          paymentFailedAt: subscription.paymentFailedAt,
          lapsedAt: subscription.lapsedAt,
          boughtServersFailedInvoiceId:
            subscription.boughtServersFailedInvoiceId,
        })
        .from(subscription)
        .where(eq(subscription.organizationId, organizationId))
        .for('update');
      if (!row) return null;
      const plan =
        payment.plan && (row.paymentFailedAt !== null || row.lapsedAt !== null);
      const boughtServers =
        payment.boughtServersInvoiceId !== null &&
        row.boughtServersFailedInvoiceId === payment.boughtServersInvoiceId;
      if (!payment.plan && !boughtServers) return null;

      await tx
        .update(subscription)
        .set({
          ...(payment.plan
            ? {
                lapsedAt: null,
                paymentFailedAt: null,
                lapseWarnedAt: null,
                deletionWarnedAt: null,
              }
            : {}),
          ...(boughtServers
            ? {
                boughtServersPaymentFailedAt: null,
                boughtServersFailedInvoiceId: null,
              }
            : {}),
        })
        .where(eq(subscription.organizationId, organizationId));
      if (!plan && !boughtServers) return null;
      return { lapse: plan && row.lapsedAt !== null, boughtServers };
    });
  }

  /**
   * To the Organization's owners and admins; after a lapse, also to each
   * Attached Organization's, which lapsed with it and is lifted with it
   * (ADR-0059). Each is told whether it is still suspended: its own
   * suspension, never its payer's.
   */
  private async send(
    organizationId: string,
    lifted: PaymentLifted,
  ): Promise<void> {
    const billingUrl = `${this.config.siteUrl}/settings/billing`;
    const suspended = await this.isSuspended(organizationId);
    await this.notifications.sendToOwnersAndAdmins(
      organizationId,
      'payment received',
      (recipient, organizationName) =>
        renderPaymentReceivedEmail({
          userName: recipient.name,
          organizationName,
          billingUrl,
          lifted,
          stillSuspended: suspended,
        }),
    );
    if (!lifted.lapse) return;

    const [payer] = await this.db
      .select({ name: organization.name })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1);
    const payingOrganizationName = payer?.name ?? '';
    const attached = await this.db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.paidByOrganizationId, organizationId))
      .orderBy(asc(organization.createdAt), asc(organization.id));
    for (const one of attached) {
      const stillSuspended = await this.isSuspended(one.id);
      await this.notifications.sendToOwnersAndAdmins(
        one.id,
        'payment received',
        (recipient, organizationName) =>
          renderPaymentReceivedEmail({
            userName: recipient.name,
            organizationName,
            billingUrl,
            lifted: { lapse: true, boughtServers: false },
            stillSuspended,
            payingOrganizationName,
          }),
      );
    }
  }

  private async isSuspended(organizationId: string): Promise<boolean> {
    return (await this.frozen.causesOf(organizationId)).includes('suspended');
  }
}
