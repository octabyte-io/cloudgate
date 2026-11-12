import {
  dueExpiryWarning,
  EXPIRY_WARNING_DAYS,
  isDueForRecheck,
  isLapsed,
  isWithinDaysOfExpiry,
  RECHECK_WINDOW_DAYS,
} from '../../../src/enterprise/license/license-expiry';

// Where a license stands against its validUntil, at a fixed moment.

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2027-03-01T10:00:00Z');
const day = (n: number) => new Date(T0.getTime() + n * DAY);

describe('isLapsed', () => {
  it('is false until validUntil and true from it on', () => {
    expect(isLapsed(day(1), day(0.9))).toBe(false);
    expect(isLapsed(day(1), day(1))).toBe(true);
    expect(isLapsed(day(1), day(40))).toBe(true);
  });

  it('never lapses a license with no expiry', () => {
    expect(isLapsed(null, day(10_000))).toBe(false);
  });
});

describe('isWithinDaysOfExpiry', () => {
  it('opens exactly N days before validUntil', () => {
    expect(isWithinDaysOfExpiry(day(14), 3, day(10.9))).toBe(false);
    expect(isWithinDaysOfExpiry(day(14), 3, day(11))).toBe(true);
    expect(isWithinDaysOfExpiry(day(14), 3, day(13.9))).toBe(true);
  });

  it('stays open once the license has lapsed', () => {
    expect(isWithinDaysOfExpiry(day(14), 3, day(30))).toBe(true);
  });

  it('is never open for a license with no expiry', () => {
    expect(isWithinDaysOfExpiry(null, 3, day(0))).toBe(false);
  });
});

describe('isDueForRecheck', () => {
  it('waits for the last 14 days', () => {
    expect(RECHECK_WINDOW_DAYS).toBe(14);
    // Day 20 before the date: no call to the license server.
    expect(isDueForRecheck(day(20), day(0))).toBe(false);
    expect(isDueForRecheck(day(14), day(-0.1))).toBe(false);
    expect(isDueForRecheck(day(14), day(0))).toBe(true);
  });

  it('keeps rechecking while lapsed', () => {
    expect(isDueForRecheck(day(0), day(1))).toBe(true);
    expect(isDueForRecheck(day(0), day(90))).toBe(true);
  });

  it('never rechecks a license with no expiry', () => {
    expect(isDueForRecheck(null, day(0))).toBe(false);
  });
});

describe('dueExpiryWarning', () => {
  const none = { warned14For: null, warned3For: null };

  it('owes nothing more than 14 days out', () => {
    expect(EXPIRY_WARNING_DAYS).toEqual([14, 3]);
    expect(dueExpiryWarning(day(20), none, day(0))).toBeNull();
    expect(dueExpiryWarning(day(14), none, day(-0.1))).toBeNull();
  });

  it('owes the 14-day warning from 14 days out, once per validUntil', () => {
    expect(dueExpiryWarning(day(14), none, day(0))).toBe(14);
    expect(
      dueExpiryWarning(day(14), { ...none, warned14For: day(14) }, day(5)),
    ).toBeNull();
  });

  it('owes the 3-day warning from 3 days out, once per validUntil', () => {
    const after14 = { ...none, warned14For: day(14) };
    expect(dueExpiryWarning(day(14), after14, day(10.9))).toBeNull();
    expect(dueExpiryWarning(day(14), after14, day(11))).toBe(3);
    expect(
      dueExpiryWarning(
        day(14),
        { warned14For: day(14), warned3For: day(14) },
        day(12),
      ),
    ).toBeNull();
  });

  it('sends only the 3-day warning when both are owed at once', () => {
    expect(dueExpiryWarning(day(2), none, day(0))).toBe(3);
  });

  it('owes nothing once lapsed, or for a license with no expiry', () => {
    expect(dueExpiryWarning(day(1), none, day(1))).toBeNull();
    expect(dueExpiryWarning(null, none, day(0))).toBeNull();
  });

  // A renewal writes a new validUntil, which the stored marks no longer match.
  it('re-arms both warnings when validUntil moves', () => {
    const warnedForOld = { warned14For: day(14), warned3For: day(14) };
    expect(dueExpiryWarning(day(379), warnedForOld, day(366))).toBe(14);
    expect(dueExpiryWarning(day(379), warnedForOld, day(377))).toBe(3);
  });
});
