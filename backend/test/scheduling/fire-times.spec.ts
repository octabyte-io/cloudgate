import { nextFireTimes } from '../../src/scheduling/fire-times';

/**
 * When a Cron service fires (ADR-0034): the AWS daylight-saving rule.
 * New York goes from 02:00 EST straight to 03:00 EDT on 2026-03-08, and from
 * 02:00 EDT back to 01:00 EST on 2026-11-01, so 01:00-01:59 happens twice.
 */
const NEW_YORK = 'America/New_York';

function fires(
  schedule: string,
  timezone: string,
  after: string,
  count: number,
): string[] {
  return nextFireTimes(schedule, timezone, new Date(after), count).map((d) =>
    d.toISOString(),
  );
}

describe('nextFireTimes', () => {
  it('fires at the named clock time in the named time zone', () => {
    expect(
      fires('30 3 * * *', 'Europe/Berlin', '2026-06-01T00:00:00Z', 2),
    ).toEqual(['2026-06-01T01:30:00.000Z', '2026-06-02T01:30:00.000Z']);
  });

  it('reads UTC as UTC', () => {
    expect(fires('*/20 * * * *', 'UTC', '2026-06-01T10:05:00Z', 3)).toEqual([
      '2026-06-01T10:20:00.000Z',
      '2026-06-01T10:40:00.000Z',
      '2026-06-01T11:00:00.000Z',
    ]);
  });

  describe('a clock time that does not exist that day', () => {
    it('skips 02:30 in New York on 2026-03-08, rather than firing at 03:30', () => {
      expect(fires('30 2 * * *', NEW_YORK, '2026-03-07T12:00:00Z', 2)).toEqual([
        // 2026-03-07 02:30 EST was before `after`; 03-08 02:30 never happens.
        '2026-03-09T06:30:00.000Z',
        '2026-03-10T06:30:00.000Z',
      ]);
    });

    it('skips every firing in the missing hour, sub-hourly included', () => {
      expect(
        fires('*/20 * * * *', NEW_YORK, '2026-03-08T06:30:00Z', 4),
      ).toEqual([
        '2026-03-08T06:40:00.000Z', // 01:40 EST
        '2026-03-08T07:00:00.000Z', // 03:00 EDT; 02:00, 02:20, 02:40 skipped
        '2026-03-08T07:20:00.000Z',
        '2026-03-08T07:40:00.000Z',
      ]);
    });
  });

  describe('a clock time that happens twice', () => {
    it('fires 01:30 in New York once on 2026-11-01, at its first occurrence', () => {
      expect(fires('30 1 * * *', NEW_YORK, '2026-10-31T12:00:00Z', 2)).toEqual([
        '2026-11-01T05:30:00.000Z', // 01:30 EDT
        '2026-11-02T06:30:00.000Z', // 01:30 EST the next day
      ]);
    });

    it('fires each quarter of the repeated hour once', () => {
      expect(
        fires('*/15 * * * *', NEW_YORK, '2026-11-01T04:50:00Z', 6),
      ).toEqual([
        '2026-11-01T05:00:00.000Z', // 01:00 EDT
        '2026-11-01T05:15:00.000Z',
        '2026-11-01T05:30:00.000Z',
        '2026-11-01T05:45:00.000Z',
        // 01:00-01:45 EST (06:00-06:45Z) are the same clock times again.
        '2026-11-01T07:00:00.000Z', // 02:00 EST
        '2026-11-01T07:15:00.000Z',
      ]);
    });

    it('does not fire the repeat when asked from inside the second pass', () => {
      expect(
        fires('*/15 * * * *', NEW_YORK, '2026-11-01T06:05:00Z', 2),
      ).toEqual(['2026-11-01T07:00:00.000Z', '2026-11-01T07:15:00.000Z']);
    });
  });

  describe('a next time is never in the past', () => {
    it('is strictly after `after`, even when `after` is a firing', () => {
      expect(fires('0 * * * *', 'UTC', '2026-06-01T10:00:00Z', 1)).toEqual([
        '2026-06-01T11:00:00.000Z',
      ]);
    });

    it.each([
      ['*/15 * * * *', NEW_YORK, '2026-11-01T06:05:00Z'],
      ['30 1 * * *', NEW_YORK, '2026-11-01T06:10:00Z'],
      ['30 2 * * *', NEW_YORK, '2026-03-08T07:10:00Z'],
      ['0 0 * * MON', 'Asia/Kolkata', '2026-01-01T00:00:00Z'],
      ['5 4 1 JAN *', 'Australia/Lord_Howe', '2026-02-01T00:00:00Z'],
    ])('holds for %s in %s after %s', (schedule, zone, after) => {
      const found = nextFireTimes(schedule, zone, new Date(after), 5);
      expect(found).toHaveLength(5);
      let previous = new Date(after).getTime();
      for (const time of found) {
        expect(time.getTime()).toBeGreaterThan(previous);
        previous = time.getTime();
      }
    });
  });

  it('reads names, ranges, lists and steps', () => {
    // 2026-06-01 is a Monday.
    expect(
      fires('0 9-17/4 * JUN MON-WED,FRI', 'UTC', '2026-06-01T00:00:00Z', 4),
    ).toEqual([
      '2026-06-01T09:00:00.000Z',
      '2026-06-01T13:00:00.000Z',
      '2026-06-01T17:00:00.000Z',
      '2026-06-02T09:00:00.000Z',
    ]);
  });
});
