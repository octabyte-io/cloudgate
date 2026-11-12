import { HOSTED_PLAN_INCLUDES } from './billing.plans';
import type { PlanName } from './billing.plans';
import { OCTABYTE_CONTACT } from './contact';

/**
 * The allowance check (ADR-0048): what an Organization's billing state
 * allows, what it already uses, and the one refusal every counted addition
 * goes through. Pure, so the rule is one function the Server create, the cloud
 * Deploy target and the Project config apply all share.
 *
 * A full count refuses only the next addition. Nothing here, or anywhere,
 * stops what an Organization already has.
 */

/**
 * The Stripe statuses under which a subscription still grants its plan.
 * `past_due` is one: a failed card freezes nothing while Stripe retries
 * (ADR-0052). `canceled`, `unpaid`, `incomplete`, `incomplete_expired` and
 * `paused` grant nothing.
 */
export const PLAN_GRANTING_STATUSES: readonly string[] = [
  'active',
  'trialing',
  'past_due',
];
const GRANTING = new Set(PLAN_GRANTING_STATUSES);

/**
 * The Stripe statuses of a subscription in good standing: paid, or in its
 * free trial. One of them lifts a lapse (the webhook's sync), and only under
 * one can the Add-ons or the plan be changed (BillingService). `past_due`
 * still grants the plan but is neither: Stripe is still retrying.
 */
export const PAID_STATUSES: readonly string[] = ['active', 'trialing'];
const PAID = new Set(PAID_STATUSES);

/** Whether a Stripe status is one of {@link PAID_STATUSES}. */
export function isPaidStatus(status: string | null | undefined): boolean {
  return !!status && PAID.has(status);
}

/** The parts of the Organization's `subscription` row the allowance reads. */
export interface BillingStanding {
  plan: PlanName | null;
  status: string | null;
  addOns: number;
  /** The Enterprise marker. Absent reads as not Enterprise. */
  enterprise?: boolean;
  /** An Enterprise Organization's hand-set counts. */
  enterpriseServers?: number;
  enterpriseCloudEnvironments?: number;
}

/**
 * What grants an allowance: Starter or Business, or Enterprise — an agreement
 * outside Stripe whose counts an Operator sets (CONTEXT.md, ADR-0048,
 * ADR-0054).
 */
export type AllowanceSource = PlanName | 'enterprise';

/** What an Organization may hold. */
export interface Allowance {
  /** What grants it, or null: no plan, and nothing allowed. */
  plan: AllowanceSource | null;
  servers: number;
  cloudEnvironments: number;
}

/**
 * What an Organization already holds, per counted kind; every kind here is one
 * `assertRoomFor` can be asked about and one `minimumAddOns` covers.
 * `cloudEnvironments` is `cloudEnvironmentsOf`'s count.
 */
export interface Usage {
  servers: number;
  cloudEnvironments: number;
}

export type CountedKind = keyof Usage;

/**
 * An Enterprise Organization's hand-set counts, whatever its Stripe state says
 * (Enterprise never lapses through Stripe); otherwise `3 + addOns` of each with
 * the plan, 0/0 without one.
 */
export function allowanceOf(standing: BillingStanding | null): Allowance {
  if (standing?.enterprise) {
    return {
      plan: 'enterprise',
      servers: Math.max(0, standing.enterpriseServers ?? 0),
      cloudEnvironments: Math.max(0, standing.enterpriseCloudEnvironments ?? 0),
    };
  }
  const granted =
    !!standing?.plan && !!standing.status && GRANTING.has(standing.status);
  if (!granted) return { plan: null, servers: 0, cloudEnvironments: 0 };
  const count = HOSTED_PLAN_INCLUDES + Math.max(0, standing.addOns);
  return { plan: standing.plan, servers: count, cloudEnvironments: count };
}

/**
 * Whether the paid features (SSO, SCIM, custom roles, forward auth) come with
 * what the Organization holds on the Hosted instance (ADR-0054): Business under
 * a status that still grants it, or Enterprise, which always counts as
 * Business. Starter, and no plan, do not.
 */
export function grantsPaidFeatures(standing: BillingStanding | null): boolean {
  const { plan } = allowanceOf(standing);
  return plan === 'business' || plan === 'enterprise';
}

/**
 * The fewest Add-ons that cover what the Organization already uses, beyond the
 * plan's base 3. Checkout and the console's Add-on picker never go below it.
 */
export function minimumAddOns(usage: Usage): number {
  const counts: number[] = Object.values(usage as Record<CountedKind, number>);
  const most = Math.max(0, ...counts);
  return Math.max(0, most - HOSTED_PLAN_INCLUDES);
}

/** The codes a client branches on (ADR-0005). */
export type AllowanceRefusalCode = 'PLAN_REQUIRED' | 'ALLOWANCE_FULL';

export interface AllowanceRefusal {
  code: AllowanceRefusalCode;
  message: string;
}

/** Each counted kind in words: singular, plural. */
const NOUNS: Record<CountedKind, [string, string]> = {
  servers: ['Server', 'Servers'],
  cloudEnvironments: ['Cloud Environment', 'Cloud Environments'],
};

function counted(count: number, kind: CountedKind): string {
  const [one, many] = NOUNS[kind];
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Why one more of `kind` is refused, or null when there is room.
 *
 * With no plan the answer is "choose a plan"; with a full count it points at
 * the Add-on, which raises every count by one — or, for Enterprise, whose
 * counts are set by agreement, at Octabyte.
 */
export function refusalFor(
  kind: CountedKind,
  allowance: Allowance,
  usage: Usage,
): AllowanceRefusal | null {
  const [one] = NOUNS[kind];
  if (!allowance.plan) {
    return {
      code: 'PLAN_REQUIRED',
      message:
        `Choose a plan to add a ${one}. Starter and Business each include ` +
        `${HOSTED_PLAN_INCLUDES} Servers and ${HOSTED_PLAN_INCLUDES} Cloud ` +
        'Environments; choose one under Settings > Billing.',
    };
  }
  const allowed = allowance[kind];
  if (usage[kind] < allowed) return null;
  if (allowance.plan === 'enterprise') {
    return {
      code: 'ALLOWANCE_FULL',
      message:
        `This Organization has ${counted(usage[kind], kind)}, all its ` +
        `Enterprise agreement allows. Contact us at ${OCTABYTE_CONTACT} to raise its counts.`,
    };
  }
  return {
    code: 'ALLOWANCE_FULL',
    message:
      `This Organization has ${counted(usage[kind], kind)}, all its plan ` +
      `allows. Buy an Add-on for one more Server and one more Cloud ` +
      'Environment under Settings > Billing.',
  };
}
