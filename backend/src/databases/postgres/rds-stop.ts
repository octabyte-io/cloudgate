/**
 * **The stop record of a postgres on RDS** (spec "Lifecycle"):
 * one rule, read by the Database's view, by the plan that marks a step
 * blocked and by the Apply that skips it, so the three never disagree.
 *
 * AWS starts a stopped RDS instance again by itself after seven days, and
 * Cloudgate never stops it again. So a row reading `stopped` is believed
 * only until its `restartsAt`: after that the instance reads "Started again
 * by AWS", and nothing waits on it any more.
 */

/** How long AWS leaves an RDS instance stopped before it starts it again. */
export const RDS_STOP_DAYS = 7;

/** The row's columns the rule reads. */
export interface RdsStopColumns {
  readonly cloudAccountId: string | null;
  readonly applicationStatus: string;
  readonly restartsAt: string | null;
}

/**
 * - `stopped`: Cloudgate stopped it and AWS has not started it again yet.
 * - `started-by-aws`: Cloudgate stopped it and the date has passed, so AWS
 *   has started it again; the row has not been told.
 */
export type RdsStop =
  | { readonly state: 'stopped'; readonly restartsAt: string }
  | { readonly state: 'started-by-aws'; readonly restartsAt: string };

/** The instance's stop as of `now`, or `null` when it is not stopped. */
export function rdsStopOf(row: RdsStopColumns, now: Date): RdsStop | null {
  if (!row.cloudAccountId || row.restartsAt === null) return null;
  if (row.applicationStatus !== 'stopped') return null;
  return new Date(row.restartsAt).getTime() > now.getTime()
    ? { state: 'stopped', restartsAt: row.restartsAt }
    : { state: 'started-by-aws', restartsAt: row.restartsAt };
}

/** When AWS starts an instance stopped at `stoppedAt` again. */
export function restartDate(stoppedAt: Date): string {
  return new Date(
    stoppedAt.getTime() + RDS_STOP_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
}

/** A date as the sentences say it: `2026-10-24` (UTC). */
function day(iso: string): string {
  return iso.slice(0, 10);
}

/** What Stop warns, before and after it is pressed. */
export function rdsStopWarning(restartsAt: string): string {
  return `AWS starts it again on ${day(restartsAt)}, and storage and backups still bill`;
}

/** The status line of a stopped instance. */
export function rdsStopSentence(stop: RdsStop): string {
  return stop.state === 'stopped'
    ? `Stopped, AWS starts it again on ${day(stop.restartsAt)}`
    : 'Started again by AWS';
}

/** A plan step that would change a stopped instance. */
export function blockedByStop(name: string): string {
  return `${name} is stopped. Start it first.`;
}
