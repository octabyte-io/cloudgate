/**
 * The Frozen Organization, as a rule (CONTEXT.md, ADR-0052): which
 * causes an Organization's billing state records, the one refusal every
 * refused write answers with, and what the banner every member sees says.
 * Pure, so the HTTP guard, the MCP dispatcher and the paths that start work
 * share one answer; `FrozenOrganizations` reads the row and asks it.
 *
 * Two causes, each recorded on its own and lifted only by its own trigger:
 * **lapsed** (the subscription is gone; a new active subscription lifts it)
 * and **suspended** (an Operator's act, ADR-0050; only an Operator lifts it).
 * Frozen means either is set. `past_due` is neither: Stripe is still
 * retrying, which brings the banner and freezes nothing.
 *
 * An **Attached Organization** (ADR-0059) is also lapsed while its
 * **Paying Organization** is: the payer's lapse is read through the link,
 * never copied onto the Attached Organization's own row, so paying again
 * lifts it for every Organization on the plan with nothing to undo. The
 * payer's suspension is never read — it stays on that one Organization.
 */

/** One recorded cause. A client branches on these (ADR-0005). */
export type FrozenCause = 'lapsed' | 'suspended';

/** The parts of the Organization's `subscription` row the rule reads. */
export interface FrozenStanding {
  status?: string | null;
  lapsedAt: Date | null;
  suspendedAt: Date | null;
  suspendedReason: string | null;
  /**
   * The Paying Organization's standing, when this is an Attached
   * Organization: its name, its Stripe status and its lapse — and nothing
   * else, so its suspension cannot reach here. Absent or null otherwise.
   */
  payingOrganization?: PayingStanding | null;
}

/** What an Attached Organization reads of its Paying Organization's row. */
export interface PayingStanding {
  name: string;
  status: string | null;
  lapsedAt: Date | null;
}

/** The code of every frozen refusal. */
export const ORGANIZATION_FROZEN_CODE = 'ORGANIZATION_FROZEN';

/** What each cause tells the member who was refused, verbatim. */
export const FROZEN_MESSAGES: Record<FrozenCause, string> = {
  lapsed: 'Pay to continue',
  suspended: 'Suspended. Contact Octabyte',
};

/**
 * The Stripe statuses that mean a payment failed and Stripe is still
 * retrying: the banner's first state (ADR-0052). Neither freezes anything.
 */
const PAYMENT_FAILED_STATUSES = new Set(['past_due', 'unpaid']);

/**
 * The causes `standing` records, suspension first: it is the one paying
 * cannot lift, so it leads the refusal. None for no row.
 */
export function frozenCausesOf(standing: FrozenStanding | null): FrozenCause[] {
  if (!standing) return [];
  const causes: FrozenCause[] = [];
  if (standing.suspendedAt) causes.push('suspended');
  if (lapsedAtOf(standing)) causes.push('lapsed');
  return causes;
}

/**
 * When the Organization lapsed: its own lapse or its Paying Organization's,
 * the earlier when both are recorded. Null when neither is.
 */
function lapsedAtOf(standing: FrozenStanding): Date | null {
  const lapses = [
    standing.lapsedAt,
    standing.payingOrganization?.lapsedAt ?? null,
  ].filter((at): at is Date => at !== null);
  if (lapses.length === 0) return null;
  return lapses.reduce((earliest, at) => (at < earliest ? at : earliest));
}

/**
 * The body of a frozen refusal (403). Only `code` and `message` reach the
 * client (`AllExceptionsFilter` publishes no other field), so the message
 * names every cause; the suspension's reason is on `GET /billing/standing`.
 */
export interface FrozenRefusal {
  code: typeof ORGANIZATION_FROZEN_CODE;
  /** Each cause's sentence, joined: "Suspended. Contact Octabyte. Pay to continue". */
  message: string;
}

/** The refusal for a write while `standing` is frozen, or null when it is not. */
export function frozenRefusal(
  standing: FrozenStanding | null,
): FrozenRefusal | null {
  const causes = frozenCausesOf(standing);
  if (causes.length === 0) return null;
  return {
    code: ORGANIZATION_FROZEN_CODE,
    message: causes.map((cause) => FROZEN_MESSAGES[cause]).join('. '),
  };
}

/**
 * What every member's banner reads off (GET /billing/standing): the causes,
 * and whether a payment has failed while Stripe retries. The banner shows from
 * the first failed payment until the Organization is paid again — `frozen` or
 * `paymentFailed` — and names each cause.
 */
export interface StandingView {
  frozen: boolean;
  causes: FrozenCause[];
  paymentFailed: boolean;
  lapsedAt: Date | null;
  suspendedReason: string | null;
  /**
   * For an Attached Organization, its Paying Organization's name and whether
   * that payer's payment is failing while Stripe retries: the one calm line
   * on the Attached Organization's Billing page ("<Paying>'s payment is
   * failing; only its owners and admins can fix it"). Its own `paymentFailed`
   * stays false, so its banner never asks its members to fix a card that is
   * not theirs. Null when the Organization pays for itself.
   */
  payingOrganization: { name: string; paymentFailed: boolean } | null;
}

export function standingOf(standing: FrozenStanding | null): StandingView {
  const causes = frozenCausesOf(standing);
  return {
    frozen: causes.length > 0,
    causes,
    paymentFailed: isPaymentFailing(standing?.status),
    lapsedAt: standing ? lapsedAtOf(standing) : null,
    suspendedReason: causes.includes('suspended')
      ? (standing?.suspendedReason ?? null)
      : null,
    payingOrganization: standing?.payingOrganization
      ? {
          name: standing.payingOrganization.name,
          paymentFailed: isPaymentFailing(standing.payingOrganization.status),
        }
      : null,
  };
}

function isPaymentFailing(status: string | null | undefined): boolean {
  return !!status && PAYMENT_FAILED_STATUSES.has(status);
}

/** A standing that records nothing: no row, or a Self-hosted instance. */
export const UNFROZEN: StandingView = standingOf(null);
