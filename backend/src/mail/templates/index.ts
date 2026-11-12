import { render } from '@react-email/components';
import { emailLogoAttachment } from '../email-logo';
import type { MailAttachment } from '../senders/smtp';
import { InvitationTemplate } from './invitation';
import { InvoiceNotificationTemplate } from './invoice-notification';
import { LapseNoticeTemplate } from './lapse-notice';
import { PaymentFailedTemplate } from './payment-failed';
import { ResetPasswordTemplate } from './reset-password';
import { VerifyEmailTemplate } from './verify-email';

/** A template rendered and ready to hand to a sender. */
export interface RenderedEmail {
  subject: string;
  html: string;
  /**
   * The inline images the HTML references by `cid:` — the header logo
   * (`email-logo.ts`) — which every send path attaches with the email, so no
   * caller has to remember it. Absent for a body with no header (the
   * notification channels' test probe).
   */
  inlineImages?: MailAttachment[];
}

/**
 * The email-confirmation message — subject + rendered HTML. `purpose` is a new
 * account's address (the default) or the new address of a change of email.
 */
export async function renderVerificationEmail({
  userName,
  verificationUrl,
  purpose = 'sign-up',
}: {
  userName: string;
  verificationUrl: string;
  purpose?: 'sign-up' | 'email-change';
}): Promise<RenderedEmail> {
  return {
    subject:
      purpose === 'email-change'
        ? 'Confirm your new email address'
        : 'Verify your email',
    html: await render(
      VerifyEmailTemplate({
        userName: userName || 'User',
        verificationUrl,
        purpose,
      }),
    ),
    inlineImages: [emailLogoAttachment('dark')],
  };
}

/**
 * The render half of better-auth's `sendResetPassword` — subject + rendered
 * HTML for the link better-auth mints on `/request-password-reset`.
 */
export async function renderResetPasswordEmail({
  userName,
  resetUrl,
}: {
  userName: string;
  resetUrl: string;
}): Promise<RenderedEmail> {
  return {
    subject: 'Reset your password',
    html: await render(
      ResetPasswordTemplate({ userName: userName || 'User', resetUrl }),
    ),
    inlineImages: [emailLogoAttachment('dark')],
  };
}

/**
 * The render half of the organization plugin's `sendInvitationEmail` — subject
 * + rendered HTML for the `/accept-invitation/<id>` link. better-auth builds no
 * URL of its own here (unlike `sendResetPassword`), so the caller passes the one
 * it wants the invitee to open.
 *
 * `inviterEmail` is the fallback for the inviter's display name: better-auth's
 * `name` maps to the `firstName` column, which an SSO- or SCIM-provisioned
 * account can legitimately have empty, and "invited you to" with nobody in
 * front of it reads like spam.
 */
export async function renderInvitationEmail({
  organizationName,
  inviterName,
  inviterEmail,
  role,
  acceptUrl,
}: {
  organizationName: string;
  inviterName: string;
  inviterEmail?: string;
  role: string;
  acceptUrl: string;
}): Promise<RenderedEmail> {
  return {
    subject: `You are invited to join ${organizationName} on Cloudgate`,
    html: await render(
      InvitationTemplate({
        organizationName,
        invitedBy: inviterName || inviterEmail || 'Someone',
        role,
        acceptUrl,
      }),
    ),
    inlineImages: [emailLogoAttachment('dark')],
  };
}

/**
 * The paid-invoice message — subject (`Cloudgate Invoice <number> - <amount>`)
 * + rendered HTML.
 */
export async function renderInvoiceNotificationEmail(props: {
  userName: string;
  invoiceNumber: string;
  amountPaid: string;
  currency: string;
  date: string;
  hostedInvoiceUrl: string;
  hasPdf: boolean;
  /** The first real charge after the free trial: it says the trial ended. */
  trialEnded?: boolean;
}): Promise<RenderedEmail> {
  return {
    subject: `Cloudgate Invoice ${props.invoiceNumber} - ${props.amountPaid}`,
    html: await render(
      InvoiceNotificationTemplate({
        ...props,
        userName: props.userName || 'User',
      }),
    ),
    inlineImages: [emailLogoAttachment('dark')],
  };
}

/** The failed-payment message — subject + rendered HTML. */
export async function renderPaymentFailedEmail(props: {
  userName: string;
  invoiceNumber: string;
  amountDue: string;
  currency: string;
  date: string;
  hostedInvoiceUrl: string;
}): Promise<RenderedEmail> {
  return {
    subject: `Action required: Cloudgate payment failed - ${props.amountDue}`,
    html: await render(
      PaymentFailedTemplate({ ...props, userName: props.userName || 'User' }),
    ),
    inlineImages: [emailLogoAttachment('dark')],
  };
}

