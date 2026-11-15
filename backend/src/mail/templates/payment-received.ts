import type { RenderedEmail } from './index';
import { renderConfirmationEmail } from './confirmation';

/** What a payment lifted, beside the failure it paid. */
export interface PaymentLifted {
  /** The Organization had lapsed, and is no longer frozen for it. */
  lapse: boolean;
  /** Its Bought Servers were due for deletion, and no longer are. */
  boughtServers: boolean;
}

/**
 * **Payment received** (spec #69, #71): a payment that failed was paid
 * after all. It says what that lifted: the lapse, so the Organization is no
 * longer frozen, and the Bought Servers' deletion date. A suspension is
 * not lifted by paying (ADR-0052), so a suspended Organization is told it
 * still is.
 *
 * `payingOrganizationName` is given for an Attached Organization's people
 * (ADR-0059), who never heard the payment fail: only that the plan their
 * Paying Organization pays for them with lapsed, so theirs says it was
 * paid for again.
 */
export async function renderPaymentReceivedEmail({
  userName,
  organizationName: org,
  billingUrl,
  lifted,
  stillSuspended,
  payingOrganizationName: payer,
}: {
  userName: string;
  organizationName: string;
  billingUrl: string;
  lifted: PaymentLifted;
  stillSuspended: boolean;
  payingOrganizationName?: string;
}): Promise<RenderedEmail> {
  const suspended = `A payment does not lift a suspension: contact Octabyte about it.`;
  const standing = stillSuspended
    ? lifted.lapse
      ? `${org} is no longer lapsed, but it is still suspended, so it stays frozen. ${suspended}`
      : `${org} is still suspended, so it stays frozen. ${suspended}`
    : lifted.lapse
      ? `${org} is no longer frozen: Cloudgate starts deploys, Cron service runs, backups, Uptime checks and cloud runs for it again, and it is no longer due for deletion.`
      : `${org} was never frozen, and its plan carries on as before.`;
  const boughtServers = lifted.boughtServers
    ? [
        `The Servers bought for ${org} are no longer due for deletion, and keep running as before.`,
      ]
    : [];

  if (payer !== undefined) {
    return renderConfirmationEmail(userName, {
      subject: stillSuspended
        ? `${payer} has paid, but ${org} is still suspended`
        : `${org} is no longer frozen: ${payer} has paid`,
      heading: `${payer} has paid`,
      paragraphs: [
        `${payer} has paid for the plan it pays for ${org} with, which had lapsed.`,
        standing,
        ...boughtServers,
      ],
      action: { label: 'Open Billing', url: billingUrl },
    });
  }
  return renderConfirmationEmail(userName, {
    subject: `Payment received for ${org}`,
    heading: 'Your payment was received',
    paragraphs: [
      `The Cloudgate payment for ${org} that failed has now been paid.`,
      standing,
      ...boughtServers,
    ],
    action: { label: 'Open Billing', url: billingUrl },
  });
}
