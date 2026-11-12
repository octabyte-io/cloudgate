import { BadRequestException } from '@nestjs/common';

/** The ?limit= default when nothing usable was sent. */
const DEFAULT_LIMIT = 50;

/**
 * A date and a time, optionally with a zone: the RFC3339 shape a metrics
 * bound has to arrive in. Deliberately narrow — `Date`'s own parser will
 * happily take "24/07/2026" or a bare year and answer something, and a bound
 * silently meaning a different instant than it reads as is worse than a 400.
 *
 * A date on its own is refused rather than guessed at: for `start` it would
 * have to mean midnight and for `end` the end of the day, and a parameter
 * that means two different things is not one a caller can rely on.
 */
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?$/;

/** Inclusive UTC bounds, normalised onto the stored timestamp scale. */
export interface MetricsWindow {
  start?: string;
  end?: string;
}

/**
 * What a metrics read was actually asked for: which slice of time, and how
 * many samples of it at most.
 */
export interface MetricsRange {
  window: MetricsWindow;
  limit: number | 'all';
}

/**
 * `?serverId=&limit=&start=&end=` → the range the read should answer, or a
 * 400 explaining why it cannot (ADR 0005 — an unanswerable question must not
 * come back as an empty list, which reads as "this host did nothing").
 *
 * How the two compose, decided once here so the answer is predictable:
 *
 * - **Neither bound** — unchanged from before the window existed: the last
 *   `limit` samples, `limit` defaulting to 50 and falling back to 50 for
 *   anything unparsable, `'all'` meaning no cap. Existing callers keep their
 *   behaviour exactly.
 * - **A bound, no `limit`** — the window *is* the bound, so there is no
 *   sample cap. Quietly capping a 720-sample hour at 50 would answer a
 *   different question than the one asked, which is the defect this window
 *   exists to fix.
 * - **A bound and a `limit`** — the window filters and `limit` caps, keeping
 *   the *most recent* samples inside the window (the same end the countless
 *   "last N" reads keep), still returned oldest-first.
 * - **One bound only** — the other end is open: `start` alone is everything
 *   since, `end` alone is everything up to.
 *
 * Both bounds are inclusive, matching the `gte`/`lte` the reads apply.
 */
export function parseMetricsRange(query: {
  limit?: string;
  start?: string;
  end?: string;
}): MetricsRange {
  const window: MetricsWindow = {};
  const start = parseBound('start', query.start);
  const end = parseBound('end', query.end);
  if (start !== undefined) window.start = start;
  if (end !== undefined) window.end = end;

  if (start !== undefined && end !== undefined && end < start) {
    throw new BadRequestException(
      `end (${query.end}) is before start (${query.start})`,
    );
  }

  const bounded = start !== undefined || end !== undefined;
  const cap =
    query.limit === undefined || query.limit === '' ? undefined : query.limit;
  return {
    window,
    limit: cap === undefined && bounded ? 'all' : parseLimit(cap),
  };
}

/**
 * One bound onto the scale the samples are stored on: UTC ISO strings, ordered
 * and compared as text. An absent or empty bound is no bound.
 *
 * A bound written with an offset is resolved (04:00+02:00 is 02:00Z); a bound
 * written without a zone is read as **UTC**, because that is the scale of the
 * data being asked about — letting `Date` read it as the API server's local
 * time would move an operator's window by the deployment's timezone.
 */
function parseBound(
  name: 'start' | 'end',
  value: string | undefined,
): string | undefined {
  if (value === undefined || value === '') return undefined;

  const match = RFC3339.exec(value);
  const parsed =
    match && isRealDate(match[1], match[2], match[3])
      ? new Date(/(Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`)
      : new Date(Number.NaN);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(
      `${name} must be an RFC3339 timestamp such as 2026-07-24T02:00:00Z, got "${value}"`,
    );
  }
  return parsed.toISOString();
}

/**
 * Whether that calendar day exists. `Date` rolls a nonexistent one forward —
 * "2026-02-30" becomes March 2nd — so a bound naming a day that never happened
 * would otherwise be accepted as a different day.
 */
function isRealDate(year: string, month: string, day: string): boolean {
  const utc = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    utc.getUTCFullYear() === Number(year) &&
    utc.getUTCMonth() === Number(month) - 1 &&
    utc.getUTCDate() === Number(day)
  );
}

/** ?limit= is 'all' or a number; anything unparseable falls back to 50. */
function parseLimit(limit: string | undefined): number | 'all' {
  if (limit === 'all') return 'all';
  const parsed = Number.parseInt(limit ?? '', 10);
  return Number.isNaN(parsed) ? DEFAULT_LIMIT : parsed;
}
