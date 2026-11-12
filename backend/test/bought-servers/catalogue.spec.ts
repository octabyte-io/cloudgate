import { shapeCatalogue } from '../../src/bought-servers/catalogue';
import type {
  HetznerLocation,
  HetznerPricing,
  HetznerServerType,
} from '../../src/bought-servers/hetzner/hetzner-cloud.port';

const NOW = new Date('2026-11-10T12:00:00Z');

const LOCATIONS: HetznerLocation[] = [
  {
    id: 1,
    name: 'fsn1',
    description: 'Falkenstein DC Park 1',
    country: 'DE',
    city: 'Falkenstein',
    latitude: 50.47612,
    longitude: 12.370071,
    networkZone: 'eu-central',
  },
  {
    id: 4,
    name: 'ash',
    description: 'Ashburn, VA',
    country: 'US',
    city: 'Ashburn, VA',
    latitude: 39.045821,
    longitude: -77.487073,
    networkZone: 'us-east',
  },
];

const PRICING: HetznerPricing = {
  currency: 'USD',
  primaryIps: [
    { type: 'ipv4', location: 'fsn1', monthlyNet: '0.6000000000' },
    { type: 'ipv6', location: 'fsn1', monthlyNet: '0.0000000000' },
    { type: 'ipv4', location: 'ash', monthlyNet: '0.6000000000' },
  ],
  volumePerGbMonthNet: '0.0767000000',
  serverBackupPercentage: '20.0000000000',
};

function type(
  overrides: Partial<HetznerServerType> & Pick<HetznerServerType, 'name'>,
): HetznerServerType {
  return {
    id: 1,
    cores: 2,
    memoryGb: 4,
    diskGb: 40,
    storageType: 'local',
    cpuType: 'shared',
    architecture: 'x86',
    locations: [],
    prices: [],
    ...overrides,
  };
}

const CPX22 = type({
  name: 'cpx22',
  cores: 3,
  memoryGb: 4,
  diskGb: 80,
  locations: [
    { name: 'fsn1', available: true, unavailableAfter: null },
    { name: 'ash', available: false, unavailableAfter: null },
  ],
  prices: [
    { location: 'fsn1', monthlyNet: '22.9900000000' },
    { location: 'ash', monthlyNet: '19.4900000000' },
  ],
});

describe('shapeCatalogue', () => {
  it('lists every Location with its city, country and coordinates', () => {
    const catalogue = shapeCatalogue({
      serverTypes: [CPX22],
      locations: LOCATIONS,
      pricing: PRICING,
      markupPercent: 20,
      now: NOW,
    });

    expect(catalogue.locations).toEqual([
      {
        id: 'fsn1',
        city: 'Falkenstein',
        country: 'DE',
        latitude: 50.47612,
        longitude: 12.370071,
      },
      {
        id: 'ash',
        city: 'Ashburn, VA',
        country: 'US',
        latitude: 39.045821,
        longitude: -77.487073,
      },
    ]);
  });

  it('prices a size per Location, with its backups, and says where it cannot be bought now', () => {
    const [size] = shapeCatalogue({
      serverTypes: [CPX22],
      locations: LOCATIONS,
      pricing: PRICING,
      markupPercent: 20,
      now: NOW,
    }).sizes;

    expect(size).toEqual({
      id: 'cpx22',
      family: 'amd',
      vcpus: 3,
      memoryGb: 4,
      diskGb: 80,
      offers: [
        // (22.99 + 0.60) × 1.2 = 28.308 → 29; 22.99 × 0.2 × 1.2 = 5.5176 → 6
        { locationId: 'fsn1', available: true, monthly: 29, backupsMonthly: 6 },
        // (19.49 + 0.60) × 1.2 = 24.108 → 25; 19.49 × 0.2 × 1.2 = 4.6776 → 5
        {
          locationId: 'ash',
          available: false,
          monthly: 25,
          backupsMonthly: 5,
        },
      ],
    });
  });

  it('prices with the markup it is given', () => {
    const [size] = shapeCatalogue({
      serverTypes: [CPX22],
      locations: LOCATIONS,
      pricing: PRICING,
      markupPercent: 50,
      now: NOW,
    }).sizes;

    // (22.99 + 0.60) × 1.5 = 35.385 → 36
    expect(size.offers[0].monthly).toBe(36);
  });

  it('leaves out a Location the size is past its last day in, or has no price in', () => {
    const retiring = type({
      name: 'cx23',
      locations: [
        {
          name: 'fsn1',
          available: true,
          unavailableAfter: '2026-01-01T00:00:00Z',
        },
        {
          name: 'ash',
          available: true,
          unavailableAfter: '2027-01-01T00:00:00Z',
        },
      ],
      prices: [
        { location: 'fsn1', monthlyNet: '6.4900000000' },
        { location: 'ash', monthlyNet: '6.4900000000' },
      ],
    });
    const unpriced = type({
      name: 'cx33',
      locations: [{ name: 'ash', available: true, unavailableAfter: null }],
      prices: [],
    });

    const { sizes } = shapeCatalogue({
      serverTypes: [retiring, unpriced],
      locations: LOCATIONS,
      pricing: PRICING,
      markupPercent: 20,
      now: NOW,
    });

    expect(sizes.map((size) => size.id)).toEqual(['cx23']);
    expect(sizes[0].offers.map((offer) => offer.locationId)).toEqual(['ash']);
  });

  it('groups sizes as Shared, Shared Arm, Shared AMD and Dedicated, smallest first', () => {
    const { sizes } = shapeCatalogue({
      serverTypes: [
        type({ ...CPX22, name: 'ccx13', cpuType: 'dedicated', cores: 2 }),
        type({ ...CPX22, name: 'cax21', architecture: 'arm', cores: 4 }),
        type({ ...CPX22, name: 'cax11', architecture: 'arm', cores: 2 }),
        CPX22,
        type({ ...CPX22, name: 'cx23', cores: 2 }),
      ],
      locations: LOCATIONS,
      pricing: PRICING,
      markupPercent: 20,
      now: NOW,
    });

    expect(sizes.map((size) => [size.id, size.family])).toEqual([
      ['cx23', 'shared'],
      ['cax11', 'arm'],
      ['cax21', 'arm'],
      ['cpx22', 'amd'],
      ['ccx13', 'dedicated'],
    ]);
  });

  it("gives extra storage's limits and its marked-up price per GB", () => {
    const { storage } = shapeCatalogue({
      serverTypes: [CPX22],
      locations: LOCATIONS,
      pricing: PRICING,
      markupPercent: 20,
      now: NOW,
    });

    // 0.0767 × 1.2
    expect(storage).toEqual({ minGb: 10, maxGb: 10240, perGbMonthly: 0.09204 });
  });
});
