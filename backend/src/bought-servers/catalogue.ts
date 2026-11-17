import type {
  HetznerImage,
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
  /** What a **Server image** must be built for to be made on it. */
  architecture: 'x86' | 'arm';
  vcpus: number;
  memoryGb: number;
  diskGb: number;
  /** Only the Locations it is sold in; a Location missing here does not offer it at all. */
  offers: CatalogueOffer[];
}

/** One **Server image**: an OS and version a Bought Server can be made from. */
export interface CatalogueImage {
  /** What Buy names, `ubuntu-24.04`. */
  id: string;
  /** `Ubuntu 24.04`. */
  label: string;
  /** The architectures it is built for; a size of another cannot use it. */
  architectures: Array<'x86' | 'arm'>;
}

export interface BoughtServerCatalogue {
  locations: CatalogueLocation[];
  sizes: CatalogueSize[];
  /** Ubuntu first, then Debian, each newest first. */
  images: CatalogueImage[];
  /** The image a Buy that names none is made from. */
  defaultImage: string;
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

/** The **Server image** a Buy that names none is made from. */
export const BOUGHT_SERVER_IMAGE = 'ubuntu-24.04';

/**
 * The OS flavours offered, in the order they are listed: only those Server
 * setup installs Docker on (`server-setup.ts` automates the Debian family
 * only), so a Server is never sold that its setup cannot finish.
 */
const OFFERED_FLAVORS = ['ubuntu', 'debian'];

/**
 * The provider's system images as **Server images**: Ubuntu and Debian only,
 * one entry per name with every architecture it is built for, Ubuntu first
 * and each flavour newest first.
 */
export function shapeImages(images: readonly HetznerImage[]): CatalogueImage[] {
  const byName = new Map<
    string,
    { image: HetznerImage; architectures: Array<'x86' | 'arm'> }
  >();
  for (const image of images) {
    if (!OFFERED_FLAVORS.includes(image.osFlavor)) continue;
    const entry = byName.get(image.name);
    if (entry) {
      if (!entry.architectures.includes(image.architecture)) {
        entry.architectures.push(image.architecture);
      }
    } else {
      byName.set(image.name, { image, architectures: [image.architecture] });
    }
  }
  const version = (image: HetznerImage) =>
    (image.osVersion ?? '').split('.').map(Number);
  const newer = (a: HetznerImage, b: HetznerImage) => {
    const [x, y] = [version(a), version(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const diff = (y[i] ?? 0) - (x[i] ?? 0);
      if (diff) return diff;
    }
    return 0;
  };
  return [...byName.values()]
    .sort(
      (a, b) =>
        OFFERED_FLAVORS.indexOf(a.image.osFlavor) -
          OFFERED_FLAVORS.indexOf(b.image.osFlavor) || newer(a.image, b.image),
    )
    .map(({ image, architectures }) => ({
      id: image.name,
      label: image.description,
      architectures: (['x86', 'arm'] as const).filter((arch) =>
        architectures.includes(arch),
      ),
    }));
}

/** Every size with its prices in each Location it is sold, from the USD account's answers. */
export function shapeCatalogue(input: {
  serverTypes: HetznerServerType[];
  locations: HetznerLocation[];
  pricing: HetznerPricing;
  /** The provider's system images; none when only prices are being shaped. */
  images?: HetznerImage[];
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
        architecture: type.architecture,
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
    images: shapeImages(input.images ?? []),
    defaultImage: BOUGHT_SERVER_IMAGE,
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
