import { BadRequestException } from '@nestjs/common';
import { parseMetricsRange } from '../../src/monitoring/metrics-window';

// The agent's ?limit= semantics and the ?start=/&end= window it never had.
// Expectations are the documented rules, written out as literals: a
// caller that sends no window is capped at 50 exactly as before, a caller
// that sends a window is bounded by the window unless it also sends a cap.
describe('parseMetricsRange', () => {
  describe('without a window (the behaviour that already had callers)', () => {
    it('defaults to the last 50 samples', () => {
      expect(parseMetricsRange({})).toEqual({ window: {}, limit: 50 });
    });

    it('keeps an explicit count, "all", and the fallback for junk', () => {
      expect(parseMetricsRange({ limit: '2' })).toEqual({
        window: {},
        limit: 2,
      });
      expect(parseMetricsRange({ limit: 'all' })).toEqual({
        window: {},
        limit: 'all',
      });
      expect(parseMetricsRange({ limit: 'bananas' })).toEqual({
        window: {},
        limit: 50,
      });
    });

    it('reads empty bounds as no window at all', () => {
      expect(parseMetricsRange({ start: '', end: '' })).toEqual({
        window: {},
        limit: 50,
      });
    });
  });

  describe('with a window', () => {
    it('drops the 50-sample default, because the window is already the bound', () => {
      expect(
        parseMetricsRange({
          start: '2026-07-24T02:00:00Z',
          end: '2026-07-24T03:00:00Z',
        }),
      ).toEqual({
        window: {
          start: '2026-07-24T02:00:00.000Z',
          end: '2026-07-24T03:00:00.000Z',
        },
        limit: 'all',
      });
    });

    it('accepts one open end', () => {
      expect(parseMetricsRange({ start: '2026-07-24T02:00:00Z' })).toEqual({
        window: { start: '2026-07-24T02:00:00.000Z' },
        limit: 'all',
      });
      expect(parseMetricsRange({ end: '2026-07-24T03:00:00Z' })).toEqual({
        window: { end: '2026-07-24T03:00:00.000Z' },
        limit: 'all',
      });
    });

    it('still honours an explicit cap inside the window', () => {
      expect(
        parseMetricsRange({
          start: '2026-07-24T02:00:00Z',
          end: '2026-07-24T03:00:00Z',
          limit: '10',
        }),
      ).toEqual({
        window: {
          start: '2026-07-24T02:00:00.000Z',
          end: '2026-07-24T03:00:00.000Z',
        },
        limit: 10,
      });
      expect(
        parseMetricsRange({ start: '2026-07-24T02:00:00Z', limit: 'all' }),
      ).toEqual({
        window: { start: '2026-07-24T02:00:00.000Z' },
        limit: 'all',
      });
    });

    it('allows a zero-length window — one instant is a legal question', () => {
      expect(
        parseMetricsRange({
          start: '2026-07-24T02:00:00Z',
          end: '2026-07-24T02:00:00Z',
        }),
      ).toEqual({
        window: {
          start: '2026-07-24T02:00:00.000Z',
          end: '2026-07-24T02:00:00.000Z',
        },
        limit: 'all',
      });
    });
  });

  // The stored timestamps are UTC ISO strings compared as text, so a bound has
  // to be moved onto that scale before it can be compared at all.
  describe('normalisation', () => {
    it('resolves an offset onto the stored UTC scale', () => {
      expect(
        parseMetricsRange({
          start: '2026-07-24T04:00:00+02:00',
          end: '2026-07-23T21:30:00-05:00',
        }),
      ).toEqual({
        window: {
          start: '2026-07-24T02:00:00.000Z',
          end: '2026-07-24T02:30:00.000Z',
        },
        limit: 'all',
      });
    });

    it('reads a bound with no zone as UTC rather than as server-local time', () => {
      expect(parseMetricsRange({ start: '2026-07-24T02:00:00' })).toEqual({
        window: { start: '2026-07-24T02:00:00.000Z' },
        limit: 'all',
      });
    });

    it('accepts minute precision and sub-second precision', () => {
      expect(
        parseMetricsRange({
          start: '2026-07-24T02:00Z',
          end: '2026-07-24T03:00:00.250Z',
        }),
      ).toEqual({
        window: {
          start: '2026-07-24T02:00:00.000Z',
          end: '2026-07-24T03:00:00.250Z',
        },
        limit: 'all',
      });
    });
  });

  // ADR 0005: an unanswerable question is a 400, not an empty list that reads
  // as "this host did nothing".
  describe('refusals', () => {
    it.each([
      ['bananas'],
      ['24/07/2026'],
      ['2026-07-24'],
      ['1753322400'],
      ['2026-13-01T00:00:00Z'],
      ['2026-02-30T00:00:00Z'],
      ['2026-07-24T25:00:00Z'],
    ])('refuses %s as a bound', (value) => {
      expect(() => parseMetricsRange({ start: value })).toThrow(
        BadRequestException,
      );
      expect(() => parseMetricsRange({ end: value })).toThrow(
        BadRequestException,
      );
    });

    it('names the offending parameter and value', () => {
      expect(() => parseMetricsRange({ end: 'bananas' })).toThrow(
        /end.*bananas/,
      );
    });

    it('refuses a window that ends before it starts', () => {
      expect(() =>
        parseMetricsRange({
          start: '2026-07-24T03:00:00Z',
          end: '2026-07-24T02:00:00Z',
        }),
      ).toThrow(BadRequestException);
      expect(() =>
        parseMetricsRange({
          start: '2026-07-24T03:00:00Z',
          end: '2026-07-24T02:00:00Z',
        }),
      ).toThrow(/end .* before start/);
    });

    it('refuses an inverted window written across two offsets', () => {
      // 03:00+02:00 is 01:00Z, which is before the 02:00Z start.
      expect(() =>
        parseMetricsRange({
          start: '2026-07-24T02:00:00Z',
          end: '2026-07-24T03:00:00+02:00',
        }),
      ).toThrow(BadRequestException);
    });
  });
});
