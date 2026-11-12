import {
  cancelWarningDue,
  causeDueAt,
  deletionCausesOf,
  deletionDateOf,
  deletionDueOf,
  deletionStepOf,
  shownDeletionDateOf,
} from '../../../src/cloud/billing/bought-server-clock';
import type {
  CancelWarningMarks,
  DeletionCause,
  DeletionCauseMarks,
  DeletionStepMarks,
} from '../../../src/cloud/billing/bought-server-clock';

// The Bought Server deletion clock (ADR-0071): the earliest due date of the
// causes in force, and the step a daily tick owes from it.

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-11-01T10:00:00Z');
const day = (n: number) => new Date(T0.getTime() + n * DAY);

describe('causeDueAt', () => {
  it('falls 7 days after a failed payment', () => {
    expect(causeDueAt({ kind: 'payment-failed', since: T0 })).toEqual(day(7));
  });

  it('falls 7 days after a suspension', () => {
    expect(causeDueAt({ kind: 'suspension', since: T0 })).toEqual(day(7));
  });

  it('falls at once on a lapse', () => {
    expect(causeDueAt({ kind: 'lapse', since: T0 })).toEqual(T0);
  });
});

describe('deletionDateOf', () => {
  const failedFirst: DeletionCause = { kind: 'payment-failed', since: T0 };
  const failedLater: DeletionCause = { kind: 'payment-failed', since: day(3) };

  it('is null with no cause in force', () => {
    expect(deletionDateOf([])).toBeNull();
  });

  it('is the earliest due date across the causes, in any order', () => {
    expect(deletionDateOf([failedLater, failedFirst])).toEqual(day(7));
    expect(deletionDateOf([failedFirst, failedLater])).toEqual(day(7));
  });

  it('never hides another cause when one ends', () => {
    expect(deletionDateOf([failedLater])).toEqual(day(10));
    expect(deletionDateOf([failedFirst])).toEqual(day(7));
  });
});

describe('deletionDueOf', () => {
  it('names the cause of the earliest date', () => {
    expect(
      deletionDueOf([
        { kind: 'payment-failed', since: T0 },
        { kind: 'suspension', since: day(-2) },
      ]),
    ).toEqual({ deletesOn: day(5), dueTo: 'suspension' });
    expect(
      deletionDueOf([
        { kind: 'suspension', since: T0 },
        { kind: 'lapse', since: day(3) },
      ]),
    ).toEqual({ deletesOn: day(3), dueTo: 'lapse' });
  });

  it('lets a lapse win a tie, since it deletes unreminded', () => {
    expect(
      deletionDueOf([
        { kind: 'suspension', since: T0 },
        { kind: 'lapse', since: day(7) },
      ]),
    ).toEqual({ deletesOn: day(7), dueTo: 'lapse' });
  });
});

describe('deletionCausesOf', () => {
  const none: DeletionCauseMarks = {
    payingPaymentFailedAt: null,
    ownSuspendedAt: null,
    ownLapsedAt: null,
    payingLapsedAt: null,
  };

  it('reads a failed payment from the Paying Organization', () => {
    expect(deletionCausesOf({ ...none, payingPaymentFailedAt: T0 })).toEqual([
      { kind: 'payment-failed', since: T0 },
    ]);
  });

  it('has no cause once the invoice is paid, the suspension lifted and the plan paid again', () => {
    expect(deletionCausesOf(none)).toEqual([]);
  });

  it("reads a suspension from the Organization's own row", () => {
    expect(deletionCausesOf({ ...none, ownSuspendedAt: T0 })).toEqual([
      { kind: 'suspension', since: T0 },
    ]);
  });

  it("reads a lapse, its own or its Paying Organization's, the earlier one", () => {
    expect(deletionCausesOf({ ...none, payingLapsedAt: T0 })).toEqual([
      { kind: 'lapse', since: T0 },
    ]);
    expect(
      deletionCausesOf({ ...none, ownLapsedAt: day(2), payingLapsedAt: T0 }),
    ).toEqual([{ kind: 'lapse', since: T0 }]);
  });

  it('keeps every cause in force, so ending one never hides another', () => {
    const causes = deletionCausesOf({
      ...none,
      payingPaymentFailedAt: day(1),
      ownSuspendedAt: T0,
    });
    expect(deletionDateOf(causes)).toEqual(day(7));
    expect(
      deletionDateOf(causes.filter((cause) => cause.kind !== 'suspension')),
    ).toEqual(day(8));
  });
});

