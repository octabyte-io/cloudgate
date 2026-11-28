import { renderConfirmationEmail } from './confirmation';
import type { RenderedEmail } from './index';
import { planFactsParagraphs } from './plan-facts';
import type { PlanFacts } from './plan-facts';

/**
 * How the new count is charged: prorated over the rest of the month, free
 * during the **Free trial**, or prorated while a move to Starter waits, the
 * count then carrying across the move on `movesOn` (formatted). While the
 * move waits, `businessMonthly` is what Business with the new count costs
 * per month until then (formatted), or null when it cannot be read.
 */
export type AddOnsChangeCharge =
  | { kind: 'prorated' }
  | { kind: 'trial' }
  | {
      kind: 'move-waiting';
      movesOn: string;
      businessMonthly: string | null;
    };

/**
 * "Your Add-ons changed" (spec #69, #74), to every owner and admin: the
 * count before and after, how the change is charged, then the plan as it
 * stands with the new count and its monthly amount ({@link planFactsParagraphs}).
 */
export async function renderAddOnsChangedEmail({
  userName,
  organizationName: org,
  was,
  change,
  plan,
  billingUrl,
}: {
  userName: string;
  organizationName: string;
  /** The count before the change. */
  was: number;
  change: AddOnsChangeCharge;
  /** The plan with the new count; while a move waits, Starter from its date. */
  plan: PlanFacts;
  billingUrl: string;
}): Promise<RenderedEmail> {
  const now = countOf(plan.addOns);
  const went = `${org} went from ${countOf(was)} to ${now} today.`;
  const opening =
    change.kind === 'trial'
      ? // "for them": a Bought Server is charged at once even during the
        // trial (ADR-0071), so only the Add-ons are promised free.
        [
          `${went} Add-ons cost nothing during the free trial: nothing is charged for them until it ends.`,
        ]
      : [
          `${went} The rest of this month is prorated: the difference is on the next invoice.`,
          ...(change.kind === 'move-waiting'
            ? [
                `${org} keeps Business until ${change.movesOn}, then moves to Starter with ${now}.`,
                ...(change.businessMonthly
                  ? [
                      `Until then, Business with ${now} costs ${change.businessMonthly} per month.`,
                    ]
                  : []),
              ]
            : []),
        ];
  return renderConfirmationEmail(userName, {
    about: 'billing',
    subject: `Your Add-ons changed: ${org} now has ${now}`,
    heading: `${org} now has ${now}`,
    paragraphs: [...opening, ...planFactsParagraphs(plan)],
    action: { label: 'Open Billing', url: billingUrl },
  });
}

/** "no Add-ons", "1 Add-on", "4 Add-ons". */
function countOf(addOns: number): string {
  if (addOns === 0) return 'no Add-ons';
  return `${addOns} Add-on${addOns === 1 ? '' : 's'}`;
}
