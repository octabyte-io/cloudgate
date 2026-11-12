import { z } from 'zod';

/**
 * A cron expression the scheduler can actually parse.
 *
 * `SchedulingService.register` reads this string with
 * {@link readCronExpression} and throws synchronously on a bad one. Left
 * unvalidated, that throw landed *after* the row was inserted, so a typo
 * answered 500 and kept a schedule nothing would ever run. Validated by
 * the same reader that will register it, so the refusal and the registration
 * cannot disagree.
 *
 * It lives in `common/` rather than in one feature's `dto/` because three DTOs
 * feed the same `SchedulingService`: `schedule.dto.ts`,
 * `volume-backup.dto.ts`, whose `schedule` field carried the identical hole
 * and `backup.dto.ts`. Re-declaring the refinement in each was
 * the alternative and is what §2.4 forbids — copies of a rule about one
 * collaborator drift, and the drift is a 500 with a committed row. Same
 * reasoning as `common/owned-server.ts`, where five copies of one lookup had
 * already diverged.
 *
 * Deliberately not lifted with it: `timezoneSchema`, which stays in
 * `schedule.dto.ts`. A volume backup registers with `timezone: null` and has no
 * such field, so there is no second caller to share it with — and a shared
 * helper with one caller is the thing this module exists to avoid.
 */
export const cronExpressionSchema = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    let clock: WallClock;
    try {
      clock = readCronExpression(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid cron expression' });
      return;
    }
    // `0 0 31 2 *` reads, but no date matches it: registered, it would be a
    // schedule that never runs.
    if (clock.nextRun(new Date()) === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'Cron expression never fires: no date matches it',
      });
    }
  });

/**
 * The dialect Schedules, backups and volume backups have always been written
 * in, which is the `cron` npm library's (4.x) that used to run them:
 * five fields, or six with seconds first; numbers, `*`, ranges, steps
 * (`*\/15`, `1-5/2`, and `5/15`, meaning `5-59/15`) and lists; `jan`…`dec`
 * and `sun`…`sat` in any case; 7 as Sunday; and the shortcuts below. A day
 * matches when either day field does, if both are restricted.
 *
 * Read here, not by croner, because croner reads that dialect differently in
 * places — it refuses `5/15`, `@minutely`, `@secondly`, `@weekdays` and
 * `@weekends`, and with both day fields restricted it skips a 1st of the
 * month that falls on a day-of-week the expression does not name — and a
 * stored schedule must not change its meaning silently. A Cron service's
 * five-field `schedule` is a different, narrower dialect (`scheduleProblem`),
 * which croner reads.
 *
 * Returns the expression's local clock times as a {@link WallClock}, for
 * `nextFireTimes` to place in a timezone; throws on anything else.
 */
export function readCronExpression(expression: string): WallClock {
  let source = expression.toLowerCase();
  source = SHORTCUTS.get(source) ?? source;
  source = source.replace(/[a-z]{1,3}/g, (name) => {
    const value = NAMES.get(name);
    if (value === undefined) throw new Error(`Unknown name: ${name}`);
    return String(value);
  });
  const fields = source.trim().split(/\s+/);
  if (fields.length < 5) throw new Error('Too few fields');
  if (fields.length > 6) throw new Error('Too many fields');
  if (fields.length === 5) fields.unshift('0');
  const [second, minute, hour, dayOfMonth, month, dayOfWeek] = fields.map(
    (field, index) => readField(field, UNITS[index]),
  );
  return new CronClock(second, minute, hour, dayOfMonth, month, dayOfWeek);
}

const SHORTCUTS = new Map([
  ['@yearly', '0 0 0 1 1 *'],
  ['@monthly', '0 0 0 1 * *'],
  ['@weekly', '0 0 0 * * 0'],
  ['@daily', '0 0 0 * * *'],
  ['@hourly', '0 0 * * * *'],
  ['@minutely', '0 * * * * *'],
  ['@secondly', '* * * * * *'],
  ['@weekdays', '0 0 0 * * 1-5'],
  ['@weekends', '0 0 0 * * 0,6'],
]);

const NAMES = new Map(
  [
    ...['jan', 'feb', 'mar', 'apr', 'may', 'jun'],
    ...['jul', 'aug', 'sep', 'oct', 'nov', 'dec'],
  ]
    .map((name, index): [string, number] => [name, index + 1])
    .concat(
      ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((name, index) => [
        name,
        index,
      ]),
    ),
);

