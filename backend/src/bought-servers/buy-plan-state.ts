import type Stripe from 'stripe';
import { OCTABYTE_CONTACT } from '../cloud/billing/contact';

/**
 * Which plan state a Bought Server is bought in (#1392), pure: what Buy
 * charges on, or why it is refused.
 *
 * - **No plan**: Checkout starts Starter (in its Free trial when the
 *   Organization and the person are eligible), and the Server is charged
 *   once it completes.
 * - **On a plan** (`active`): the Server joins the subscription, charged
 *   today.
 * - **In the Free trial** (`trialing`): the Server is charged on its own
 *   invoice, to the trial's end.
 *
 * Refused: **Enterprise**, billed by agreement outside Stripe (an
 * Organization holds Enterprise or a subscription, never both, ADR-0054);
 * and a plan whose payment is overdue (`past_due` and the rest), since a
 * Server is paid in advance (ADR-0071).
 */
export type BuyPlanKind =
  | { kind: 'none' }
  | { kind: 'plan' }
  | { kind: 'trial' }
  | { kind: 'refused'; code: string; message: string };

export const BUY_NOT_AVAILABLE_CODE = 'BUY_NOT_AVAILABLE';
export const BILLED_BY_AGREEMENT = `This Organization is billed by agreement. Contact us at ${OCTABYTE_CONTACT} to buy a Server`;
export const PAY_OPEN_INVOICE_FIRST_CODE = 'PAY_OPEN_INVOICE_FIRST';
export const PAY_OPEN_INVOICE_FIRST = 'Pay the open invoice first';

export function buyPlanStateOf(input: {
  /** The Paying Organization is Enterprise. */
  enterprise: boolean;
  /** The Paying Organization holds a plan that grants its counts, with a Stripe subscription. */
  hasPlan: boolean;
  /** That subscription's live Stripe status. */
  status: Stripe.Subscription.Status | null;
}): BuyPlanKind {
  if (input.enterprise) {
    return {
      kind: 'refused',
      code: BUY_NOT_AVAILABLE_CODE,
      message: BILLED_BY_AGREEMENT,
    };
  }
  if (!input.hasPlan) return { kind: 'none' };
  if (input.status === 'active') return { kind: 'plan' };
  if (input.status === 'trialing') return { kind: 'trial' };
  return {
    kind: 'refused',
    code: PAY_OPEN_INVOICE_FIRST_CODE,
    message: PAY_OPEN_INVOICE_FIRST,
  };
}

/** The plan state with the live subscription a purchase is charged on. */
export type BuyPlanState =
  | { kind: 'none' }
  | { kind: 'plan'; current: Stripe.Subscription }
  | { kind: 'trial'; current: Stripe.Subscription };