/**
 * The Frozen Organization's lapse and deletion emails (ADR-0052), each
 * sent to every owner and admin and never opt-in. The payment-failed email is
 * {@link renderPaymentFailedEmail}; these are the other four, the third in two
 * wordings — "lapsed" when Stripe gave up on a payment, "your plan has ended"
 * after a cancel or when an Operator ended the Enterprise agreement
 * ({@link PlanEndedCause}). Dates arrive formatted.
 */
export type LapseEmail =
  | { kind: 'lapse-warning'; lapsesOn: string }
  | { kind: 'lapsed'; deletesOn: string }
  | { kind: 'plan-ended'; deletesOn: string; cause?: PlanEndedCause }
  | { kind: 'deletion-warning'; deletesOn: string }
  | { kind: 'deleted' };

/**
 * What ended the plan, for the "your plan has ended" email's first sentence:
 * the customer's cancel taking effect (the default), an Operator switching
 * the Enterprise marker off, or a free trial that ended without a
 * charge — cancelled, or its card removed.
 */
export type PlanEndedCause = 'cancel' | 'enterprise' | 'trial';

const PLAN_ENDED_BECAUSE: Record<PlanEndedCause, (org: string) => string> = {
  cancel: (org) => `The cancellation of ${org}'s plan has taken effect.`,
  enterprise: (org) =>
    `${org}'s Enterprise agreement with Octabyte has ended, and ${org} has no Cloudgate plan now.`,
  trial: (org) =>
    `${org}'s free trial has ended and you were not charged. ${org} has no Cloudgate plan now.`,
};

interface LapseCopy {
  subject: string;
  heading: string;
  paragraphs: string[];
  action?: { label: string; url: string };
}

function lapseCopy(
  org: string,
  billingUrl: string,
  notice: LapseEmail,
): LapseCopy {
  const frozen = `${org} is now frozen: its Services keep running on your Servers and in your clouds, but Cloudgate starts no deploys, Cron runs, backups, Uptime checks or cloud runs for it.`;
  const deletion = (deletesOn: string) =>
    `Unless you pay, ${org} and everything Cloudgate stores for it (secrets, keys, cloud credentials, configs and logs) will be deleted on ${deletesOn}. Nothing on your Servers or in your clouds is touched.`;
  const pay = { label: 'Pay to continue', url: billingUrl };

  switch (notice.kind) {
    case 'lapse-warning':
      return {
        subject: `3 days left to pay for ${org} on Cloudgate`,
        heading: 'Your payment is still failing',
        paragraphs: [
          `Stripe has still not been able to take the payment for ${org}. It stops retrying on ${notice.lapsesOn}, and ${org} will then be frozen: Cloudgate will start no deploys, Cron runs, backups, Uptime checks or cloud runs for it.`,
          'Update your payment method to keep everything running.',
        ],
        action: { label: 'Update payment method', url: billingUrl },
      };
    case 'lapsed':
      return {
        subject: `${org} is frozen: your Cloudgate payment failed`,
        heading: 'Your Cloudgate plan has lapsed',
        paragraphs: [
          `Stripe could not take the payment for ${org} and has stopped retrying.`,
          frozen,
          deletion(notice.deletesOn),
        ],
        action: pay,
      };
    case 'plan-ended':
      return {
        subject:
          notice.cause === 'trial'
            ? `Your Cloudgate free trial for ${org} has ended`
            : `Your Cloudgate plan for ${org} has ended`,
        heading:
          notice.cause === 'trial'
            ? 'Your free trial has ended'
            : 'Your plan has ended',
        paragraphs: [
          PLAN_ENDED_BECAUSE[notice.cause ?? 'cancel'](org),
          frozen,
          deletion(notice.deletesOn),
        ],
        action: pay,
      };
    case 'deletion-warning':
      return {
        subject: `${org} will be deleted from Cloudgate on ${notice.deletesOn}`,
        heading: '7 days until deletion',
        paragraphs: [
          `${org} has been frozen since its plan ended.`,
          deletion(notice.deletesOn),
        ],
        action: pay,
      };
    case 'deleted':
      return {
        subject: `${org} has been deleted from Cloudgate`,
        heading: 'Organization deleted',
        paragraphs: [
          `${org} was deleted 30 days after its plan ended. Cloudgate no longer stores its secrets, keys, cloud credentials, configs or logs.`,
          'Nothing on your Servers or in your clouds was touched: the Services there keep running, and are yours to manage or remove.',
        ],
      };
  }
}

const ATTACHED_PLAN_ENDED_BECAUSE: Record<
  PlanEndedCause,
  (payer: string) => string
> = {
  cancel: (payer) => `${payer} cancelled it.`,
  enterprise: (payer) =>
    `${payer}'s Enterprise agreement with Octabyte has ended.`,
  trial: (payer) => `${payer}'s free trial ended without a charge.`,
};

