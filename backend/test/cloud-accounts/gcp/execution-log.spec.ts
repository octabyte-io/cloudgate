import {
  afterPlace,
  logPlaceOf,
  logPlaceText,
  nextLogPlace,
} from '../../../src/cloud-accounts/gcp/execution-log';
import type { LogEntry } from '../../../src/cloud-accounts/google-cloud.port';

const entry = (insertId: string, timestamp: string): LogEntry => ({
  insertId,
  timestamp,
  logName: 'projects/p/logs/run.googleapis.com%2Fstdout',
  revision: null,
  instance: null,
  text: insertId,
});

const T1 = '2026-10-27T03:00:01Z';
const T2 = '2026-10-27T03:00:02Z';

/**
 * Where the copy of a Cron run's log on Google Cloud has reached (spec
 * story 40): kept by entry timestamp and insert id, read on from
 * the last copied entry.
 */
describe('nextLogPlace', () => {
  it('has no place before the first entry, and a read that finds nothing keeps none', () => {
    expect(nextLogPlace(null, [])).toBeNull();
  });

  it('leaves the place where it was after a read that finds nothing', () => {
    const from = { timestamp: T1, insertIds: ['a'] };
    expect(nextLogPlace(from, [])).toBe(from);
  });

  it('moves to the last entry copied, holding every entry copied at its instant', () => {
    expect(
      nextLogPlace(null, [entry('a', T1), entry('b', T2), entry('c', T2)]),
    ).toEqual({ timestamp: T2, insertIds: ['b', 'c'] });
  });

  it('keeps what it held at the same instant when more arrive at it', () => {
    expect(
      nextLogPlace({ timestamp: T1, insertIds: ['a'] }, [entry('b', T1)]),
    ).toEqual({ timestamp: T1, insertIds: ['a', 'b'] });
  });
});

describe('afterPlace', () => {
  it('leaves out only the entries at the place’s instant it holds', () => {
    const from = { timestamp: T1, insertIds: ['a'] };
    expect(
      afterPlace([entry('a', T1), entry('b', T1), entry('c', T2)], from).map(
        (one) => one.insertId,
      ),
    ).toEqual(['b', 'c']);
  });
});

describe('logPlaceOf', () => {
  it('reads back as written, and anything else as no place', () => {
    const place = { timestamp: T2, insertIds: ['b', 'c'] };
    expect(logPlaceOf(logPlaceText(place))).toEqual(place);
    expect(logPlaceOf(undefined)).toBeNull();
    expect(logPlaceOf('49038572039485723')).toBeNull();
  });
});
