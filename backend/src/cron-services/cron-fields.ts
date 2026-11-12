import { Cron } from 'croner';

/**
 * A Cron service's three timetable fields, as a `kind: cron` entry writes
 * them (ADR-0034): the rules every target holds to, stated once,
 * so the parser and the fire-time calculation cannot disagree. Pure.
 */

/** What a `kind: cron` entry with no `timezone` is read in. */
export const DEFAULT_TIMEZONE = 'UTC';

/** A run's time limit when the entry names none: one hour. */
export const DEFAULT_TIMEOUT_SECONDS = 60 * 60;

/** The longest time limit a run may have: 24 hours. */
export const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;

interface FieldRule {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  /** Names a value may be written by, uppercase, numbered from `min`. */
  readonly names?: readonly string[];
}

const FIELDS: readonly FieldRule[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  {
    name: 'month',
    min: 1,
    max: 12,
    names: [
      'JAN',
      'FEB',
      'MAR',
      'APR',
      'MAY',
      'JUN',
      'JUL',
      'AUG',
      'SEP',
      'OCT',
      'NOV',
      'DEC',
    ],
  },
  // 7 is Sunday as well as 0, as unix cron reads it.
  {
    name: 'day-of-week',
    min: 0,
    max: 7,
    names: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'],
  },
];

const FIVE_FIELDS = 'five fields (minute hour day-of-month month day-of-week)';

/**
 * Why `schedule` is not a five-field unix cron expression Cloudgate takes,
 * as a predicate that follows the field's name, or `null` when it is one.
 *
 * Numbers, ranges, lists, steps (`*\/15`, `1-5/2`) and `JAN`/`MON` names are
 * taken. Seconds, a year, `?`, `L`, `W`, `#`, `@` shortcuts and restricting
 * both day fields are refused, each by its own sentence: the same text has to
 * mean the same thing on a Server, AWS and GCP, and those are where their
 * cron dialects part (US33).
 */
export function scheduleProblem(schedule: string): string | null {
  const text = schedule.trim();
  if (text === '') return `cannot be empty; write ${FIVE_FIELDS}`;
  if (text.startsWith('@')) {
    return `uses the shortcut ${text.split(/\s+/)[0]}, which is not taken; write the ${FIVE_FIELDS}, e.g. 0 0 * * * for every day at midnight`;
  }
  const fields = text.split(/\s+/);
  if (fields.length === 6) {
    return `has six fields; seconds and a year are not taken, so write ${FIVE_FIELDS}`;
  }
  if (fields.length === 7) {
    return `has seven fields; seconds and a year are not taken, so write ${FIVE_FIELDS}`;
  }
  if (fields.length !== 5) {
    return `has ${fields.length} ${fields.length === 1 ? 'field' : 'fields'}; write ${FIVE_FIELDS}`;
  }
  if (text.includes('?')) {
    return 'uses ?, which is not taken; write * for "any"';
  }
  if (text.includes('#')) {
    return 'uses #, which is not taken; "the nth weekday of the month" cannot be written';
  }

  for (const [index, field] of fields.entries()) {
    const problem = fieldProblem(field, FIELDS[index]);
    if (problem !== null) return problem;
  }

  if (fields[2] !== '*' && fields[4] !== '*') {
    return 'restricts both day-of-month and day-of-week; restrict one and leave the other *, since cron dialects disagree on what both together mean';
  }

  // The last word is croner's, which will read it for the fire times.
  try {
    new Cron(text, { paused: true, mode: '5-part' });
  } catch {
    return `is not a cron expression Cloudgate can read; write ${FIVE_FIELDS}`;
  }
  return null;
}

function fieldProblem(field: string, rule: FieldRule): string | null {
  for (const item of field.split(',')) {
    const problem = itemProblem(item, rule);
    if (problem !== null) return problem;
  }
  return null;
}

function itemProblem(item: string, rule: FieldRule): string | null {
  const [range, step, ...extra] = item.split('/');
  if (extra.length > 0 || item === '') {
    return `has ${JSON.stringify(item)} in its ${rule.name} field, which is not a value, range, list or step`;
  }
  if (step !== undefined && !/^[1-9]\d*$/.test(step)) {
    return `has the step /${step} in its ${rule.name} field; a step is a whole number from 1`;
  }
  if (range === '*') return null;

  const bounds = range.split('-');
  if (bounds.length > 2) {
    return `has ${JSON.stringify(item)} in its ${rule.name} field, which is not a value, range, list or step`;
  }
  if (step !== undefined && bounds.length === 1) {
    return `has ${JSON.stringify(item)} in its ${rule.name} field; a step goes on * or a range, e.g. */15 or 0-30/5`;
  }
  const values: number[] = [];
  for (const bound of bounds) {
    const value = valueOf(bound, rule);
    if (typeof value === 'string') return value;
    values.push(value);
  }
  if (values.length === 2 && values[0] > values[1]) {
    return `has the range ${range} in its ${rule.name} field, which runs backwards`;
  }
  return null;
}

/** A number or name in one field, or why it is not one. */
function valueOf(word: string, rule: FieldRule): number | string {
  if (/^\d+$/.test(word)) {
    const value = Number(word);
    if (value < rule.min || value > rule.max) {
      return `has ${word} in its ${rule.name} field, outside ${rule.min}-${rule.max}`;
    }
    return value;
  }
  const upper = word.toUpperCase();
  const named = rule.names?.indexOf(upper) ?? -1;
  if (named >= 0) return rule.min + named;
  // `L` and `W` are checked only once a word is not a name, since JUL and
  // WED are names.
  if (upper.includes('L')) {
    return 'uses L, which is not taken; "the last day" cannot be written';
  }
  if (upper.includes('W')) {
    return 'uses W, which is not taken; "the nearest weekday" cannot be written';
  }
  return `has ${JSON.stringify(word)} in its ${rule.name} field, which is not ${rule.names ? `a number or a name (${rule.names[0]}…)` : 'a number'}`;
}

/**
 * Whether `timezone` is an IANA time zone name: `UTC` or an `Area/City` one
 * this Node knows. An abbreviation (`EST`) or an offset (`+01:00`) is not
 * one, though `Intl` takes some: neither says which daylight-saving rules
 * apply, and a cloud scheduler takes only names.
 */
export function isIanaTimezone(timezone: string): boolean {
  if (
    timezone !== 'UTC' &&
    !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$/.test(timezone)
  ) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** A duration as `timeout` writes it: whole minutes or hours. */
export const DURATION = /^([1-9]\d*)(m|h)$/;

/** `timeout`'s seconds, or `null` when it is not `<n>m` or `<n>h`. */
export function timeoutSeconds(timeout: string): number | null {
  const match = DURATION.exec(timeout);
  if (!match) return null;
  return Number(match[1]) * (match[2] === 'h' ? 3600 : 60);
}

/**
 * A time limit as `timeout` writes it: in hours when it is whole hours, else
 * in minutes. The planner compares and the generator writes this form, so
 * `60m` and `1h` are the same limit.
 */
export function formatTimeout(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.round(seconds / 60)}m`;
}
