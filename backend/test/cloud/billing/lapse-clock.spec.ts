import {
  deletionDueAt,
  dueStep,
  lapseDueAt,
  lapseNoticeOf,
  trialReminderDue,
} from '../../../src/cloud/billing/lapse-clock';
import type { TrialReminderMarks } from '../../../src/cloud/billing/lapse-clock';
import type { ClockMarks } from '../../../src/cloud/billing/lapse-clock';

// The deletion clock as a rule (ADR-0052): which time-based step a
// daily tick owes an Organization, given its billing marks and the moment.

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-03-01T10:00:00Z');
const day = (n: number) => new Date(T0.getTime() + n * DAY);

const marks = (over: Partial<ClockMarks> = {}): ClockMarks => ({
  status: 'active',
  paymentFailedAt: null,
  lapseWarnedAt: null,
  lapsedAt: null,
  deletionWarnedAt: null,
  suspendedAt: null,
  ...over,
});

describe('dueStep, the deletion clock', () => {
  it('owes nothing to an Organization in good standing', () => {
    expect(dueStep(marks(), day(400))).toBeNull();
  });

  describe('while Stripe retries a failed payment', () => {
    const failing = marks({ status: 'past_due', paymentFailedAt: T0 });

    it('expects the lapse two weeks after the first failure', () => {
      expect(lapseDueAt(failing)).toEqual(day(14));
    });

    it('warns 3 days before the lapse, not before', () => {
      expect(dueStep(failing, day(10.9))).toBeNull();
      expect(dueStep(failing, day(11))).toBe('warn-lapse');
      expect(dueStep(failing, day(13))).toBe('warn-lapse');
    });

    it('warns once', () => {
      expect(dueStep({ ...failing, lapseWarnedAt: day(11) }, day(13))).toBe(
        null,
      );
    });

    it('owes nothing once the payment went through', () => {
      expect(dueStep({ ...failing, status: 'active' }, day(12))).toBeNull();
    });
  });

  describe('after the lapse', () => {
    const lapsed = marks({ status: 'canceled', lapsedAt: T0 });

    it('warns 7 days before deletion, not before', () => {
      expect(dueStep(lapsed, day(22.9))).toBeNull();
      expect(dueStep(lapsed, day(23))).toBe('warn-deletion');
    });

    it('deletes on day 30 once the warning is 7 days old', () => {
      const warned = { ...lapsed, deletionWarnedAt: day(23) };
      expect(dueStep(warned, day(29.9))).toBeNull();
      expect(dueStep(warned, day(30))).toBe('delete');
      expect(deletionDueAt(warned)).toEqual(day(30));
    });

    it('never deletes without the warning: a late warning moves the day', () => {
      expect(dueStep(lapsed, day(45))).toBe('warn-deletion');
      const lateWarning = { ...lapsed, deletionWarnedAt: day(45) };
      expect(deletionDueAt(lateWarning)).toEqual(day(52));
      expect(dueStep(lateWarning, day(51))).toBeNull();
      expect(dueStep(lateWarning, day(52))).toBe('delete');
    });

    it('no longer warns of the lapse', () => {
      expect(
        dueStep(
          { ...lapsed, paymentFailedAt: T0, status: 'past_due' },
          day(12),
        ),
      ).toBeNull();
    });

    it('a suspension stops the clock', () => {
      const suspended = { ...lapsed, suspendedAt: day(5) };
      expect(dueStep(suspended, day(23))).toBeNull();
      expect(
        dueStep({ ...suspended, deletionWarnedAt: day(23) }, day(90)),
      ).toBeNull();
    });
  });
});

describe('lapseNoticeOf, the lapse email', () => {
  it('is "your plan has ended" after a cancel', () => {
    expect(lapseNoticeOf('cancellation_requested', null)).toBe('plan-ended');
    expect(lapseNoticeOf('cancellation_requested', T0)).toBe('plan-ended');
  });

  it('is "lapsed" when Stripe gave up on a payment', () => {
    expect(lapseNoticeOf('payment_failed', null)).toBe('lapsed');
    expect(lapseNoticeOf('payment_disputed', null)).toBe('lapsed');
  });

  it('without a reason, follows whether a payment had failed', () => {
    expect(lapseNoticeOf(null, T0)).toBe('lapsed');
    expect(lapseNoticeOf(null, null)).toBe('plan-ended');
  });

  it('is "your plan has ended" for a trial that ended uncharged, whatever the reason', () => {
    expect(lapseNoticeOf('cancellation_requested', null, true)).toBe(
      'plan-ended',
    );
    expect(lapseNoticeOf(null, null, true)).toBe('plan-ended');
    expect(lapseNoticeOf('payment_failed', T0, true)).toBe('plan-ended');
  });
});

describe('trialReminderDue, the 7-day trial reminder', () => {
  const trialing = (
    over: Partial<TrialReminderMarks> = {},
  ): TrialReminderMarks => ({
    status: 'trialing',
    stripeSubscriptionId: 'sub_1',
    trialEndsAt: day(30),
    trialReminderSentAt: null,
    ...over,
  });

  it('is owed from 7 days before the trial ends, not before', () => {
    expect(trialReminderDue(trialing(), day(22.9))).toBe(false);
    expect(trialReminderDue(trialing(), day(23))).toBe(true);
    expect(trialReminderDue(trialing(), day(29.9))).toBe(true);
  });

  it('is owed once', () => {
    expect(
      trialReminderDue(trialing({ trialReminderSentAt: day(23) }), day(25)),
    ).toBe(false);
  });

  it('is not owed once the trial has ended', () => {
    expect(trialReminderDue(trialing(), day(30))).toBe(false);
  });

  it('is owed only while in a trial', () => {
    expect(trialReminderDue(trialing({ status: 'active' }), day(25))).toBe(
      false,
    );
    expect(trialReminderDue(trialing({ trialEndsAt: null }), day(25))).toBe(
      false,
    );
    expect(
      trialReminderDue(trialing({ stripeSubscriptionId: null }), day(25)),
    ).toBe(false);
  });
});
