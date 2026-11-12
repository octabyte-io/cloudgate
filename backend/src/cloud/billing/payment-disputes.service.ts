import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, notInArray, or } from 'drizzle-orm';
import type Stripe from 'stripe';
import { boughtServer } from '../../bought-servers/bought-server.schema';
import type { BoughtServerStage } from '../../bought-servers/bought-server.schema';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { MailService } from '../../mail/mail.service';
import { renderPaymentDisputedEmail } from '../../mail/templates/bought-server-abuse';
import { organization } from '../../organizations/organizations.schema';
import { PermissionService } from '../../rbac/permission.service';
import { formatAmount } from './billing-notifications.service';
import { BillingConfig } from './billing.config';
import { subscription } from './billing.schema';
import { LapseNotifications } from './lapse-notifications.service';
import { STRIPE_API } from './stripe-api';
import type { StripeApi } from './stripe-api';

/**
 * The stages in which no machine is being paid for: not bought yet, never
 * made, or gone.
 */
const NO_MACHINE: BoughtServerStage[] = [
  'waiting_for_payment',
  'failed',
  'deleted',
];

/**
 * `charge.dispute.created` (ADR-0071, spec #1387, #1401): a disputed payment
 * of an Organization with **Bought Servers** emails the Operators, who
 * decide whether to suspend it. Octabyte goes on paying for the machines
 * while a dispute is open, which is why it is told; an Organization with no
 * Bought Server gets no email, and nothing is suspended automatically.
 *
 * The payment is the Paying Organization's, so the Bought Servers counted
 * are its own and every Attached Organization's (ADR-0059).
 */
@Injectable()
export class PaymentDisputes {
  private readonly logger = new Logger(PaymentDisputes.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(STRIPE_API) private readonly stripe: StripeApi,
    private readonly permissions: PermissionService,
    private readonly audiences: LapseNotifications,
    private readonly mail: MailService,
    private readonly config: BillingConfig,
  ) {}

  async disputeCreated(dispute: Stripe.Dispute): Promise<void> {
    const customerId = await this.customerOf(dispute);
    if (!customerId) return;

    const [payer] = await this.db
      .select({
        id: subscription.organizationId,
        name: organization.name,
      })
      .from(subscription)
      .innerJoin(organization, eq(organization.id, subscription.organizationId))
      .where(eq(subscription.stripeCustomerId, customerId))
      .limit(1);
    if (!payer) {
      this.logger.warn(
        `Dispute ${dispute.id}: no Organization holds customer ${customerId}`,
      );
      return;
    }

    const held = await this.db
      .select({ name: boughtServer.name })
      .from(boughtServer)
      .innerJoin(organization, eq(organization.id, boughtServer.organizationId))
      .where(
        and(
          or(
            eq(organization.id, payer.id),
            eq(organization.paidByOrganizationId, payer.id),
          ),
          notInArray(boughtServer.stage, NO_MACHINE),
        ),
      )
      .orderBy(asc(boughtServer.createdAt), asc(boughtServer.id));
    if (held.length === 0) return;

    const operatorsOrganizationId =
      await this.permissions.instanceOrganizationId();
    if (!operatorsOrganizationId) return;
    const { recipients } = await this.audiences.audienceOf(
      operatorsOrganizationId,
    );
    const operatorUrl = `${this.config.siteUrl}/settings/operator`;
    for (const recipient of recipients) {
      try {
        await this.mail.send(
          recipient.email,
          await renderPaymentDisputedEmail({
            userName: recipient.name,
            organizationName: payer.name,
            amount: formatAmount(dispute.amount, dispute.currency),
            reason: dispute.reason,
            disputeId: dispute.id,
            boughtServers: held.map((row) => row.name),
            operatorUrl,
          }),
        );
      } catch (error) {
        this.logger.error(
          `Failed to send the payment-disputed email to ${recipient.email}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /**
   * The customer the disputed charge was taken from: a dispute names only
   * its charge, which is read unless the event expanded it.
   */
  private async customerOf(dispute: Stripe.Dispute): Promise<string | null> {
    const charge =
      typeof dispute.charge === 'string'
        ? await this.stripe.retrieveCharge(dispute.charge)
        : dispute.charge;
    const customer = charge.customer;
    if (!customer) {
      this.logger.warn(`Dispute ${dispute.id}: its charge names no customer`);
      return null;
    }
    return typeof customer === 'string' ? customer : customer.id;
  }
}