/**
 * The same emails to an **Attached Organization's** owners and admins
 * (ADR-0059), about its Paying Organization's plan: worded "the plan
 * <Paying Organization> pays for this Organization with…". Nothing asks them
 * to fix the payment — only the Paying Organization's owners and admins can —
 * so the button opens their Billing page instead.
 */
function attachedLapseCopy(
  org: string,
  payer: string,
  billingUrl: string,
  notice: LapseEmail,
): LapseCopy {
  const plan = `the plan ${payer} pays for this Organization with`;
  const frozen = `${org} is now frozen: its Services keep running on your Servers and in your clouds, but Cloudgate starts no deploys, Cron runs, backups, Uptime checks or cloud runs for it.`;
  const deletion = (deletesOn: string) =>
    `Unless ${payer} pays again, ${org} and everything Cloudgate stores for it (secrets, keys, cloud credentials, configs and logs) will be deleted on ${deletesOn}, together with ${payer}. Nothing on your Servers or in your clouds is touched.`;
  const open = { label: 'Open billing', url: billingUrl };

  switch (notice.kind) {
    case 'lapse-warning':
      return {
        subject: `3 days left on the plan ${payer} pays for ${org} with`,
        heading: `${payer}'s payment is still failing`,
        paragraphs: [
          `Stripe has still not been able to take the payment for ${plan}. It stops retrying on ${notice.lapsesOn}, and ${org} will then be frozen together with ${payer}: Cloudgate will start no deploys, Cron runs, backups, Uptime checks or cloud runs for it.`,
          `Only ${payer}'s owners and admins can update its payment method.`,
        ],
        action: open,
      };
    case 'lapsed':
      return {
        subject: `${org} is frozen: the plan ${payer} pays for it with has lapsed`,
        heading: 'The plan that pays for this Organization has lapsed',
        paragraphs: [
          `Stripe could not take the payment for ${plan}, and has stopped retrying.`,
          frozen,
          deletion(notice.deletesOn),
        ],
        action: open,
      };
    case 'plan-ended':
      return {
        subject: `The plan ${payer} pays for ${org} with has ended`,
        heading: 'The plan that pays for this Organization has ended',
        paragraphs: [
          `The plan ${payer} pays for this Organization with has ended: ${ATTACHED_PLAN_ENDED_BECAUSE[notice.cause ?? 'cancel'](payer)}`,
          frozen,
          deletion(notice.deletesOn),
        ],
        action: open,
      };
    case 'deletion-warning':
      return {
        subject: `${org} will be deleted from Cloudgate on ${notice.deletesOn}`,
        heading: '7 days until deletion',
        paragraphs: [
          `${org} has been frozen since ${plan} ended.`,
          deletion(notice.deletesOn),
        ],
        action: open,
      };
    case 'deleted':
      return {
        subject: `${org} has been deleted from Cloudgate`,
        heading: 'Organization deleted',
        paragraphs: [
          `${org} was deleted together with ${payer}, 30 days after the plan ${payer} paid for this Organization with ended. Cloudgate no longer stores its secrets, keys, cloud credentials, configs or logs.`,
          'Nothing on your Servers or in your clouds was touched: the Services there keep running, and are yours to manage or remove.',
        ],
      };
  }
}

/**
 * One lapse email. `payingOrganizationName` is given when it goes to an
 * Attached Organization's owners and admins about its Paying Organization's
 * plan, and words it that way.
 */
export async function renderLapseEmail({
  userName,
  organizationName,
  billingUrl,
  notice,
  payingOrganizationName,
}: {
  userName: string;
  organizationName: string;
  billingUrl: string;
  notice: LapseEmail;
  payingOrganizationName?: string;
}): Promise<RenderedEmail> {
  const copy =
    payingOrganizationName === undefined
      ? lapseCopy(organizationName, billingUrl, notice)
      : attachedLapseCopy(
          organizationName,
          payingOrganizationName,
          billingUrl,
          notice,
        );
  return {
    subject: copy.subject,
    html: await render(
      LapseNoticeTemplate({
        userName: userName || 'User',
        heading: copy.heading,
        paragraphs: copy.paragraphs,
        action: copy.action,
      }),
    ),
    inlineImages: [emailLogoAttachment('dark')],
  };
}

/**
 * **"Stop paying for it"** (ADR-0059): the Paying Organization
 * detached this one, which lapsed at once. To its owner only, the one person
 * who can now pay for it — with no Free trial, and only while they own no
 * other Organization that pays for itself. The deletion warning and the
 * deleted email that may follow are the ordinary {@link renderLapseEmail}
 * ones: once detached, it pays for itself.
 */
