import { render } from '@react-email/components';
import { emailLogoAttachment } from '../email-logo';
import type { RenderedEmail } from './index';
import { LapseNoticeTemplate } from './lapse-notice';

/**
 * The abuse and dispute emails of the Hosted instance (ADR-0071, spec
 * #1387, #1401), in the lapse emails' layout. Like every Bought Server email
 * they never name the provider: the report an Operator forwards is the one
 * text they did not write, and the Operator page asks them to remove it.
 */

/**
 * A deadline as the emails print it, always in UTC so it reads the same
 * wherever the instance runs: `Nov 11, 2026 at 14:05 UTC`.
 */
export function formatDeadline(at: Date): string {
  const month = at.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const day = String(at.getUTCDate()).padStart(2, '0');
  const hours = String(at.getUTCHours()).padStart(2, '0');
  const minutes = String(at.getUTCMinutes()).padStart(2, '0');
  return `${month} ${day}, ${at.getUTCFullYear()} at ${hours}:${minutes} UTC`;
}

/**
 * To every owner and admin of an Organization an Operator forwarded an
 * abuse report to: the report word for word, the 24-hour deadline, and how
 * to answer (a reply to this email). Suspension is named as what may follow,
 * never as automatic.
 */
export async function renderAbuseReportEmail({
  userName,
  organizationName,
  report,
  deadline,
}: {
  userName: string;
  organizationName: string;
  report: string;
  deadline: Date;
}): Promise<RenderedEmail> {
  const org = organizationName;
  const by = formatDeadline(deadline);
  return {
    subject: `Abuse report about ${org}: please answer by ${by}`,
    html: await render(
      LapseNoticeTemplate({
        userName: userName || 'User',
        heading: 'An abuse report needs your answer',
        paragraphs: [
          `Octabyte received an abuse report about a Server of ${org} on Cloudgate. Here it is as we received it:`,
          ...report.split(/\r?\n/).filter((line) => line.trim() !== ''),
          `Please answer by ${by}, 24 hours from when we sent this. Reply to this email with what caused it and what you have done to stop it.`,
          `If we have no answer by then, or the abuse goes on, Octabyte may suspend ${org}. A suspended Organization's Bought Servers are deleted 7 days later unless the suspension is lifted.`,
        ],
      }),
    ),
    inlineImages: [emailLogoAttachment('dark')],
  };
}

/**
 * To every Operator when a payment of an Organization with Bought Servers
 * is disputed: Octabyte keeps paying for those machines meanwhile, so an
 * Operator decides whether to suspend it.
 */
export async function renderPaymentDisputedEmail({
  userName,
  organizationName,
  amount,
  reason,
  disputeId,
  boughtServers,
  operatorUrl,
}: {
  userName: string;
  organizationName: string;
  /** The disputed amount, formatted. */
  amount: string;
  /** The bank's reason as Stripe words it: `fraudulent`, `product_not_received`. */
  reason: string;
  disputeId: string;
  /** The names of its Bought Servers that are not deleted. */
  boughtServers: readonly string[];
  operatorUrl: string;
}): Promise<RenderedEmail> {
  const org = organizationName;
  const count = boughtServers.length;
  return {
    subject: `A payment by ${org}, which has Bought Servers, was disputed`,
    html: await render(
      LapseNoticeTemplate({
        audience: 'operators',
        userName: userName || 'User',
        heading: 'A payment was disputed',
        paragraphs: [
          `A payment of ${amount} by ${org} was disputed with the card's bank. The reason given: ${reason.replace(/_/g, ' ')}. The dispute is ${disputeId} in Stripe.`,
          `${org} has ${count === 1 ? '1 Bought Server' : `${count} Bought Servers`}: ${boughtServers.join(', ')}. Octabyte goes on paying for ${count === 1 ? 'it' : 'them'} while the dispute is open.`,
          `Decide whether to suspend ${org} on the Operator page. Nothing is suspended automatically.`,
        ],
        action: { label: 'Open the Operator page', url: operatorUrl },
      }),
    ),
    inlineImages: [emailLogoAttachment('dark')],
  };
}
