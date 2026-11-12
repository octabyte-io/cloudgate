import {
  belowFloor,
  eurMonthlyCost,
  marginOf,
} from '../../src/bought-servers/margin';
import type { EurPriceList } from '../../src/bought-servers/margin';

/**
 * A Bought Server's real margin (ADR-0071, spec #1387): its monthly price,
 * less the provider's EUR cost converted at the day's exchange rate. The
 * expected figures are worked by hand.
 */
const EUR_LIST: EurPriceList = {
  serverTypes: [
    {
      name: 'cpx22',
      prices: [
        { location: 'hel1', monthlyNet: '16.4900000000' },
        { location: 'fsn1', monthlyNet: '19.4900000000' },
      ],
    },
  ],
  pricing: {
    currency: 'EUR',
    primaryIps: [
      { type: 'ipv4', location: 'hel1', monthlyNet: '0.5000' },
      { type: 'ipv6', location: 'hel1', monthlyNet: '0.0000' },
      { type: 'ipv4', location: 'fsn1', monthlyNet: '0.5000' },
    ],
    volumePerGbMonthNet: '0.0572',
    serverBackupPercentage: '20.0000000000',
  },
};

describe('eurMonthlyCost', () => {
  it('is the size there and its Primary IPv4', () => {
    // 16.49 + 0.50
    expect(
      eurMonthlyCost(
        {
          serverType: 'cpx22',
          location: 'hel1',
          backups: false,
          storageGb: null,
        },
        EUR_LIST,
      ),
    ).toBeCloseTo(16.99, 6);
  });

  it('adds the backups percentage of the size alone, and the extra storage per GB', () => {
    // 16.49 + 0.50 + 20% of 16.49 (3.298) + 100 × 0.0572 (5.72)
    expect(
      eurMonthlyCost(
        {
          serverType: 'cpx22',
          location: 'hel1',
          backups: true,
          storageGb: 100,
        },
        EUR_LIST,
      ),
    ).toBeCloseTo(26.008, 6);
  });

  it('is unknown for a size or Location the EUR list does not price', () => {
    expect(
      eurMonthlyCost(
        {
          serverType: 'cpx22',
          location: 'sin',
          backups: false,
          storageGb: null,
        },
        EUR_LIST,
      ),
    ).toBeNull();
    expect(
      eurMonthlyCost(
        {
          serverType: 'ccx99',
          location: 'hel1',
          backups: false,
          storageGb: null,
        },
        EUR_LIST,
      ),
    ).toBeNull();
  });

  it('refuses a price list that is not in EUR, rather than read dollars as euros', () => {
    expect(
      eurMonthlyCost(
        {
          serverType: 'cpx22',
          location: 'hel1',
          backups: false,
          storageGb: null,
        },
        { ...EUR_LIST, pricing: { ...EUR_LIST.pricing, currency: 'USD' } },
      ),
    ).toBeNull();
  });
});

describe('marginOf', () => {
  it('is the price less the EUR cost at the day rate, in cents and percent of the price', () => {
    // 16.99 EUR × 1.16 = 19.7084 USD → 1971 cents; 2500 − 1971 = 529; 529 / 2500 = 21.16%
    expect(
      marginOf({ priceCents: 2500, costEur: 16.99, usdPerEur: 1.16 }),
    ).toEqual({ costCents: 1971, marginCents: 529, marginPercent: 21.2 });
  });

  it('goes negative when the cost passes the price', () => {
    // 26.008 × 1.20 = 31.2096 → 3121 cents; 2500 − 3121 = −621; −24.84%
    expect(
      marginOf({ priceCents: 2500, costEur: 26.008, usdPerEur: 1.2 }),
    ).toEqual({ costCents: 3121, marginCents: -621, marginPercent: -24.8 });
  });

  it('moves with the rate though no price changed', () => {
    const weak = marginOf({
      priceCents: 2500,
      costEur: 16.99,
      usdPerEur: 1.05,
    });
    const strong = marginOf({
      priceCents: 2500,
      costEur: 16.99,
      usdPerEur: 1.4,
    });
    expect(weak.marginCents).toBeGreaterThan(strong.marginCents);
  });
});

describe('belowFloor', () => {
  it('flags a margin under the floor', () => {
    expect(belowFloor({ priceCents: 2500, marginCents: 249 }, 10)).toBe(true);
  });

  it('does not flag a margin exactly at the floor, worked in whole cents', () => {
    // 250 of 2500 is exactly 10%.
    expect(belowFloor({ priceCents: 2500, marginCents: 250 }, 10)).toBe(false);
  });

  it('does not flag a margin above the floor', () => {
    expect(belowFloor({ priceCents: 2500, marginCents: 529 }, 10)).toBe(false);
  });

  it('flags any loss, even with a floor of zero', () => {
    expect(belowFloor({ priceCents: 2500, marginCents: -1 }, 0)).toBe(true);
  });
});