export async function renderStoppedPayingEmail({
  userName,
  organizationName: org,
  payingOrganizationName: payer,
  billingUrl,
  deletesOn,
}: {
  userName: string;
  organizationName: string;
  payingOrganizationName: string;
  billingUrl: string;
  deletesOn: string;
}): Promise<RenderedEmail> {
  return {
    subject: `${org} is frozen: ${payer} has stopped paying for it`,
    html: await render(
      LapseNoticeTemplate({
        userName: userName || 'User',
        heading: `${payer} has stopped paying for ${org}`,
        paragraphs: [
          `${payer} has stopped paying for ${org}. It has left the plan ${payer} pays for, and its Servers and Cloud Environments no longer count against it.`,
          `${org} is now frozen: its Services keep running on your Servers and in your clouds, but Cloudgate starts no deploys, Cron runs, backups, Uptime checks or cloud runs for it.`,
          `Unless you pay, ${org} and everything Cloudgate stores for it (secrets, keys, cloud credentials, configs and logs) will be deleted on ${deletesOn}. Nothing on your Servers or in your clouds is touched.`,
          `You can pay for ${org} yourself, without a free trial, unless you already own another Organization that pays for itself.`,
        ],
        action: { label: 'Pay to continue', url: billingUrl },
      }),
    ),
    inlineImages: [emailLogoAttachment('dark')],
  };
}

/**
 * Where a Bought Server payment given back in full went: the card that paid
 * it, the account's credit balance that paid it, or each its own part.
 */
export type RefundedTo = 'card' | 'balance' | 'both';

/** The sentence saying where a payment given back in full went. */
function refundedToSentence(payment: string, to: RefundedTo): string {
  switch (to) {
    case 'card':
      return `${payment} was refunded in full to the card it was charged to. Your bank may take 5 to 10 days to show it.`;
    case 'balance':
      return `${payment} came from your account's credit, so it was credited back to that credit in full, and goes toward your next invoice.`;
    case 'both':
      return `${payment} was given back in full: the part your card paid was refunded to it, which your bank may take 5 to 10 days to show, and the part paid from your account's credit was credited back to it.`;
  }
}

/**
 * A **Bought Server** paid for but never made (ADR-0071, #1391): Cloudgate
 * asked twice, then refunded the payment in full and removed the Server.
 * Or (`reason: 'prepaid-card'`) the Checkout that started the plan charged
 * the Server to a prepaid card, which Servers are never sold to: the
 * Server's share was given back and it was never made, while the plan stays.
 * To the Organization's owner. Never names the provider. `amount` is null
 * when the invoice's amount could not be read.
 */
export async function renderBoughtServerRefundedEmail({
  userName,
  organizationName,
  serverName,
  amount,
  refundedTo = 'card',
  reason = 'not-created',
  serversUrl,
}: {
  userName: string;
  organizationName: string;
  serverName: string;
  amount: string | null;
  refundedTo?: RefundedTo;
  reason?: 'not-created' | 'prepaid-card';
  serversUrl: string;
}): Promise<RenderedEmail> {
  const prepaid = reason === 'prepaid-card';
  const payment = amount ? `Your payment of ${amount}` : 'Your payment';
  return {
    subject: prepaid
      ? `Your Server ${serverName} cannot be paid for with a prepaid card, so its payment was refunded`
      : `Your Server ${serverName} could not be created, so your payment was refunded`,
    html: await render(
      LapseNoticeTemplate({
        audience: 'owners',
        userName: userName || 'User',
        heading: 'Your payment was refunded',
        paragraphs: [
          prepaid
            ? `A Server cannot be paid for with a prepaid card, so Cloudgate did not create the Server ${serverName} for ${organizationName}. Its Starter plan is kept.`
            : `Cloudgate could not create the Server ${serverName} for ${organizationName} after you paid for it, and tried twice.`,
          refundedToSentence(payment, refundedTo),
          prepaid
            ? `${serverName} is removed from your Servers, and nothing more will be charged for it. You can buy a Server again with a credit or debit card.`
            : `${serverName} is removed from your Servers, and nothing more will be charged for it. You can buy a Server again; another size or location may be available.`,
        ],
        action: { label: 'Open Servers', url: serversUrl },
      }),
    ),
    inlineImages: [emailLogoAttachment('dark')],
  };
}

/**
 * The **Bought Server** deletion emails (ADR-0071, #1397) to the
 * Organization's owner: a payment for them failed and they will be deleted
 * on a date, the Organization was suspended and they will be deleted on a
 * date (#1398), its plan is cancelled and they will be deleted when it ends
 * (7 days before, #1398), the day-before reminder, and the deletion itself,
 * worded for its cause. Each gives the date and says that the data and
 * backups go with the machine, for good. The date arrives formatted; none
 * names the provider.
 */