interface Unit {
  readonly name: string;
  readonly low: number;
  readonly high: number;
}

const UNITS: readonly Unit[] = [
  { name: 'second', low: 0, high: 59 },
  { name: 'minute', low: 0, high: 59 },
  { name: 'hour', low: 0, high: 23 },
  { name: 'day-of-month', low: 1, high: 31 },
  { name: 'month', low: 1, high: 12 },
  // 7 is Sunday as well as 0.
  { name: 'day-of-week', low: 0, high: 7 },
];

/** One field's values: `*` is the unit's whole range, `n/step` runs to its end. */
function readField(field: string, unit: Unit): Set<number> {
  const values = new Set<number>();
  for (const item of field.split(',')) {
    if (item.indexOf('*') > 0) {
      throw new Error(`The ${unit.name} field has a misplaced *: ${item}`);
    }
    const match = /^(\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(
      item.replace(/\*/g, `${unit.low}-${unit.high}`),
    );
    if (match === null) {
      throw new Error(`The ${unit.name} field cannot be read: ${item}`);
    }
    const lower = Number(match[1]);
    const step = match[3] === undefined ? 1 : Number(match[3]);
    const upper =
      match[2] !== undefined
        ? Number(match[2])
        : match[3] !== undefined
          ? unit.high
          : lower;
    if (step === 0) throw new Error(`The ${unit.name} field has a step of 0`);
    if (lower > upper) {
      throw new Error(`The ${unit.name} field has a backwards range: ${item}`);
    }
    if (lower < unit.low || upper > unit.high) {
      throw new Error(`The ${unit.name} field is out of range: ${item}`);
    }
    for (let value = lower; value <= upper; value += step) values.add(value);
  }
  if (unit.name === 'day-of-week' && values.delete(7)) values.add(0);
  return values;
}

/**
 * A schedule's **local clock times**, read against a wall clock with no
 * daylight saving at all: the first one after `after`, both held as UTC
 * dates, or `null` when there is none. A paused croner `Cron` in UTC is
 * one, and so is {@link CronClock}. Here, beside the dialect that implements
 * it, so `scheduling/fire-times.ts` depends on `common/` and not the reverse.
 */
export interface WallClock {
  nextRun(after: Date): Date | null;
}

/** The longest a search looks ahead before deciding nothing matches. */
const SEARCH_YEARS = 8;

/** An expression's clock times, on a wall clock held as UTC dates. */
class CronClock implements WallClock {
  constructor(
    private readonly second: Set<number>,
    private readonly minute: Set<number>,
    private readonly hour: Set<number>,
    private readonly dayOfMonth: Set<number>,
    private readonly month: Set<number>,
    private readonly dayOfWeek: Set<number>,
  ) {}

  nextRun(after: Date): Date | null {
    const limit = Date.UTC(after.getUTCFullYear() + SEARCH_YEARS, 0, 1);
    let at = new Date(Math.floor(after.getTime() / 1000) * 1000 + 1000);
    while (at.getTime() < limit) {
      const [y, mo, d, h, mi] = [
        at.getUTCFullYear(),
        at.getUTCMonth(),
        at.getUTCDate(),
        at.getUTCHours(),
        at.getUTCMinutes(),
      ];
      if (!this.month.has(mo + 1)) at = new Date(Date.UTC(y, mo + 1, 1));
      else if (!this.dayMatches(at)) at = new Date(Date.UTC(y, mo, d + 1));
      else if (!this.hour.has(h)) at = new Date(Date.UTC(y, mo, d, h + 1));
      else if (!this.minute.has(mi)) {
        at = new Date(Date.UTC(y, mo, d, h, mi + 1));
      } else if (!this.second.has(at.getUTCSeconds())) {
        at = new Date(at.getTime() + 1000);
      } else return at;
    }
    return null;
  }

  /**
   * A restricted day field must match; when both are restricted, either
   * may. "Restricted" is by value, as `cron` read it: `1-31` and `0-6` are
   * as unrestricted as `*`.
   */
  private dayMatches(at: Date): boolean {
    const domMatches = this.dayOfMonth.has(at.getUTCDate());
    const dowMatches = this.dayOfWeek.has(at.getUTCDay());
    const domRestricted = this.dayOfMonth.size < 31;
    const dowRestricted = this.dayOfWeek.size < 7;
    if (domRestricted && dowRestricted) return domMatches || dowMatches;
    return domMatches && dowMatches;
  }
}
