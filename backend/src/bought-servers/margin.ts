import type {
  HetznerPricing,
  HetznerServerType,
} from './hetzner/hetzner-cloud.port';

/**
 * A **Bought Server**'s real margin (ADR-0071), pure: its monthly price,
 * less what the provider charges Octabyte for it in EUR, converted at the
 * day's exchange rate. Customers pay in USD and Octabyte pays the provider in
 * EUR, so the margin moves with the rate even when no price does; this is
 * what shows it, and what flags a Bought Server for a reprice.
 */

/** The EUR account's price list, as much of it as a cost needs. */
export interface EurPriceList {
  serverTypes: Array<Pick<HetznerServerType, 'name' | 'prices'>>;
  pricing: HetznerPricing;
}

/** What the provider bills for: the machine as it now is. */
export interface CostedMachine {
  serverType: string;
  location: string;
  backups: boolean;
  storageGb: number | null;
}

/**
 * The provider's monthly EUR cost of the machine: its size there, its
 * Primary IPv4 (IPv6 is free), backups as a percentage of the size's own
 * price, and extra storage per GB. Null when the list does not price it, or
 * is not in EUR: a cost read in the wrong currency would be a wrong margin.
 */
export function eurMonthlyCost(
  machine: CostedMachine,
  list: EurPriceList,
): number | null {
  if (list.pricing.currency !== 'EUR') return null;
  const size = list.serverTypes
    .find((type) => type.name === machine.serverType)
    ?.prices.find((price) => price.location === machine.location);
  const ipv4 = list.pricing.primaryIps.find(
    (ip) => ip.type === 'ipv4' && ip.location === machine.location,
  );
  if (!size || !ipv4) return null;

  const sizeEur = Number(size.monthlyNet);
  const backupsEur = machine.backups
    ? (sizeEur * Number(list.pricing.serverBackupPercentage)) / 100
    : 0;
  const storageEur =
    (machine.storageGb ?? 0) * Number(list.pricing.volumePerGbMonthNet);
  return sizeEur + Number(ipv4.monthlyNet) + backupsEur + storageEur;
}

export interface Margin {
  /** The EUR cost in US cents, at the day's rate. */
  costCents: number;
  /** The price less that cost, in US cents; negative is a loss. */
  marginCents: number;
  /** The margin as a percentage of the price, to one decimal. */
  marginPercent: number;
}

/** The price less the EUR cost at the day's rate (US dollars per euro). */
export function marginOf(input: {
  priceCents: number;
  costEur: number;
  usdPerEur: number;
}): Margin {
  const costCents = Math.round(input.costEur * input.usdPerEur * 100);
  const marginCents = input.priceCents - costCents;
  return {
    costCents,
    marginCents,
    marginPercent:
      input.priceCents > 0
        ? Math.round((marginCents * 1000) / input.priceCents) / 10
        : 0,
  };
}

/**
 * Whether the margin is under the floor (a whole percent of the price).
 * Worked in whole cents, so a margin exactly at the floor is not flagged
 * because of a rounded percentage.
 */
export function belowFloor(
  margin: { priceCents: number; marginCents: number },
  floorPercent: number,
): boolean {
  return margin.marginCents * 100 < floorPercent * margin.priceCents;
}