export type BoughtServersDeletionEmail =
  | { kind: 'payment-failed'; deletesOn: string }
  | { kind: 'suspended'; deletesOn: string }
  | { kind: 'cancel'; deletesOn: string }
  | {
      kind: 'day-before';
      deletesOn: string;
      /** What set the date: a lapse deletes with no reminder. */
      dueTo: 'payment-failed' | 'suspension';
    }
  | {
      kind: 'deleted';
      deletedOn: string;
      dueTo: 'payment-failed' | 'suspension' | 'lapse';
    };

export async function renderBoughtServersDeletionEmail({
  userName,
  organizationName,
  serverNames,
  billingUrl,
  serversUrl,
  notice,
}: {
  userName: string;
  organizationName: string;
  /** The Bought Servers it is about, by name. */
  serverNames: readonly string[];
  billingUrl: string;
  serversUrl: string;
  notice: BoughtServersDeletionEmail;
}): Promise<RenderedEmail> {
  const org = organizationName;
  const servers = serverNames.join(', ');
  const these =
    serverNames.length === 1
      ? `The Server you bought from Cloudgate for ${org}, ${servers}`
      : `The ${serverNames.length} Servers you bought from Cloudgate for ${org} (${servers})`;
  const gone =
    'Each one is deleted with its machine: its data and its backups go with it, and this cannot be undone. Move anything you need off them before then.';
  const pay = { label: 'Pay the open invoice', url: billingUrl };
  const isAre = serverNames.length === 1 ? 'is' : 'are';
  const itThey = serverNames.length === 1 ? 'it' : 'they';
  const theServers = serverNames.length === 1 ? 'the Server' : 'the Servers';

  const copy: LapseCopy = (() => {
    switch (notice.kind) {
      case 'payment-failed':
        return {
          subject: `Your Servers for ${org} will be deleted on ${notice.deletesOn} unless you pay`,
          heading: 'Your payment for your Servers failed',
          paragraphs: [
            `The payment for ${org}'s invoice could not be taken. ${these} ${serverNames.length === 1 ? 'is' : 'are'} paid for on it, so unless the invoice is paid by ${notice.deletesOn}, ${serverNames.length === 1 ? 'it' : 'they'} will be deleted on that day.`,
            gone,
            'Pay the open invoice, or update your payment method, under Settings > Billing. Until it is paid, nothing that costs more can be bought.',
          ],
          action: pay,
        };
      case 'suspended':
        return {
          subject: `Your Servers for ${org} will be deleted on ${notice.deletesOn} unless the suspension is lifted`,
          heading: 'Your Servers will be deleted',
          paragraphs: [
            `Octabyte suspended ${org}. ${these} ${isAre} due for deletion on ${notice.deletesOn}, and ${itThey} will be deleted on that day unless the suspension is lifted first. Paying does not lift it.`,
            gone,
            'Reply to the suspension email, or contact Octabyte, to resolve it.',
          ],
        };
      case 'cancel':
        return {
          subject: `Your Servers for ${org} will be deleted on ${notice.deletesOn}`,
          heading: 'Your Servers will be deleted when your plan ends',
          paragraphs: [
            `${org}'s plan is cancelled and ends on ${notice.deletesOn}. ${these} ${isAre} paid for on it, so ${itThey} will be deleted on that day.`,
            gone,
            'To keep them, resume the plan under Settings > Billing before then.',
          ],
          action: { label: 'Open Billing', url: billingUrl },
        };
      case 'day-before':
        return notice.dueTo === 'suspension'
          ? {
              subject: `Your Servers for ${org} will be deleted in a day`,
              heading: 'Your Servers will be deleted in a day',
              paragraphs: [
                `${org} is still suspended. ${these} ${isAre} due for deletion on ${notice.deletesOn}, and will be deleted within a day unless the suspension is lifted.`,
                gone,
              ],
            }
          : {
              subject: `Your Servers for ${org} will be deleted in a day`,
              heading: 'Your Servers will be deleted in a day',
              paragraphs: [
                `${org}'s invoice is still unpaid. ${these} ${isAre} due for deletion on ${notice.deletesOn}, and will be deleted within a day.`,
                gone,
                'Paying the open invoice now keeps them.',
              ],
              action: pay,
            };
      case 'deleted': {
        const because = {
          'payment-failed': `${org}'s invoice was not paid`,
          suspension: `${org} stayed suspended`,
          lapse: `${org}'s plan ended`,
        }[notice.dueTo];
        return {
          subject: `Your Servers for ${org} were deleted`,
          heading: 'Your Servers were deleted',
          paragraphs: [
            `${because}, so on ${notice.deletedOn} Cloudgate deleted ${theServers} you bought for it: ${servers}.`,
            'Their machines, their data and their backups are gone, and cannot be brought back. Each one is still listed in Servers, marked Deleted, with the Services it carried, so you can see what was on it and move or delete them.',
          ],
          action: { label: 'Open Servers', url: serversUrl },
        };
      }
    }
  })();

  return {
    subject: copy.subject,
    html: await render(
      LapseNoticeTemplate({
        audience: 'owners',
        userName: userName || 'User',
        heading: copy.heading,
        paragraphs: copy.paragraphs,
        action: copy.action,
      }),
    ),
    inlineImages: [emailLogoAttachment('dark')],
  };
}

