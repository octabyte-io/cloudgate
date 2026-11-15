import type { PlanName } from '../../cloud/billing/billing.plans';
import { renderConfirmationEmail } from './confirmation';
import type { RenderedEmail } from './index';
import { planFactsParagraphs } from './plan-facts';
import type { PlanFacts } from './plan-facts';

/**
 * What changed the plan, with its dates and amounts formatted: an upgrade
 * (charged today, prorated), a move to Starter being scheduled, that move
 * taking effect, *Keep Business* taking it back, and a switch either way
 * during the **Free trial**.
 */
export type PlanChangedFacts =
  | { kind: 'upgraded'; chargedToday: string | null }
  | { kind: 'move-scheduled'; movesOn: string }
  | { kind: 'moved' }
  | { kind: 'kept-business' }
  | { kind: 'trial-switch'; to: PlanName; trialEndsOn: string };

const PAID_FEATURES = 'SSO, SCIM, custom roles and forward auth';
const FEATURES_ON = `${PAID_FEATURES} work now.`;
const FEATURES_OFF = `${PAID_FEATURES} no longer work; their settings are kept.`;

/**
 * "Your plan changed" (spec #69, #73), to every owner and admin: what the
 * change was, then the plan as it now stands or will stand, with its Add-ons
 * and what is charged from when ({@link planFactsParagraphs}).
 */
export async function renderPlanChangedEmail({
  userName,
  organizationName: org,
  change,
  plan,
  billingUrl,
}: {
  userName: string;
  organizationName: string;
  change: PlanChangedFacts;
  /** The plan after the change; for a scheduled move, Starter from its date. */
  plan: PlanFacts;
  billingUrl: string;
}): Promise<RenderedEmail> {
  const { subject, heading, opening, closing } = wordingOf(
    org,
    change,
    plan.planLabel,
  );
  return renderConfirmationEmail(userName, {
    subject,
    heading,
    paragraphs: [...opening, ...planFactsParagraphs(plan), ...closing],
    action: { label: 'Open Billing', url: billingUrl },
  });
}

function wordingOf(
  org: string,
  change: PlanChangedFacts,
  planLabel: string,
): { subject: string; heading: string; opening: string[]; closing: string[] } {
  const nowOn = {
    subject: `Your plan changed: ${org} is now on ${planLabel}`,
    heading: `${org} is now on ${planLabel}`,
    closing: [],
  };
  switch (change.kind) {
    case 'upgraded':
      return {
        ...nowOn,
        opening: [
          `${org} moved from Starter to Business today. ${FEATURES_ON}`,
          change.chargedToday
            ? `Charged today: ${change.chargedToday}, for the rest of this month on Business, less what was left of Starter.`
            : 'Charged today: the rest of this month on Business, less what was left of Starter. The Billing page has the invoice.',
        ],
      };
    case 'moved':
      return {
        ...nowOn,
        opening: [
          `${org} moved from Business to Starter today. ${FEATURES_OFF}`,
        ],
      };
    case 'trial-switch':
      return {
        ...nowOn,
        opening: [
          `${org} switched to ${planLabel} during its free trial. ${
            change.to === 'business' ? FEATURES_ON : FEATURES_OFF
          } Nothing is charged until the trial ends on ${change.trialEndsOn}.`,
        ],
      };
    case 'move-scheduled':
      return {
        subject: `Your plan changed: ${org} moves to Starter on ${change.movesOn}`,
        heading: `${org} moves to Starter on ${change.movesOn}`,
        opening: [
          `${org} keeps Business, with ${PAID_FEATURES}, until ${change.movesOn}, then moves to Starter. Nothing is charged for the move.`,
        ],
        closing: [
          'To stay on Business, open Billing and choose Keep Business before then.',
        ],
      };
    case 'kept-business':
      return {
        subject: `Your plan changed: ${org} stays on Business`,
        heading: 'You stay on Business',
        opening: [
          `The move of ${org} to Starter was taken back: it stays on Business, with ${PAID_FEATURES}. Nothing is charged for the change.`,
        ],
        closing: [],
      };
  }
}
