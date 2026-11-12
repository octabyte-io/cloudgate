/**
 * The deletion clock, as a rule (ADR-0052): the time-based steps a
 * lapsing Organization is owed, decided from the marks on its `subscription`
 * row and the moment. Pure, so `LapseClockService`'s daily tick and its unit
 * test share one answer.
 *
 * Two stretches:
 *
 *   * **Stripe retrying.** The first failed payment (`paymentFailedAt`) sends
 *     the payment-failed email. Stripe retries for {@link STRIPE_RETRY_DAYS}
 *     days and then cancels — the lapse — so {@link LAPSE_WARNING_DAYS} days
 *     before that the 3-day warning goes out, once. A cancel never has a failed
 *     payment, so it never gets these two.
 *   * **Lapsed.** {@link DELETION_WARNING_DAYS} days before day
 *     {@link DELETION_AFTER_DAYS} the deletion warning goes out, once; the
 *     Organization is deleted on day 30, and never sooner than 7 days after
 *     that warning — a tick that came late moves the day rather than skipping
 *     the warning. A suspension stops this clock while it lasts; lifting it
 *     clears the warning, so the warning is sent again and 7 days run
 *     from then.
 */

import type { Subscription } from './billing.schema';
import { trialEndsAtOf } from './free-trial';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long Stripe retries a failed payment before it cancels (Stripe settings). */
export const STRIPE_RETRY_DAYS = 14;

/** How long before the expected lapse the lapse warning goes out. */
export const LAPSE_WARNING_DAYS = 3;

/** How long after the lapse an unsuspended Organization is deleted. */
export const DELETION_AFTER_DAYS = 30;

/** How long before deletion the deletion warning goes out, at the least. */
export const DELETION_WARNING_DAYS = 7;

/** The Stripe statuses of a payment that failed and is still being retried. */
const RETRYING_STATUSES = new Set(['past_due', 'unpaid']);

/** Whether `status` is a failed payment Stripe is still retrying. */
export function isRetrying(status: string | null | undefined): boolean {
  return !!status && RETRYING_STATUSES.has(status);
}

/** The parts of the `subscription` row the clock reads. */
export interface ClockMarks {
  status: string | null;
  paymentFailedAt: Date | null;
  lapseWarnedAt: Date | null;
  lapsedAt: Date | null;
  deletionWarnedAt: Date | null;
  suspendedAt: Date | null;
}

/** A step the daily tick takes for one Organization. */
export type ClockStep = 'warn-lapse' | 'warn-deletion' | 'delete';

const plusDays = (at: Date, days: number) =>
  new Date(at.getTime() + days * DAY_MS);

/** When Stripe is expected to give up, or null when no payment is failing. */
export function lapseDueAt(marks: ClockMarks): Date | null {
  if (!marks.paymentFailedAt) return null;
  return plusDays(marks.paymentFailedAt, STRIPE_RETRY_DAYS);
}

/**
 * When a lapsed Organization is deleted: day 30, or 7 days after a warning
 * that went out late. Null when it has not lapsed.
 */
export function deletionDueAt(marks: ClockMarks): Date | null {
  if (!marks.lapsedAt) return null;
  const dayThirty = plusDays(marks.lapsedAt, DELETION_AFTER_DAYS);
  if (!marks.deletionWarnedAt) return dayThirty;
  const afterWarning = plusDays(marks.deletionWarnedAt, DELETION_WARNING_DAYS);
  return afterWarning > dayThirty ? afterWarning : dayThirty;
}

/** The step owed as of `now`, or null. */
export function dueStep(marks: ClockMarks, now: Date): ClockStep | null {
  if (marks.lapsedAt) {
    if (marks.suspendedAt) return null;
    if (!marks.deletionWarnedAt) {
      const warnFrom = plusDays(
        marks.lapsedAt,
        DELETION_AFTER_DAYS - DELETION_WARNING_DAYS,
      );
      return now >= warnFrom ? 'warn-deletion' : null;
    }
    const due = deletionDueAt(marks);
    return due && now >= due ? 'delete' : null;
  }

  const lapse = lapseDueAt(marks);
  if (!lapse || marks.lapseWarnedAt || !isRetrying(marks.status)) return null;
  return now >= plusDays(lapse, -LAPSE_WARNING_DAYS) ? 'warn-lapse' : null;
}

/** How long before a free trial ends its reminder goes out. */
export const TRIAL_REMINDER_DAYS = 7;

/** The parts of the `subscription` row the trial reminder reads. */
export type TrialReminderMarks = Pick<
  Subscription,
  'status' | 'trialEndsAt' | 'stripeSubscriptionId' | 'trialReminderSentAt'
>;

/**
 * Whether the "your trial ends in 7 days" email is owed as of `now`: the
 * Organization is in a trial (`trialEndsAtOf`), it ends within
 * {@link TRIAL_REMINDER_DAYS} days and has not yet, and no reminder went out
 * — once per trial, so a plan or Add-on change after it owes none again. A
 * tick that came late still sends it, until the trial has ended.
 */
export function trialReminderDue(
  marks: TrialReminderMarks,
  now: Date,
): boolean {
  const endsAt = trialEndsAtOf(marks);
  if (!endsAt || marks.trialReminderSentAt) return false;
  return now >= plusDays(endsAt, -TRIAL_REMINDER_DAYS) && now < endsAt;
}

/**
 * Which email a lapse sends: "lapsed" when Stripe gave up on a payment,
 * "your plan has ended" after a cancel. Stripe says
 * which on the deleted subscription (`cancellation_details.reason`); without
 * a reason (a deleted customer) it is whether a payment had failed.
 */
export type LapseNotice = 'lapsed' | 'plan-ended';

/**
 * A subscription that ended inside its free trial (`endedInTrial`,
 * free-trial.ts `endedDuringTrial`) was never charged, so whatever Stripe
 * gives as the reason — a cancel, or its `missing_payment_method` cancel —
 * it is "your plan has ended", never "lapsed".
 */
export function lapseNoticeOf(
  reason: string | null | undefined,
  paymentFailedAt: Date | null,
  endedInTrial = false,
): LapseNotice {
  if (endedInTrial) return 'plan-ended';
  if (reason === 'cancellation_requested') return 'plan-ended';
  if (reason === 'payment_failed' || reason === 'payment_disputed') {
    return 'lapsed';
  }
  return paymentFailedAt ? 'lapsed' : 'plan-ended';
}
