import { cancelAtOf } from '../../src/cloud/billing/billing.plans';
import {
  attachedStateOf,
  operatorPlanOf,
  operatorStateOf,
} from '../../src/operator/operator-state';
import type { OperatorStateFacts } from '../../src/operator/operator-state';

const AT = new Date('2026-12-05T00:00:00.000Z');
const SECONDS = AT.getTime() / 1000;

/** An Organization paying for Business through Stripe, nothing pending. */
function row(overrides: Partial<OperatorStateFacts> = {}): OperatorStateFacts {
  return {
    plan: 'business',
    status: 'active',
    stripeSubscriptionId: 'sub_1',
    enterprise: false,
    trialEndsAt: null,
    cancelAt: null,
    stripeScheduleId: null,
    downgradeAt: null,
    lapsedAt: null,
    suspendedAt: null,
    ...overrides,
  };
}

describe('operatorStateOf', () => {
  it('is none with no row, no subscription, or a first payment not yet made', () => {
    expect(operatorStateOf(null)).toEqual({ kind: 'none' });
    expect(
      operatorStateOf(
        row({ plan: null, status: null, stripeSubscriptionId: null }),
      ),
    ).toEqual({ kind: 'none' });
    expect(operatorStateOf(row({ status: 'incomplete' }))).toEqual({
      kind: 'none',
    });
  });

  it('is paid for an active subscription, and for Enterprise', () => {
    expect(operatorStateOf(row())).toEqual({ kind: 'paid' });
    expect(
      operatorStateOf(
        row({
          enterprise: true,
          plan: null,
          status: null,
          stripeSubscriptionId: null,
        }),
      ),
    ).toEqual({ kind: 'paid' });
  });

  it('is a trial with its end date while trialing', () => {
    expect(
      operatorStateOf(row({ status: 'trialing', trialEndsAt: AT })),
    ).toEqual({ kind: 'trial', endsAt: AT });
  });

  it('ends on the date a cancel takes effect, a cancelled trial included', () => {
    expect(operatorStateOf(row({ cancelAt: AT }))).toEqual({
      kind: 'ends',
      endsAt: AT,
    });
    expect(
      operatorStateOf(
        row({ status: 'trialing', trialEndsAt: AT, cancelAt: AT }),
      ),
    ).toEqual({ kind: 'ends', endsAt: AT });
  });

  it('moves to Starter on the date a waiting downgrade takes effect', () => {
    expect(
      operatorStateOf(
        row({ stripeScheduleId: 'sub_sched_1', downgradeAt: AT }),
      ),
    ).toEqual({ kind: 'moves-to-starter', on: AT });
  });

  it('is payment failing while Stripe retries, whatever else waits', () => {
    expect(operatorStateOf(row({ status: 'past_due', cancelAt: AT }))).toEqual({
      kind: 'payment-failing',
    });
    expect(operatorStateOf(row({ status: 'unpaid' }))).toEqual({
      kind: 'payment-failing',
    });
  });

  it('is lapsed once the plan ended, and suspended above everything', () => {
    expect(operatorStateOf(row({ status: 'canceled', lapsedAt: AT }))).toEqual({
      kind: 'lapsed',
    });
    expect(
      operatorStateOf(
        row({ status: 'canceled', lapsedAt: AT, suspendedAt: AT }),
      ),
    ).toEqual({ kind: 'suspended' });
    expect(operatorStateOf(row({ suspendedAt: AT }))).toEqual({
      kind: 'suspended',
    });
  });
});

describe('attachedStateOf', () => {
  /** An Attached Organization's own row: no plan, only what is its own. */
  const own = (overrides: Partial<OperatorStateFacts> = {}) =>
    row({
      plan: null,
      status: null,
      stripeSubscriptionId: null,
      ...overrides,
    });

  it("is its Paying Organization's when it has none of its own", () => {
    expect(attachedStateOf(own(), row())).toEqual({ kind: 'paid' });
    expect(attachedStateOf(null, row({ status: 'past_due' }))).toEqual({
      kind: 'payment-failing',
    });
    expect(
      attachedStateOf(own(), row({ status: 'trialing', trialEndsAt: AT })),
    ).toEqual({ kind: 'trial', endsAt: AT });
    expect(attachedStateOf(own(), row({ lapsedAt: AT }))).toEqual({
      kind: 'lapsed',
    });
    expect(attachedStateOf(own(), null)).toEqual({ kind: 'none' });
  });

  it('is its own when it is suspended, or lapsed after "Stop paying for it"', () => {
    expect(attachedStateOf(own({ suspendedAt: AT }), row())).toEqual({
      kind: 'suspended',
    });
    expect(attachedStateOf(own({ lapsedAt: AT }), row())).toEqual({
      kind: 'lapsed',
    });
  });

  it("is not suspended by its Paying Organization's suspension, which stays on the payer", () => {
    expect(attachedStateOf(own(), row({ suspendedAt: AT }))).toEqual({
      kind: 'paid',
    });
    expect(
      attachedStateOf(own(), row({ suspendedAt: AT, lapsedAt: AT })),
    ).toEqual({ kind: 'lapsed' });
  });
});

describe('operatorPlanOf', () => {
  it('names the Stripe plan held, Enterprise, or none', () => {
    expect(operatorPlanOf(row({ plan: 'starter' }))).toBe('starter');
    expect(operatorPlanOf(row({ status: 'past_due' }))).toBe('business');
    expect(operatorPlanOf(row({ suspendedAt: AT }))).toBe('business');
    expect(operatorPlanOf(row({ enterprise: true }))).toBe('enterprise');
    expect(operatorPlanOf(row({ status: 'canceled', lapsedAt: AT }))).toBe(
      null,
    );
    expect(operatorPlanOf(row({ status: 'incomplete' }))).toBe(null);
    expect(operatorPlanOf(null)).toBe(null);
  });
});

describe('cancelAtOf', () => {
  it('reads cancel_at, else the end of the trial or the period being cancelled', () => {
    expect(cancelAtOf({ status: 'active', cancel_at: SECONDS })).toEqual(AT);
    expect(
      cancelAtOf({
        status: 'trialing',
        cancel_at_period_end: true,
        trial_end: SECONDS,
      }),
    ).toEqual(AT);
    expect(
      cancelAtOf({
        status: 'active',
        cancel_at_period_end: true,
        items: { data: [{ current_period_end: SECONDS }] },
      }),
    ).toEqual(AT);
    expect(cancelAtOf({ status: 'active', cancel_at: null })).toBeNull();
  });
});