/**
 * The suspension emails (ADR-0050): an Operator suspended the
 * Organization, with the reason they gave, or lifted the suspension. Sent to
 * every owner, in the lapse emails' layout. Lifting does not unfreeze an
 * Organization that has also lapsed, so the lift says so when it has.
 */
export type SuspensionEmail =
  | { kind: 'suspended'; reason: string }
  | { kind: 'lifted'; stillLapsed: boolean };

export async function renderSuspensionEmail({
  userName,
  organizationName,
  billingUrl,
  notice,
}: {
  userName: string;
  organizationName: string;
  billingUrl: string;
  notice: SuspensionEmail;
}): Promise<RenderedEmail> {
  const org = organizationName;
  const copy: LapseCopy =
    notice.kind === 'suspended'
      ? {
          subject: `${org} has been suspended on Cloudgate`,
          heading: 'Your Organization is suspended',
          paragraphs: [
            `Octabyte has suspended ${org}. The reason given: ${notice.reason}`,
            `${org} is frozen while the suspension lasts: its Services keep running on your Servers and in your clouds, but Cloudgate starts no deploys, Cron runs, backups, Uptime checks or cloud runs for it. A payment does not lift a suspension.`,
            'Reply to this email or contact Octabyte to resolve it.',
          ],
        }
      : {
          subject: `The suspension of ${org} on Cloudgate has been lifted`,
          heading: 'Your suspension is lifted',
          paragraphs: notice.stillLapsed
            ? [
                `Octabyte has lifted the suspension of ${org}.`,
                `${org} stays frozen because its plan has ended. Pay to continue; you will be warned again at least 7 days before it is deleted.`,
              ]
            : [
                `Octabyte has lifted the suspension of ${org}. Cloudgate runs its work again as before.`,
              ],
          action: notice.stillLapsed
            ? { label: 'Pay to continue', url: billingUrl }
            : undefined,
        };
  return {
    subject: copy.subject,
    html: await render(
      LapseNoticeTemplate({
        audience: 'owners',
        userName: userName || 'User',
        heading: copy.heading,
        paragraphs: copy.paragraphs,
        action: copy.action,
      }),
    ),
    inlineImages: [emailLogoAttachment('dark')],
  };
}

/**
 * Why an Organization on the Hosted instance no longer has the Business
 * features (ADR-0054): it moved from Business to Starter, its Business
 * plan ended (a lapse), or an Operator ended its Enterprise agreement.
 */
export type BusinessEndedCause = 'starter' | 'ended' | 'enterprise';

const BUSINESS_ENDED_BECAUSE: Record<
  BusinessEndedCause,
  (org: string) => string
> = {
  starter: (org) => `${org} has moved from the Business plan to Starter.`,
  ended: (org) => `${org} is no longer on the Business plan.`,
  enterprise: (org) => `${org}'s Enterprise agreement with Octabyte has ended.`,
};

/** One member on a custom role, as the email names them. */
export interface CustomRoleHolder {
  name: string;
  email: string;
  role: string;
}

/**
 * The email to every owner and admin when an Organization on the Hosted
 * instance stops having the Business features and somebody holds a custom role:
 * it names them, says their role grants nothing now and that nobody
 * was moved, and links to the Members page to change their role. Sent only
 * when the list is not empty, in the lapse emails' layout.
 */
export async function renderCustomRolesStoppedEmail({
  userName,
  organizationName,
  cause,
  holders,
  membersUrl,
}: {
  userName: string;
  organizationName: string;
  cause: BusinessEndedCause;
  holders: readonly CustomRoleHolder[];
  membersUrl: string;
}): Promise<RenderedEmail> {
  const org = organizationName;
  const count = holders.length;
  const who = count === 1 ? 'This member holds' : `These ${count} members hold`;
  return {
    subject:
      count === 1
        ? `1 member of ${org} is on a custom role that no longer works`
        : `${count} members of ${org} are on custom roles that no longer work`,
    html: await render(
      LapseNoticeTemplate({
        userName: userName || 'User',
        heading: 'Custom roles have stopped working',
        paragraphs: [
          `${BUSINESS_ENDED_BECAUSE[cause](org)} Custom roles come with the Business plan, so they grant nothing now. ${who} one:`,
          ...holders.map(
            (holder) =>
              `${holder.name} (${holder.email}), role "${holder.role}"`,
          ),
          'They can still sign in, but every action is refused until their role changes. Nobody was moved to another role automatically: the member role grants backups, volumes and environment variables outright, which a narrower custom role may not.',
          'Change their role on the Members page, or choose Business under Settings > Billing and the custom roles work again as they were.',
        ],
        action: { label: 'Change their role', url: membersUrl },
      }),
    ),
    inlineImages: [emailLogoAttachment('dark')],
  };
}

