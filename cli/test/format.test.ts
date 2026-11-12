import { describe, expect, it } from 'vitest';

import {
  columns,
  describeDuration,
  describeKeyEnd,
  describeSize,
} from '../src/format.js';

describe('describeKeyEnd', () => {
  const now = new Date('2026-11-03T12:00:00.000Z');

  it('says a key minted a moment ago for 90 days ends in 90 days', () => {
    expect(describeKeyEnd('2027-02-01T11:59:58.000Z', now)).toBe(
      '2027-02-01 (in 90 days)',
    );
  });

  it('says one day in the singular, and less than a day under twelve hours', () => {
    expect(describeKeyEnd('2026-11-04T12:00:00.000Z', now)).toBe(
      '2026-11-04 (in 1 day)',
    );
    expect(describeKeyEnd('2026-11-03T20:00:00.000Z', now)).toBe(
      '2026-11-03 (in less than a day)',
    );
  });

  it('says a key past its end has ended, and one with no end never ends', () => {
    expect(describeKeyEnd('2026-11-01T00:00:00.000Z', now)).toBe(
      '2026-11-01 (ended)',
    );
    expect(describeKeyEnd(null, now)).toBe('never');
  });
});

describe('columns', () => {
  it('pads every label to the longest plus two spaces', () => {
    expect(
      columns([
        ['Instance', 'https://cloud.acme.dev'],
        ['Logged in as', 'sam@acme.dev'],
      ]),
    ).toBe(
      'Instance      https://cloud.acme.dev\nLogged in as  sam@acme.dev\n',
    );
  });
});

describe('describeSize', () => {
  it('says bytes, kB, MB and GB in decimal units with one decimal', () => {
    expect(describeSize(0)).toBe('0 B');
    expect(describeSize(999)).toBe('999 B');
    expect(describeSize(98_500)).toBe('98.5 kB');
    expect(describeSize(3_140_000)).toBe('3.1 MB');
    expect(describeSize(100_000_000)).toBe('100.0 MB');
    expect(describeSize(2_500_000_000)).toBe('2.5 GB');
  });
});

describe('describeDuration', () => {
  it('says seconds under a minute, then minutes and seconds', () => {
    expect(describeDuration(400)).toBe('0s');
    expect(describeDuration(42_000)).toBe('42s');
    expect(describeDuration(102_000)).toBe('1m 42s');
    expect(describeDuration(3_600_000)).toBe('60m 0s');
  });
});
