import { Cron } from 'croner';
import type { WallClock } from '../common/cron-expression';

/**
 * When a Cron service, a Schedule or a backup fires (ADR-0034):
 * the next `count` instants after `after`, for `schedule` read in `timezone`.
 * Pure — the caller says what "now" is. One rule for all of them, since two
 * daylight-saving rules in one product would be a bug of its own.
 *
 * `schedule` is a five-field expression `scheduleProblem` accepts (a Cron
 * service's), or the {@link WallClock} another dialect reads to — a Schedule's
 * or a backup's, from `readCronExpression`.
 *
 * The schedule names **local clock times**, so they are found first, by
 * croner reading the schedule against a wall clock with no daylight saving
 * at all (UTC), and each is then placed on the time line in `timezone`.
 * That placing is the guard the AWS rule needs:
 *
 * - a clock time that does not exist that day (spring forward) is skipped,
 *   never moved to the hour after;
 * - a clock time that happens twice (fall back) fires once, at its first
 *   occurrence, so `*\/15 * * * *` fires at 01:00, 01:15, 01:30 and 01:45
 *   once each on the night the clocks go back;
 * - an instant at or before `after` is never returned, including the first
 *   occurrence of a repeated time when `after` is inside the repeat.
 *
 * `timezone` is a name `Intl` takes, normally an IANA one.
 */
export function nextFireTimes(
  schedule: string | WallClock,
  timezone: string,
  after: Date,
  count: number,
): Date[] {
  const wallClock =
    typeof schedule === 'string'
      ? new Cron(schedule.trim(), {
          paused: true,
          mode: '5-part',
          timezone: 'UTC',
        })
      : schedule;
  const fires: Date[] = [];
  let local: Date | null = new Date(
    after.getTime() + offsetAt(after, timezone),
  );
  // Each skipped clock time is one of at most an hour's worth around a
  // daylight-saving change — missing, or repeated and already passed — so
  // two hours of seconds bounds the loop past any schedule, a Schedule's
  // every-second one included.
  for (let tries = 0; fires.length < count && tries < count + 7200; tries++) {
    local = wallClock.nextRun(local);
    if (local === null) break;
    const first = firstInstantOf(local, timezone);
    if (first !== null && first.getTime() > after.getTime()) fires.push(first);
  }
  return fires;
}

const HOUR = 60 * 60 * 1000;

/**
 * The first instant whose clock time in `timezone` reads `local` (a wall
 * clock held as a UTC date), or `null` when that clock time does not exist
 * there. The offsets a day either side bracket any one change, since no zone
 * changes twice in two days.
 */
function firstInstantOf(local: Date, timezone: string): Date | null {
  const offsets = new Set([
    offsetAt(new Date(local.getTime() - 24 * HOUR), timezone),
    offsetAt(new Date(local.getTime() + 24 * HOUR), timezone),
  ]);
  const instants = [...offsets]
    .map((offset) => new Date(local.getTime() - offset))
    .filter(
      (instant) =>
        instant.getTime() + offsetAt(instant, timezone) === local.getTime(),
    )
    .sort((a, b) => a.getTime() - b.getTime());
  return instants[0] ?? null;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** How far `timezone`'s clock is ahead of UTC at `instant`, in ms. */
function offsetAt(instant: Date, timezone: string): number {
  let format = formatters.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timezone, format);
  }
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const clock = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const whole = instant.getTime() - instant.getMilliseconds();
  return clock - whole;
}
