import { Injectable, Logger } from '@nestjs/common';
import { format } from 'date-fns';
import { formatAmount } from '../cloud/billing/billing-notifications.service';
import { BillingConfig } from '../cloud/billing/billing.config';
import { LapseNotifications } from '../cloud/billing/lapse-notifications.service';
import { MailService } from '../mail/mail.service';
import {
  renderBoughtServerRefundedEmail,
  renderBoughtServersDeletionEmail,
  renderOrphanMachinesFoundEmail,
} from '../mail/templates';
import type {
  BoughtServersDeletionEmail,
  RenderedEmail,
} from '../mail/templates';
import { renderBoughtServerPriceChangeEmail } from '../mail/templates/bought-server-price-change';
import type { RefundedTo } from '../mail/templates';
import type { BoughtServerOrphan } from './orphan-machine.schema';

/** A deletion email's notice, with its date as a moment. */
export type DeletionNotice =
  | { kind: 'payment-failed'; deletesOn: Date }
  | { kind: 'suspended'; deletesOn: Date }
  | { kind: 'cancel'; deletesOn: Date }
  | {
      kind: 'day-before';
      deletesOn: Date;
      dueTo: 'payment-failed' | 'suspension';
    }
  | {
      kind: 'deleted';
      deletedOn: Date;
      dueTo: 'payment-failed' | 'suspension' | 'lapse';
    };

/** A purchase refunded because its machine was never made. */
export interface RefundedPurchase {
  organizationId: string;
  serverName: string;
  /** What was refunded, in the invoice's smallest unit; null when unknown. */
  amountCents: number | null;
  currency: string | null;
  /** Where it went: the card, the account's credit, or each its part. */
  refundedTo?: RefundedTo;
  /** Why: never made (the default), or paid for with a prepaid card. */
  reason?: 'not-created' | 'prepaid-card';
}

/** One Bought Server an Operator repriced (#1400). */
export interface RepricedServer {
  serverName: string;
  oldMonthlyCents: number;
  newMonthlyCents: number;
  startsAt: Date;
  rise: boolean;
}

/**
 * The emails a **Bought Server**'s own stages send (ADR-0071). None names
 * the provider. A send that fails is logged and never stops the stage.
 */
@Injectable()
export class BoughtServerNotifications {
  private readonly logger = new Logger(BoughtServerNotifications.name);

  constructor(
    private readonly audiences: LapseNotifications,
    private readonly mail: MailService,
    private readonly billing: BillingConfig,
  ) {}

  /**
   * To the Organization's owner, about its Bought Servers' deletion (#1397):
   * a payment for them failed, or the Organization was suspended, and the
   * date; the warning 7 days before a cancel (#1398); the day-before
   * reminder; and the deletion, naming each Server.
   */
  async sendDeletion(
    organizationId: string,
    serverNames: readonly string[],
    notice: DeletionNotice,
  ): Promise<void> {
    const { organizationName, recipients } = await this.audiences.audienceOf(
      organizationId,
      ['owner'],
    );
    const formatted: BoughtServersDeletionEmail =
      notice.kind === 'deleted'
        ? { ...notice, deletedOn: formatDate(notice.deletedOn) }
        : { ...notice, deletesOn: formatDate(notice.deletesOn) };
    await this.deliver(`Bought Server ${notice.kind}`, recipients, (name) =>
      renderBoughtServersDeletionEmail({
        userName: name,
        organizationName,
        serverNames,
        billingUrl: `${this.billing.siteUrl}/settings/billing`,
        serversUrl: `${this.billing.siteUrl}/servers`,
        notice: formatted,
      }),
    );
  }

  private async deliver(
    what: string,
    recipients: ReadonlyArray<{ email: string; name: string }>,
    render: (name: string) => Promise<RenderedEmail>,
  ): Promise<void> {
    for (const recipient of recipients) {
      try {
        await this.mail.send(recipient.email, await render(recipient.name));
      } catch (error) {
        this.logger.error(
          `Failed to send the ${what} email to ${recipient.email}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /** To the Organization's owner: the Server could not be made, and its payment was refunded in full. */
  async sendRefunded(purchase: RefundedPurchase): Promise<void> {
    const { organizationName, recipients } = await this.audiences.audienceOf(
      purchase.organizationId,
      ['owner'],
    );
    const amount =
      purchase.amountCents !== null && purchase.currency
        ? formatAmount(purchase.amountCents, purchase.currency)
        : null;
    for (const recipient of recipients) {
      try {
        await this.mail.send(
          recipient.email,
          await renderBoughtServerRefundedEmail({
            userName: recipient.name,
            organizationName,
            serverName: purchase.serverName,
            amount,
            refundedTo: purchase.refundedTo,
            reason: purchase.reason,
            serversUrl: `${this.billing.siteUrl}/servers`,
          }),
        );
      } catch (error) {
        this.logger.error(
          `Failed to send the Bought Server refund email to ${recipient.email}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /**
   * To every Operator (the owners and admins of the Instance organization):
   * the orphan check found these machines, each for the first time. Nothing
   * is sent where there is no Instance organization.
   */
  async sendOrphansFound(
    operatorsOrganizationId: string | null,
    machines: BoughtServerOrphan[],
  ): Promise<void> {
    if (!operatorsOrganizationId || machines.length === 0) return;
    const { recipients } = await this.audiences.audienceOf(
      operatorsOrganizationId,
    );
    const lines = machines.map((machine) => {
      const labels = Object.entries(machine.labels)
        .map(([key, value]) => `${key}=${value}`)
        .join(', ');
      return `${machine.name} (${machine.providerServerId}) in ${machine.location}${
        labels ? `, labelled ${labels}` : ''
      }`;
    });
    for (const recipient of recipients) {
      try {
        await this.mail.send(
          recipient.email,
          await renderOrphanMachinesFoundEmail({
            userName: recipient.name,
            machines: lines,
            operatorUrl: `${this.billing.siteUrl}/settings/operator`,
          }),
        );
      } catch (error) {
        this.logger.error(
          `Failed to send the machines-nothing-owns email to ${recipient.email}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /**
   * To the Organization's owners: an Operator repriced its Bought Servers
   * (#1400), each with its old and new monthly price and the day the new one
   * starts. One email for all of them.
   */
  async sendPriceChange(
    organizationId: string,
    servers: RepricedServer[],
  ): Promise<void> {
    const { organizationName, recipients } = await this.audiences.audienceOf(
      organizationId,
      ['owner'],
    );
    const changes = servers.map((server) => ({
      serverName: server.serverName,
      oldPrice: formatAmount(server.oldMonthlyCents, 'usd'),
      newPrice: formatAmount(server.newMonthlyCents, 'usd'),
      startsOn: format(server.startsAt, 'MMM dd, yyyy'),
      rise: server.rise,
    }));
    for (const recipient of recipients) {
      try {
        await this.mail.send(
          recipient.email,
          await renderBoughtServerPriceChangeEmail({
            userName: recipient.name,
            organizationName,
            changes,
            serversUrl: `${this.billing.siteUrl}/servers`,
          }),
        );
      } catch (error) {
        this.logger.error(
          `Failed to send the Bought Server price change email to ${recipient.email}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}

function formatDate(at: Date): string {
  return format(at, 'MMM dd, yyyy');
}