/**
 * The direct owner email a Self-hosted license sends 14 and 3 days before its
 * `validUntil`, not opt-in, in the lapse emails' layout. It names the
 * date on the key and no other: the 14 days Octabyte adds when it issues a key
 * are already inside `validUntil` (ADR-0054). `licenseUrl` is the console's
 * License page, or null when the instance does not know its own address yet.
 * Dates arrive formatted.
 */
export async function renderLicenseExpiringEmail({
  userName,
  organizationName,
  expiresOn,
  stopped,
  licenseUrl,
}: {
  userName: string;
  organizationName: string;
  expiresOn: string;
  stopped: readonly string[];
  licenseUrl: string | null;
}): Promise<RenderedEmail> {
  const org = organizationName;
  return {
    subject: `The enterprise license for ${org} expires on ${expiresOn}`,
    html: await render(
      LapseNoticeTemplate({
        userName: userName || 'User',
        heading: 'Your enterprise license is about to expire',
        paragraphs: [
          `The enterprise license for ${org} on this Cloudgate instance expires on ${expiresOn}.`,
          `From then on, these stop until it is renewed: ${stopped.join('; ')}. Your settings are kept and work again once the license is renewed.`,
          'Renew it with Octabyte. The instance checks its key every day, so a renewal reaches it without the key being pasted again.',
        ],
        action: licenseUrl
          ? { label: 'Open the License page', url: licenseUrl }
          : undefined,
      }),
    ),
    inlineImages: [emailLogoAttachment('dark')],
  };
}

/**
 * The free trial's two emails of its own (ADR-0052 amended, ADR-0054), to every
 * owner and admin and never opt-in, in the lapse emails'
 * layout: "your trial has started" when the trial begins, and "your trial
 * ends in 7 days" from the daily job. Stripe's own trial reminder stays off,
 * so these are the only ones. Dates and amounts arrive formatted; `monthly`
 * is null when Stripe's prices could not be totalled, and the email then
 * points at the Billing page for it.
 */
export interface TrialEmailFacts {
  userName: string;
  organizationName: string;
  /** The plan's name as a sentence says it: "Starter", "Business". */
  planLabel: string;
  addOns: number;
  /** The plan and Add-ons together, per month: "$25.00". */
  monthly: string | null;
  endsOn: string;
  billingUrl: string;
}

/** "Starter", or "Business with 2 Add-ons". */
function heldOf(planLabel: string, addOns: number): string {
  if (addOns === 0) return planLabel;
  return `${planLabel} with ${addOns} Add-on${addOns === 1 ? '' : 's'}`;
}

export async function renderTrialStartedEmail(
  facts: TrialEmailFacts,
): Promise<RenderedEmail> {
  const org = facts.organizationName;
  const held = heldOf(facts.planLabel, facts.addOns);
  const after = facts.monthly
    ? `From ${facts.endsOn} you will be charged ${facts.monthly} per month for ${held}, unless you cancel before then.`
    : `From ${facts.endsOn} you will be charged monthly for ${held}, unless you cancel before then; the Billing page shows the amount.`;
  return {
    subject: `Your 30-day Cloudgate free trial for ${org} has started`,
    html: await render(
      LapseNoticeTemplate({
        userName: facts.userName || 'User',
        heading: 'Your free trial has started',
        paragraphs: [
          `${org} is on a 30-day free trial of the ${facts.planLabel} plan. Nothing is charged until it ends on ${facts.endsOn}.`,
          after,
          'To cancel, open Settings > Billing and choose "Cancel trial". A trial cancelled before it ends is never charged.',
        ],
        action: { label: 'Open Billing', url: facts.billingUrl },
      }),
    ),
    inlineImages: [emailLogoAttachment('dark')],
  };
}

export async function renderTrialEndingEmail(
  facts: TrialEmailFacts,
): Promise<RenderedEmail> {
  const org = facts.organizationName;
  const held = heldOf(facts.planLabel, facts.addOns);
  const charge = facts.monthly
    ? `On ${facts.endsOn} you will be charged ${facts.monthly} for the first month of ${held}, what ${org} holds now.`
    : `On ${facts.endsOn} you will be charged for the first month of ${held}, what ${org} holds now; the Billing page shows the amount.`;
  return {
    subject: `Your Cloudgate free trial for ${org} ends in 7 days`,
    html: await render(
      LapseNoticeTemplate({
        userName: facts.userName || 'User',
        heading: 'Your free trial ends in 7 days',
        paragraphs: [
          `${org}'s free trial ends on ${facts.endsOn}.`,
          charge,
          'To change the plan or Add-ons, or to cancel without being charged, open Billing before then.',
        ],
        action: { label: 'Open Billing', url: facts.billingUrl },
      }),
    ),
    inlineImages: [emailLogoAttachment('dark')],
  };
}

