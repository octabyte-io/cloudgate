import {
  dueLines,
  listedCents,
  repriceOf,
} from '../../src/bought-servers/reprice';
import type { UsdPriceList } from '../../src/bought-servers/reprice';

/**
 * An Operator's reprice of Bought Servers already sold (ADR-0071, #1400):
 * each line at the current USD list plus the current Server markup, rounded
 * as a purchase is; a rise starts 30 days later, a fall at once. The
 * expected figures are worked by hand.
 */
const USD_LIST: UsdPriceList = {
  serverTypes: [
    {
      name: 'cpx22',
      prices: [{ location: 'hel1', monthlyNet: '19.4900000000' }],
    },
  ],
  pricing: {
    currency: 'USD',
    primaryIps: [
      { type: 'ipv4', location: 'hel1', monthlyNet: '0.6000' },
      { type: 'ipv6', location: 'hel1', monthlyNet: '0.0000' },
    ],
    volumePerGbMonthNet: '0.0767',
    serverBackupPercentage: '20.0000000000',
  },
};

const MACHINE = { serverType: 'cpx22', location: 'hel1', storageGb: 100 };
const NOW = new Date('2026-11-10T05:17:00Z');

describe('listedCents', () => {
  it('prices a Server at its size and IPv4 there, marked up and rounded up to a dollar', () => {
    // (19.49 + 0.60) × 1.2 = 24.108 → $25
    expect(listedCents(MACHINE, 'server', USD_LIST, 20)).toBe(2500);
    // (19.49 + 0.60) × 1.3 = 26.117 → $27
    expect(listedCents(MACHINE, 'server', USD_LIST, 30)).toBe(2700);
  });

  it('prices backups at their share of the size alone, and storage per GB', () => {
    // 20% of 19.49 = 3.898 × 1.2 = 4.6776 → $5
    expect(listedCents(MACHINE, 'backups', USD_LIST, 20)).toBe(500);
    // 100 × 0.0767 = 7.67 × 1.2 = 9.204 → $10
    expect(listedCents(MACHINE, 'storage', USD_LIST, 20)).toBe(1000);
  });

  it('is null for a size the list no longer prices there, a machine with no storage, or a list not in USD', () => {
    expect(
      listedCents({ ...MACHINE, location: 'fsn1' }, 'server', USD_LIST, 20),
    ).toBeNull();
    expect(
      listedCents({ ...MACHINE, storageGb: null }, 'storage', USD_LIST, 20),
    ).toBeNull();
    expect(
      listedCents(
        MACHINE,
        'server',
        { ...USD_LIST, pricing: { ...USD_LIST.pricing, currency: 'EUR' } },
        20,
      ),
    ).toBeNull();
  });
});

describe('repriceOf', () => {
  it('is a rise starting 30 days later when the lines cost more together', () => {
    const reprice = repriceOf({
      machine: MACHINE,
      lines: [
        { kind: 'server', monthlyCents: 2200 },
        { kind: 'backups', monthlyCents: 500 },
      ],
      list: USD_LIST,
      markupPercent: 20,
      now: NOW,
    });

    expect(reprice).toEqual({
      kind: 'rise',
      oldMonthlyCents: 2700,
      newMonthlyCents: 3000,
      startsAt: new Date('2026-12-10T05:17:00Z'),
      // Only the lines whose price moves.
      lines: [{ kind: 'server', oldMonthlyCents: 2200, newMonthlyCents: 2500 }],
    });
  });

  it('is a fall starting at once when the lines cost less together, even if one of them rises', () => {
    const reprice = repriceOf({
      machine: MACHINE,
      lines: [
        { kind: 'server', monthlyCents: 3000 },
        { kind: 'backups', monthlyCents: 400 },
      ],
      list: USD_LIST,
      markupPercent: 20,
      now: NOW,
    });

    expect(reprice).toEqual({
      kind: 'fall',
      oldMonthlyCents: 3400,
      newMonthlyCents: 3000,
      startsAt: NOW,
      lines: [
        { kind: 'server', oldMonthlyCents: 3000, newMonthlyCents: 2500 },
        { kind: 'backups', oldMonthlyCents: 400, newMonthlyCents: 500 },
      ],
    });
  });

  it('is unchanged when every line already sells at the list price', () => {
    expect(
      repriceOf({
        machine: MACHINE,
        lines: [{ kind: 'server', monthlyCents: 2500 }],
        list: USD_LIST,
        markupPercent: 20,
        now: NOW,
      }),
    ).toEqual({ kind: 'unchanged', monthlyCents: 2500 });
  });

  it('is unpriceable when any line cannot be priced from the list', () => {
    expect(
      repriceOf({
        machine: { ...MACHINE, serverType: 'cx99' },
        lines: [{ kind: 'server', monthlyCents: 2500 }],
        list: USD_LIST,
        markupPercent: 20,
        now: NOW,
      }),
    ).toEqual({ kind: 'unpriceable' });
  });
});

describe('dueLines', () => {
  it('keeps the lines whose next price starts at or before now', () => {
    const lines = [
      { id: 'due', nextMonthlyCents: 2500, nextPriceFrom: NOW },
      {
        id: 'later',
        nextMonthlyCents: 2500,
        nextPriceFrom: new Date(NOW.getTime() + 1),
      },
      { id: 'none', nextMonthlyCents: null, nextPriceFrom: null },
    ];

    expect(dueLines(lines, NOW).map((line) => line.id)).toEqual(['due']);
  });
});
