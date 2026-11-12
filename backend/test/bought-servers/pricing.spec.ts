import {
  backupsPrice,
  DEFAULT_SERVER_MARKUP_PERCENT,
  serverPrice,
  storagePrice,
  tidyUsd,
} from '../../src/bought-servers/pricing';

/**
 * The expected figures are worked by hand from ADR-0071's rule, not by the
 * module's own arithmetic: the USD list (plus the IPv4 charge for a Server),
 * times one plus the Server markup, rounded up to a whole dollar, or to a
 * multiple of 5 dollars above 100.
 */
describe('tidyUsd', () => {
  it.each([
    [0.01, 1],
    [8.508, 9],
    [9, 9],
    [9.000001, 10],
    [99.2, 100],
    [100, 100],
  ])('rounds %d up to a whole dollar at or under 100: %d', (raw, tidy) => {
    expect(tidyUsd(raw)).toBe(tidy);
  });

  it.each([
    [100.01, 105],
    [100.99, 105],
    [105, 105],
    [105.01, 110],
    [121.308, 125],
    [1209.588, 1210],
  ])('rounds %d up to a multiple of 5 above 100: %d', (raw, tidy) => {
    expect(tidyUsd(raw)).toBe(tidy);
  });

  it('is not pushed up a dollar by binary noise on an exact figure', () => {
    // 0.1 + 0.2 is 0.30000000000000004 in binary; ×10 lands a hair over 3.
    expect(tidyUsd((0.1 + 0.2) * 10)).toBe(3);
  });
});

describe('serverPrice', () => {
  it('adds the IPv4 charge to the list price before the markup', () => {
    // (6.49 + 0.60) × 1.2 = 8.508 → $9
    expect(
      serverPrice({ listMonthly: 6.49, ipv4Monthly: 0.6, markupPercent: 20 }),
    ).toBe(9);
  });

  it('takes the $5 step once the marked-up price is over $100', () => {
    // (100.49 + 0.60) × 1.2 = 121.308 → $125
    expect(
      serverPrice({ listMonthly: 100.49, ipv4Monthly: 0.6, markupPercent: 20 }),
    ).toBe(125);
  });

  it('defaults the Server markup to 20%', () => {
    expect(DEFAULT_SERVER_MARKUP_PERCENT).toBe(20);
  });
});

describe('backupsPrice', () => {
  it("prices backups off the server's own list price, without the IPv4", () => {
    // 22.99 × 20% = 4.598; × 1.2 = 5.5176 → $6
    expect(
      backupsPrice({
        listMonthly: 22.99,
        backupPercent: 20,
        markupPercent: 20,
      }),
    ).toBe(6);
  });
});

describe('storagePrice', () => {
  it('prices extra storage by the GB, then rounds the whole', () => {
    // 100 GB × 0.0767 = 7.67; × 1.2 = 9.204 → $10
    expect(
      storagePrice({ sizeGb: 100, perGbMonthly: 0.0767, markupPercent: 20 }),
    ).toBe(10);
    // 2000 GB × 0.0767 = 153.4; × 1.2 = 184.08 → $185
    expect(
      storagePrice({ sizeGb: 2000, perGbMonthly: 0.0767, markupPercent: 20 }),
    ).toBe(185);
  });
});
