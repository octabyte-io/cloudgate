import type {
  HetznerLocation,
  HetznerPricing,
  HetznerServerType,
} from './hetzner/hetzner-cloud.port';
import { backupsPrice, serverPrice } from './pricing';

/**
 * What the *Buy a Server* page is drawn from: every Location, every size
 * with its tidy price wherever it is sold, and extra storage's terms. Pure,
 * so the shaping is a unit and the service only reads and caches.
 *
 * **No provider code reaches a customer's screen.** A size's `id` is the
 * provider's type name, because a purchase must name one, but the console
 * describes a size by what it is (`3 vCPU · 4 GB RAM · 80 GB disk`) and its
 * family, never by its id; the Location's `id` likewise.
 */

/** How a size is grouped on the page, each with a one-line hint there. */
export type SizeFamily = 'shared' | 'arm' | 'amd' | 'dedicated';

const FAMILY_ORDER: SizeFamily[] = ['shared', 'arm', 'amd', 'dedicated'];

export interface CatalogueLocation {
  id: string;
  city: string;
  /** ISO 3166-1 alpha-2; the console names it. */
  country: string;
  latitude: number;
  longitude: number;
}

/** One size in one Location: its prices, and whether it can be bought there now. */
export interface CatalogueOffer {
  locationId: string;
  /**
   * The provider's hint that it can be bought there now. Not a promise: a
   * create can still be refused, which is the retry-then-refund path.
   */
  available: boolean;
  /** Whole US dollars a month. */
  monthly: number;
  backupsMonthly: number;
}

export interface CatalogueSize {
  id: string;
  family: SizeFamily;
  vcpus: number;
  memoryGb: number;
  diskGb: number;
  /** Only the Locations it is sold in; a Location missing here does not offer it at all. */
  offers: CatalogueOffer[];
}

export interface BoughtServerCatalogue {
  locations: CatalogueLocation[];
  sizes: CatalogueSize[];
  storage: {
    minGb: number;
    maxGb: number;
    /**
     * The marked-up price of one GB a month, not rounded: a size's price is
     * this times its GB, rounded up once, as the pricing module rounds it.
     */
    perGbMonthly: number;
  };
}

/**
 * The provider's Volume limits: "The minimum Volume size is 10GB and the
 * maximum size is 10TB (10240GB)" (Hetzner Cloud API, `create_volume`,
 * https://docs.hetzner.cloud/cloud.spec.json).
 */
export const STORAGE_MIN_GB = 10;
export const STORAGE_MAX_GB = 10240;

/**
 * The family a size belongs to. Dedicated cores and Arm are facts the
 * provider states on the type; Intel and AMD shared cores are not, so they
 * are told apart by the AMD line's name prefix, the one place the provider's
 * naming is read.
 */
function familyOf(type: HetznerServerType): SizeFamily {
  if (type.cpuType === 'dedicated') return 'dedicated';
  if (type.architecture === 'arm') return 'arm';
  return type.name.startsWith('cpx') ? 'amd' : 'shared';
}

/** Every size with its prices in each Location it is sold, from the USD account's answers. */
export function shapeCatalogue(input: {
  serverTypes: HetznerServerType[];
  locations: HetznerLocation[];
  pricing: HetznerPricing;
  markupPercent: number;
  now: Date;
}): BoughtServerCatalogue {
  const { pricing, markupPercent, now } = input;
  const ipv4 = new Map(
    pricing.primaryIps
      .filter((ip) => ip.type === 'ipv4')
      .map((ip) => [ip.location, Number(ip.monthlyNet)]),
  );
  const backupPercent = Number(pricing.serverBackupPercentage);

  const sizes = input.serverTypes
    .map((type): CatalogueSize => {
      const offers = type.locations.flatMap((listed): CatalogueOffer[] => {
        // Past its last day there, the provider will never sell it there again.
        if (listed.unavailableAfter && new Date(listed.unavailableAfter) <= now)
          return [];
        const price = type.prices.find((p) => p.location === listed.name);
        const ip = ipv4.get(listed.name);
        // A size that cannot be priced honestly is not offered.
        if (!price || ip === undefined) return [];
        const listMonthly = Number(price.monthlyNet);
        return [
          {
            locationId: listed.name,
            available: listed.available,
            monthly: serverPrice({
              listMonthly,
              ipv4Monthly: ip,
              markupPercent,
            }),
            backupsMonthly: backupsPrice({
              listMonthly,
              backupPercent,
              markupPercent,
            }),
          },
        ];
      });
      return {
        id: type.name,
        family: familyOf(type),
        vcpus: type.cores,
        memoryGb: type.memoryGb,
        diskGb: type.diskGb,
        offers,
      };
    })
    .filter((size) => size.offers.length > 0)
    .sort(
      (a, b) =>
        FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family) ||
        a.vcpus - b.vcpus ||
        a.memoryGb - b.memoryGb ||
        a.diskGb - b.diskGb,
    );

  return {
    locations: input.locations.map((location) => ({
      id: location.name,
      city: location.city,
      country: location.country,
      latitude: location.latitude,
      longitude: location.longitude,
    })),
    sizes,
    storage: {
      minGb: STORAGE_MIN_GB,
      maxGb: STORAGE_MAX_GB,
      perGbMonthly:
        Math.round(
          Number(pricing.volumePerGbMonthNet) * (100 + markupPercent) * 1e4,
        ) / 1e6,
    },
  };
}
