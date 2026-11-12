/**
 * The **Bought Server** deletion clock, as a rule (ADR-0071, the amendment
 * to ADR-0052), beside the Organization's own clock in `lapse-clock.ts`.
 * Pure, so the daily tick, the Server pages and the refusal of costlier
 * changes share one answer.
 *
 * Bought Servers are Octabyte's machines, billed to Octabyte every hour they
 * exist, so they do not wait out ADR-0052's weeks. Each **cause** in force
 * has a due date, and the Organization's Bought Servers are due for deletion
 * on the **earliest** of them. The date is never stored: it is worked out
 * here from the marks every time, so ending one cause can only leave the
 * others' dates, never hide them.
 *
 * Causes:
 *
 *   * **A failed payment for them** (#1397): 7 days after an invoice with
 *     Bought Server lines failed, even while the Organization is only
 *     `past_due`. Read from the Paying Organization's row, so an Attached
 *     Organization's Bought Servers, charged on its payer's invoice, share
 *     it. Paying that invoice ends it.
 *   * **A suspension** (#1398): 7 days after an Operator suspended the
 *     Organization, unless it is lifted first. Read from the
 *     Organization's **own** row only, so a Paying Organization's
 *     suspension never reaches an Attached Organization (ADR-0059). Only
 *     lifting it ends it; paying never does.
 *   * **A lapse** (#1398): at once. The Organization's own lapse or its
 *     Paying Organization's, as `frozen.ts` reads it: a cancel reaching its
 *     date, a Free trial ending without a card, Enterprise switched off,
 *     Stripe giving up, or "Stop paying for it". Paying again ends it.
 *
 * Steps, for each Organization with a date: a reminder from a day before
 * it, then deletion once it has come, and never before the reminder has
 * gone out for that date: a tick that came late sends the reminder and
 * deletes on the next one. A lapse has no reminder: its date is the moment
 * it was recorded, so it is deleted then. A cancel's date is known ahead,
 * so {@link cancelWarningDue} warns 7 days before it instead.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long after a failed payment for them Bought Servers are deleted. */
export const PAYMENT_FAILED_DELETION_DAYS = 7;

/** How long after a suspension Bought Servers are deleted. */
export const SUSPENSION_DELETION_DAYS = 7;

/** How long before a known cancel the warning goes out. */
export const CANCEL_WARNING_DAYS = 7;

/** How long before the deletion date the reminder goes out. */
export const DELETION_REMINDER_DAYS = 1;

const plusDays = (at: Date, days: number) =>
  new Date(at.getTime() + days * DAY_MS);

/** One reason in force to delete an Organization's Bought Servers, since `since`. */
export type DeletionCause = {
  /**
   * `payment-failed`: an invoice with Bought Server lines failed, and is
   * still unpaid. `suspension`: an Operator suspended the Organization.
   * `lapse`: the Organization, or its Paying Organization, lapsed.
   */
  kind: DeletionCauseKind;
  since: Date;
};

export type DeletionCauseKind = 'payment-failed' | 'suspension' | 'lapse';

/** When one cause has the Bought Servers deleted. */
export function causeDueAt(cause: DeletionCause): Date {
  switch (cause.kind) {
    case 'payment-failed':
      return plusDays(cause.since, PAYMENT_FAILED_DELETION_DAYS);
    case 'suspension':
      return plusDays(cause.since, SUSPENSION_DELETION_DAYS);
    case 'lapse':
      return cause.since;
  }
}

/** The deletion date, and the cause it is due to. */
export interface DeletionDue {
  deletesOn: Date;
  dueTo: DeletionCauseKind;
}

/**
 * The deletion date: the earliest due date of the causes in force, with
 * the cause it is due to, or null with none. On a tie a lapse wins, since
 * it deletes without a reminder.
 */
export function deletionDueOf(
  causes: readonly DeletionCause[],
): DeletionDue | null {
  let earliest: DeletionDue | null = null;
  for (const cause of causes) {
    const due = causeDueAt(cause);
    if (
      !earliest ||
      due < earliest.deletesOn ||
      (due.getTime() === earliest.deletesOn.getTime() && cause.kind === 'lapse')
    ) {
      earliest = { deletesOn: due, dueTo: cause.kind };
    }
  }
  return earliest;
}

/** {@link deletionDueOf}'s date alone. */
export function deletionDateOf(causes: readonly DeletionCause[]): Date | null {
  return deletionDueOf(causes)?.deletesOn ?? null;
}

/** The marks the causes are read from. */
export interface DeletionCauseMarks {
  /** `boughtServersPaymentFailedAt` on the Paying Organization's row. */
  payingPaymentFailedAt: Date | null;
  /** `suspendedAt` on the Organization's own row; never its payer's. */
  ownSuspendedAt: Date | null;
  /** `lapsedAt` on the Organization's own row. */
  ownLapsedAt: Date | null;
  /** `lapsedAt` on the Paying Organization's row (its own row when not attached). */
  payingLapsedAt: Date | null;
}