describe('deletionStepOf', () => {
  const marks = (over: Partial<DeletionStepMarks> = {}): DeletionStepMarks => ({
    deletesOn: day(7),
    dueTo: 'payment-failed',
    dayBeforeSentAt: null,
    deletedSentAt: null,
    ...over,
  });

  it('owes nothing without a deletion date', () => {
    expect(deletionStepOf(marks({ deletesOn: null }), day(100))).toBeNull();
  });

  it('reminds from a day before the date, not sooner', () => {
    expect(deletionStepOf(marks(), day(5.9))).toBeNull();
    expect(deletionStepOf(marks(), day(6))).toBe('remind');
  });

  it('reminds once, then deletes on the date', () => {
    const reminded = marks({ dayBeforeSentAt: day(6) });
    expect(deletionStepOf(reminded, day(6.5))).toBeNull();
    expect(deletionStepOf(reminded, day(7))).toBe('delete');
  });

  it('reminds before deleting when the tick came late', () => {
    expect(deletionStepOf(marks(), day(9))).toBe('remind');
    expect(deletionStepOf(marks({ dayBeforeSentAt: day(9) }), day(10))).toBe(
      'delete',
    );
  });

  it('deletes once', () => {
    const deleted = marks({ dayBeforeSentAt: day(6), deletedSentAt: day(7) });
    expect(deletionStepOf(deleted, day(8))).toBeNull();
  });

  it('reminds and deletes afresh for a later date', () => {
    const earlierClock = { dayBeforeSentAt: day(6), deletedSentAt: day(7) };
    const later = marks({ deletesOn: day(30), ...earlierClock });
    expect(deletionStepOf(later, day(28))).toBeNull();
    expect(deletionStepOf(later, day(29))).toBe('remind');
    expect(
      deletionStepOf({ ...later, dayBeforeSentAt: day(29) }, day(30)),
    ).toBe('delete');
  });

  it('reminds a suspension a day before its date, like a failed payment', () => {
    const suspended = marks({ dueTo: 'suspension' });
    expect(deletionStepOf(suspended, day(6))).toBe('remind');
  });

  it('deletes a lapse at once, with no reminder, and once', () => {
    const lapse = marks({ deletesOn: T0, dueTo: 'lapse' });
    expect(deletionStepOf(lapse, day(-1))).toBeNull();
    expect(deletionStepOf(lapse, T0)).toBe('delete');
    expect(deletionStepOf({ ...lapse, deletedSentAt: T0 }, day(1))).toBeNull();
  });

  it('deletes a later lapse afresh', () => {
    const again = marks({
      deletesOn: day(40),
      dueTo: 'lapse',
      deletedSentAt: T0,
    });
    expect(deletionStepOf(again, day(40))).toBe('delete');
  });
});

describe('cancelWarningDue', () => {
  const cancel = (
    over: Partial<CancelWarningMarks> = {},
  ): CancelWarningMarks => ({
    cancelAt: day(30),
    lapsed: false,
    lapseWarnedAt: null,
    ...over,
  });

  it('owes nothing while the plan renews', () => {
    expect(cancelWarningDue(cancel({ cancelAt: null }), day(29))).toBe(false);
  });

  it('warns from 7 days before the cancel, not sooner', () => {
    expect(cancelWarningDue(cancel(), day(22.9))).toBe(false);
    expect(cancelWarningDue(cancel(), day(23))).toBe(true);
    expect(cancelWarningDue(cancel(), day(29.9))).toBe(true);
  });

  it('warns once per date', () => {
    expect(cancelWarningDue(cancel({ lapseWarnedAt: day(23) }), day(25))).toBe(
      false,
    );
    expect(
      cancelWarningDue(
        cancel({ cancelAt: day(60), lapseWarnedAt: day(23) }),
        day(53),
      ),
    ).toBe(true);
  });

  it('owes nothing once the date has come or the Organization lapsed', () => {
    expect(cancelWarningDue(cancel(), day(30))).toBe(false);
    expect(cancelWarningDue(cancel({ lapsed: true }), day(25))).toBe(false);
  });
});

describe('shownDeletionDateOf', () => {
  it('shows a coming cancel as the deletion date, before any cause', () => {
    expect(
      shownDeletionDateOf(null, { cancelAt: day(30), lapsed: false }),
    ).toEqual(day(30));
  });

  it('shows whichever comes first', () => {
    expect(
      shownDeletionDateOf(day(7), { cancelAt: day(30), lapsed: false }),
    ).toEqual(day(7));
    expect(
      shownDeletionDateOf(day(40), { cancelAt: day(30), lapsed: false }),
    ).toEqual(day(30));
  });

  it('leaves the cancel to the lapse once it has lapsed, and shows nothing with neither', () => {
    expect(
      shownDeletionDateOf(day(1), { cancelAt: day(30), lapsed: true }),
    ).toEqual(day(1));
    expect(shownDeletionDateOf(null, { cancelAt: null, lapsed: false })).toBe(
      null,
    );
  });
});
