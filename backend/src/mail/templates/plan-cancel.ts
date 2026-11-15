import type { RenderedEmail } from './index';
import { renderConfirmationEmail } from './confirmation';

/** "the Business plan for Hopper Labs", or "the plan for…" when unknown. */
function planOf(planLabel: string | null, organizationName: string): string {
  return `the ${planLabel ? `${planLabel} ` : ''}plan for ${organizationName}`;
}

/**
 * The plan was cancelled (spec #69, #72): through the billing page at the
 * provider of payments, or *Cancel trial*. It names the day it ends and the
 * Bought Servers deleted that day, which take their data and backups with
 * them. The 7-day warning before that day is a separate email.
 */
export async function renderPlanEndsEmail({
  userName,
  organizationName,
  planLabel,
  endsOn,
  serverNames,
  billingUrl,
}: {
  userName: string;
  organizationName: string;
  planLabel: string | null;
  endsOn: string;
  serverNames: readonly string[];
  billingUrl: string;
}): Promise<RenderedEmail> {
  const plan = planOf(planLabel, organizationName);
  const one = serverNames.length === 1;
  const servers =
    serverNames.length === 0
      ? []
      : [
          one
            ? `The Server you bought for ${organizationName} is deleted that day, and its data and backups go with it: ${serverNames[0]}.`
            : `The Servers you bought for ${organizationName} are deleted that day, and their data and backups go with them: ${serverNames.join(', ')}.`,
        ];
  return renderConfirmationEmail(userName, {
    subject: `Your plan ends on ${endsOn}`,
    heading: `Your plan ends on ${endsOn}`,
    paragraphs: [
      `${capitalized(plan)} is cancelled and ends on ${endsOn}. Until then, everything works as it does now.`,
      ...servers,
      'To keep the plan, resume it under Settings > Billing before then.',
    ],
    action: { label: 'Open Billing', url: billingUrl },
  });
}

/**
 * A cancelled plan's cancel was taken back (spec #69, #72): *Keep <plan>*,
 * or at the provider of payments' billing page. The plan no longer ends.
 */
export async function renderPlanCarriesOnEmail({
  userName,
  organizationName,
  planLabel,
  billingUrl,
}: {
  userName: string;
  organizationName: string;
  planLabel: string | null;
  billingUrl: string;
}): Promise<RenderedEmail> {
  return renderConfirmationEmail(userName, {
    subject: 'Your plan will carry on',
    heading: 'Your plan will carry on',
    paragraphs: [
      `The cancel of ${planOf(planLabel, organizationName)} was taken back: the plan no longer ends, and carries on as before.`,
    ],
    action: { label: 'Open Billing', url: billingUrl },
  });
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