/** The causes in force, from the marks. */
export function deletionCausesOf(marks: DeletionCauseMarks): DeletionCause[] {
  const causes: DeletionCause[] = [];
  if (marks.payingPaymentFailedAt) {
    causes.push({ kind: 'payment-failed', since: marks.payingPaymentFailedAt });
  }
  if (marks.ownSuspendedAt) {
    causes.push({ kind: 'suspension', since: marks.ownSuspendedAt });
  }
  const lapses = [marks.ownLapsedAt, marks.payingLapsedAt].filter(
    (at): at is Date => at !== null,
  );
  if (lapses.length > 0) {
    const since = lapses.reduce((a, b) => (b < a ? b : a));
    causes.push({ kind: 'lapse', since });
  }
  return causes;
}

/** The marks a step reads, on the Organization's own row. */
export interface DeletionStepMarks {
  /** The deletion date, from {@link deletionDueOf}. */
  deletesOn: Date | null;
  /** The cause it is due to: a lapse deletes with no reminder. */
  dueTo: DeletionCauseKind | null;
  /** `boughtServersDayBeforeSentAt`: when the reminder last went out. */
  dayBeforeSentAt: Date | null;
  /** `boughtServersDeletedSentAt`: when its Bought Servers were last deleted. */
  deletedSentAt: Date | null;
}

/** A step the daily tick takes for one Organization's Bought Servers. */
export type DeletionStep = 'remind' | 'delete';

/** When the reminder for this deletion date is owed from. */
export function reminderDueAt(deletesOn: Date): Date {
  return plusDays(deletesOn, -DELETION_REMINDER_DAYS);
}

/**
 * The step owed as of `now`, or null. A mark counts only for the date it
 * was made for: a reminder sent from a day before it on, a deletion from
 * the date on, so a later date (a new failed payment, after one was paid)
 * is reminded and deleted afresh. A lapse is deleted at once, unreminded.
 */
export function deletionStepOf(
  marks: DeletionStepMarks,
  now: Date,
): DeletionStep | null {
  const { deletesOn } = marks;
  if (!deletesOn) return null;
  if (marks.deletedSentAt && marks.deletedSentAt >= deletesOn) return null;
  if (marks.dueTo === 'lapse') return now >= deletesOn ? 'delete' : null;
  const remindFrom = reminderDueAt(deletesOn);
  if (now < remindFrom) return null;
  if (!marks.dayBeforeSentAt || marks.dayBeforeSentAt < remindFrom) {
    return 'remind';
  }
  return now >= deletesOn ? 'delete' : null;
}

/** The marks the cancel warning reads. */
export interface CancelWarningMarks {
  /** `cancelAt` on the Paying Organization's row: when its plan ends. */
  cancelAt: Date | null;
  /** Whether the Organization has lapsed already (its own or its payer's). */
  lapsed: boolean;
  /** `boughtServersLapseWarnedAt` on the Organization's own row. */
  lapseWarnedAt: Date | null;
}

/** When the warning for a cancel on `cancelAt` is owed from. */
export function cancelWarningFrom(cancelAt: Date): Date {
  return plusDays(cancelAt, -CANCEL_WARNING_DAYS);
}

/**
 * Whether the "your Bought Servers will be deleted on <date>" warning is
 * owed as of `now` (story 65): a cancel's date is known, so it goes out
 * from 7 days before it until it comes, once per date. A cancel undone and
 * made again later is warned afresh; one already past lapses instead.
 */
export function cancelWarningDue(
  marks: CancelWarningMarks,
  now: Date,
): boolean {
  const { cancelAt } = marks;
  if (!cancelAt || marks.lapsed || now >= cancelAt) return false;
  const warnFrom = cancelWarningFrom(cancelAt);
  if (now < warnFrom) return false;
  return !marks.lapseWarnedAt || marks.lapseWarnedAt < warnFrom;
}

/**
 * The deletion date shown and enforced before it comes (the red bar, and
 * the refusal of anything that costs more): {@link deletionDueOf}'s date, or
 * a coming cancel's, whichever is first. A cancel is a coming lapse
 * (CONTEXT.md): its date is known ahead, so it counts from the moment it is
 * set, though the daily steps leave it to the lapse it becomes (warned 7
 * days before by {@link cancelWarningDue}, deleted once it lapses).
 */
export function shownDeletionDateOf(
  deletesOn: Date | null,
  marks: Pick<CancelWarningMarks, 'cancelAt' | 'lapsed'>,
): Date | null {
  const cancel = marks.lapsed ? null : marks.cancelAt;
  if (!cancel) return deletesOn;
  if (!deletesOn) return cancel;
  return cancel < deletesOn ? cancel : deletesOn;
}