/**
 * A **Bought Server**'s paid change that could not be made (spec #1387):
 * Cloudgate asked twice, then refunded the payment in full and kept the
 * Server as it was. `attempted` says what was asked for, as a verb phrase
 * ("turn on backups for web-1"). Sent to the owners. It never names the
 * provider.
 */
export async function renderBoughtServerChangeRefundedEmail({
  userName,
  serverName,
  attempted,
  amount,
  refundedTo = 'card',
  serverUrl,
}: {
  userName: string;
  serverName: string;
  attempted: string;
  /** What was refunded, formatted; null when the payment held no amount. */
  amount: string | null;
  refundedTo?: RefundedTo;
  serverUrl: string;
}): Promise<RenderedEmail> {
  return {
    subject: `We couldn't ${attempted}, so the payment was refunded`,
    html: await render(
      LapseNoticeTemplate({
        audience: 'owners',
        userName: userName || 'User',
        heading: 'Your change could not be made',
        paragraphs: [
          `We tried twice to ${attempted}, and it could not be done.`,
          refundedToSentence(
            amount ? `The ${amount} paid for it` : 'Its payment',
            refundedTo,
          ),
          `${serverName} is as it was before the change, and keeps running. You can try again from its Settings.`,
        ],
        action: { label: 'Open the Server', url: serverUrl },
      }),
    ),
    inlineImages: [emailLogoAttachment('dark')],
  };
}

/**
 * To every Operator when a **Bought Server**'s first Setup run fails (spec
 * #1387): the run the backend started by itself after Buy, failed on the
 * machine or cut off by a restart twice. The customer sees Setup failed and
 * *Run setup* on the Server's Setup card; this lets Octabyte help before the
 * customer leaves. Nothing is refunded. Like every Bought Server email, it
 * never names the provider.
 */
export async function renderBoughtServerSetupFailedEmail({
  userName,
  organizationName,
  serverName,
  serverId,
  failure,
  operatorUrl,
}: {
  userName: string;
  organizationName: string;
  serverName: string;
  serverId: string;
  /** The failure in the run's own words. */
  failure: string;
  operatorUrl: string;
}): Promise<RenderedEmail> {
  return {
    subject: `First setup failed on ${organizationName}'s Bought Server ${serverName}`,
    html: await render(
      LapseNoticeTemplate({
        audience: 'operators',
        userName: userName || 'User',
        heading: 'A Bought Server failed its first setup',
        paragraphs: [
          `The first Setup run on ${serverName} (${serverId}), a Bought Server of ${organizationName}, failed: ${failure}`,
          'The customer sees Setup failed on the Server, with Run setup to try again. Nothing was refunded, and Cloudgate starts no further run by itself.',
          'You may want to look at it, or contact them, before they give up on it.',
        ],
        action: { label: 'Open the Operator page', url: operatorUrl },
      }),
    ),
    inlineImages: [emailLogoAttachment('dark')],
  };
}

/**
 * To every Operator when the hourly orphan check finds machines nothing owns
 * (spec #1387, #1402): machines in Octabyte's provider account carrying
 * Cloudgate's labels with no live Bought Server behind them. Each machine is
 * in one such email only, the first tick that finds it. Nothing is deleted
 * by itself, since a database restored from a backup leaves live machines
 * with no record too. Like every Bought Server email, it never names the
 * provider.
 */
export async function renderOrphanMachinesFoundEmail({
  userName,
  machines,
  operatorUrl,
}: {
  userName: string;
  /** Each as one line: its name, id, Location and labels. */
  machines: string[];
  operatorUrl: string;
}): Promise<RenderedEmail> {
  const one = machines.length === 1;
  return {
    subject: one
      ? 'A machine nothing owns was found'
      : `${machines.length} machines nothing owns were found`,
    html: await render(
      LapseNoticeTemplate({
        audience: 'operators',
        userName: userName || 'User',
        heading: one
          ? 'A machine nothing owns'
          : `${machines.length} machines nothing owns`,
        paragraphs: [
          one
            ? 'The hourly check found a machine carrying Cloudgate labels with no live Bought Server behind it. It is still running and still billed:'
            : 'The hourly check found machines carrying Cloudgate labels with no live Bought Server behind them. They are still running and still billed:',
          ...machines,
          "Nothing was deleted: after a database restored from a backup, they may be real customers' Servers. The Operator page lists each one with its labels and age, and a Delete button that also deletes its Volume and Primary IPs.",
        ],
        action: { label: 'Open the Operator page', url: operatorUrl },
      }),
    ),
    inlineImages: [emailLogoAttachment('dark')],
  };
}
