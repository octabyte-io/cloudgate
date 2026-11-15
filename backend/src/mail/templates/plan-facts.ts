import { HOSTED_PLAN_INCLUDES } from '../../cloud/billing/billing.plans';

/**
 * What an Organization holds on its **Hosted plan** after a change, and what
 * it is charged for it, already formatted: the facts block the plan and
 * Add-on confirmations of spec #69 share ("Your plan changed", "Your Add-ons
 * changed"). The service side builds it with
 * `PlanChangeNotifications.planFactsOf`.
 */
export interface PlanFacts {
  /** The plan's name as a sentence says it: "Starter", "Business". */
  planLabel: string;
  addOns: number;
  /** The plan and its Add-ons together, per month: "$45.00"; null when Stripe's prices could not be read. */
  monthly: string | null;
  /** The day that monthly amount is charged from: "Dec 15, 2026". */
  from: string;
}

/** "Starter", or "Business with 2 Add-ons". */
export function heldOf(planLabel: string, addOns: number): string {
  if (addOns === 0) return planLabel;
  return `${planLabel} with ${addOns} Add-on${addOns === 1 ? '' : 's'}`;
}

/**
 * The block's two paragraphs: the plan with its Add-ons and the counts they
 * give, then the monthly amount and the day it is charged from. With no
 * amount it points at the Billing page rather than quoting a wrong one.
 */
export function planFactsParagraphs(facts: PlanFacts): string[] {
  const count = HOSTED_PLAN_INCLUDES + facts.addOns;
  return [
    `Plan: ${heldOf(facts.planLabel, facts.addOns)}, for ${count} Servers and ${count} Cloud Environments.`,
    facts.monthly
      ? `Charged: ${facts.monthly} per month, from ${facts.from}.`
      : `Charged: monthly, from ${facts.from}. The Billing page shows the amount.`,
  ];
}
