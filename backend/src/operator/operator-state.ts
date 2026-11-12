import { PLAN_GRANTING_STATUSES } from '../cloud/billing/billing-allowance';
import type { PlanName } from '../cloud/billing/billing.plans';
import type { Subscription } from '../cloud/billing/billing.schema';
import { trialEndsAtOf } from '../cloud/billing/free-trial';

/**
 * The Plan and State the Operator page shows for an Organization (ADR-0054),
 * derived from Cloudgate's own `subscription` row so an Operator never
 * reads a Stripe status verbatim. Pure, like `frozen.ts`'s `standingOf`.
 */

/** The plan an Organization holds now; Enterprise is shown as its own. */
export type OperatorPlan = PlanName | 'enterprise';

/**
 * Where an Organization stands — one fact, with the date it needs:
 *
 * - `trial`: on its free trial, which ends (and first charges) on `endsAt`;
 * - `ends`: set to end on `endsAt` — a cancel at the end of the month or of
 *   the trial;
 * - `moves-to-starter`: a downgrade from Business waits for `on`;
 * - `paid`: paying, through Stripe or by an Enterprise agreement;
 * - `payment-failing`: Stripe is retrying a failed payment;
 * - `lapsed`: its plan ended, so it is frozen (ADR-0052);
 * - `suspended`: an Operator suspended it;
 * - `none`: it has never held a plan, or holds one that grants nothing yet
 *   (a first payment still incomplete).
 */
export type OperatorState =
  | { kind: 'trial'; endsAt: Date }
  | { kind: 'ends'; endsAt: Date }
  | { kind: 'moves-to-starter'; on: Date }
  | { kind: 'paid' }
  | { kind: 'payment-failing' }
  | { kind: 'lapsed' }
  | { kind: 'suspended' }
  | { kind: 'none' };

/** The parts of the `subscription` row the Plan and State read. */
export type OperatorStateFacts = Pick<
  Subscription,
  | 'plan'
  | 'status'
  | 'stripeSubscriptionId'
  | 'enterprise'
  | 'trialEndsAt'
  | 'cancelAt'
  | 'stripeScheduleId'
  | 'downgradeAt'
  | 'lapsedAt'
  | 'suspendedAt'
>;

/** Statuses under which a payment has failed and is not yet given up on. */
const FAILING_STATUSES = new Set(['past_due', 'unpaid']);
const GRANTING_STATUSES = new Set(PLAN_GRANTING_STATUSES);

/**
 * The Stripe plan the row holds now, or null: a subscription that grants its
 * plan or whose payment is failing, and has not lapsed.
 */
function stripePlanOf(row: OperatorStateFacts): PlanName | null {
  if (row.lapsedAt || !row.stripeSubscriptionId || !row.plan || !row.status) {
    return null;
  }
  return GRANTING_STATUSES.has(row.status) || FAILING_STATUSES.has(row.status)
    ? row.plan
    : null;
}

/**
 * The one State an Organization's row shows. A suspension is named first, as
 * it freezes whatever else holds; then a lapse; then an Enterprise agreement,
 * which Stripe never bills. For a Stripe plan a failing payment comes before
 * a set end, a set end before a waiting downgrade, and a trial before plain
 * paying.
 */
export function operatorStateOf(row: OperatorStateFacts | null): OperatorState {
  if (!row) return { kind: 'none' };
  if (row.suspendedAt) return { kind: 'suspended' };
  if (row.lapsedAt) return { kind: 'lapsed' };
  if (row.enterprise) return { kind: 'paid' };
  if (!stripePlanOf(row)) return { kind: 'none' };
  if (FAILING_STATUSES.has(row.status ?? '')) {
    return { kind: 'payment-failing' };
  }
  if (row.cancelAt) return { kind: 'ends', endsAt: row.cancelAt };
  if (row.stripeScheduleId && row.downgradeAt) {
    return { kind: 'moves-to-starter', on: row.downgradeAt };
  }
  const trialEndsAt = trialEndsAtOf(row);
  if (trialEndsAt) return { kind: 'trial', endsAt: trialEndsAt };
  return { kind: 'paid' };
}

/**
 * The State of an **Attached Organization** (ADR-0059): its own when it has
 * one — "Suspended" by an Operator, or "Lapsed" after "Stop paying for it",
 * the only two things its own row can hold — and otherwise its Paying
 * Organization's, whose plan is what it runs on.
 *
 * The payer's suspension is left out: suspension stays on one Organization,
 * so an Attached Organization keeps running while its payer is suspended
 * and is not shown as suspended. The payer's lapse is not left out, since a
 * lapse freezes every Organization it pays for.
 */
export function attachedStateOf(
  own: OperatorStateFacts | null,
  payer: OperatorStateFacts | null,
): OperatorState {
  const its = operatorStateOf(own);
  if (its.kind === 'suspended' || its.kind === 'lapsed') return its;
  return operatorStateOf(payer && { ...payer, suspendedAt: null });
}

/**
 * The plan an Organization holds now, or null for None: Enterprise while the
 * marker is on, else the Stripe plan while it holds one — a suspension leaves
 * it as it is, a lapse ends it.
 */
export function operatorPlanOf(
  row: OperatorStateFacts | null,
): OperatorPlan | null {
  if (!row) return null;
  if (row.enterprise) return 'enterprise';
  return stripePlanOf(row);
}
