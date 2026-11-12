/**
 * Where a Self-hosted license stands against its `validUntil`, as plain rules
 * over a date and the moment. Nothing here reads the database or the
 * clock: every function takes `now`, so the daily re-check and anything that
 * builds on it (the 14- and 3-day `license-expiring` marks, the console's
 * renewal bar) answer the same question the same way and tests can set the
 * moment.
 *
 * A `validUntil` of `null` is a license with no expiry: it is never within any
 * number of days of it and never lapses.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The first advance warning of an expiry, in days before `validUntil`: the
 * console's renewal bar appears to owners and admins, and the
 * `license-expiring` notice goes out.
 *
 * The console mirrors this number and {@link LAST_WARNING_DAYS}
 * (`frontend/src/features/enterprise/license/license-expiry.ts`); a test there
 * reads them back from this file, so a change here fails it until both agree.
 */
export const FIRST_WARNING_DAYS = 14;

/**
 * The last advance warning, in days before `validUntil`: a renewal bar an
 * owner or admin hid comes back and can no longer be hidden, and the
 * second `license-expiring` notice goes out.
 */
export const LAST_WARNING_DAYS = 3;

/**
 * How many days before `validUntil` the daily job starts re-activating the
 * stored key, so a renewal reaches the instance before the old date passes.
 * The same moment as the first warning: from the day an owner is told to
 * renew, a renewal is picked up without anyone pressing "check now".
 */
export const RECHECK_WINDOW_DAYS = FIRST_WARNING_DAYS;

/** Whether the license's `validUntil` has passed as of `now`. */
export function isLapsed(validUntil: Date | null, now: Date): boolean {
  return validUntil !== null && validUntil.getTime() <= now.getTime();
}

/**
 * Whether `now` is within `days` days of `validUntil` — on or after the moment
 * `days` days before it. A lapsed license is within any number of days of its
 * expiry; ask {@link isLapsed} to tell the two apart.
 */
export function isWithinDaysOfExpiry(
  validUntil: Date | null,
  days: number,
  now: Date,
): boolean {
  if (validUntil === null) return false;
  return now.getTime() >= validUntil.getTime() - days * DAY_MS;
}

/**
 * Whether the daily job owes the license server a repeat activate: inside the
 * last {@link RECHECK_WINDOW_DAYS} days before `validUntil`, or after it.
 * Outside that window the stored answer stands and the server is not called.
 */
export function isDueForRecheck(validUntil: Date | null, now: Date): boolean {
  return isWithinDaysOfExpiry(validUntil, RECHECK_WINDOW_DAYS, now);
}

/**
 * The points before `validUntil` at which owners are warned: the
 * `license-expiring` event and the owner email go out once at each.
 */
export const EXPIRY_WARNING_DAYS = [14, 3] as const;

/** Which of the two warnings: 14 days out, or 3. */
export type ExpiryWarning = (typeof EXPIRY_WARNING_DAYS)[number];

/**
 * The `validUntil` each warning was last sent for, or null while none was —
 * `lapseReportedFor`'s pattern, so a renewal (a new `validUntil`) re-arms both
 * without anything having to clear them.
 */
export interface ExpiryWarningMarks {
  warned14For: Date | null;
  warned3For: Date | null;
}

const sameInstant = (a: Date | null, b: Date): boolean =>
  a !== null && a.getTime() === b.getTime();

/**
 * The warning owed as of `now`, or null. The 3-day warning wins when both are
 * owed — a license activated with two days left, or an instance that was down
 * through the 14-day point, hears the nearer date once rather than twice in a
 * row. Nothing is owed once the license has lapsed: that is `license-lapse`'s.
 */
export function dueExpiryWarning(
  validUntil: Date | null,
  marks: ExpiryWarningMarks,
  now: Date,
): ExpiryWarning | null {
  if (validUntil === null || isLapsed(validUntil, now)) return null;
  if (isWithinDaysOfExpiry(validUntil, 3, now)) {
    return sameInstant(marks.warned3For, validUntil) ? null : 3;
  }
  if (isWithinDaysOfExpiry(validUntil, 14, now)) {
    return sameInstant(marks.warned14For, validUntil) ? null : 14;
  }
  return null;
}
