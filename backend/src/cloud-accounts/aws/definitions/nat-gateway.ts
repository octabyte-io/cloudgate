import { formatUsd } from '../final-snapshot';
import { HOURS_PER_MONTH } from '../../definitions/stack-vm';

/**
 * **The Environment network's NAT gateway** (ADR-0070, as amended by the
 * owner's decision on #1359): a Stack VM has no public address, so its way
 * out — Ubuntu's updates, Docker's packages, image pulls and the Session
 * Manager endpoints — goes through one NAT gateway in the network's first
 * public subnet, with its Elastic IP and the private subnets' default route
 * to it.
 *
 * It is a part of the network made only once a Service needs it, as the
 * private DNS namespace is (`nat-gateway` among `privateLinks`): the first
 * plan that creates a Stack VM in an Environment adds it, and an
 * Environment with no Stack VM keeps the network's idle cost. Removing it
 * once the last Stack VM is deleted is that Delete's (#1367): the kind is
 * dropped from the network's row and the network's next run removes it.
 */
export const NAT_GATEWAY_LINK = 'nat-gateway';

/**
 * What a NAT gateway costs in a region, in US dollars: its hourly price,
 * its Elastic IP's public IPv4 hourly price, and what it charges per GB it
 * carries. Coded, as the Stack VM's rates are (`stack-vm-machines.ts`): the
 * plan has no live price feed. A region not listed plans with no price.
 */
interface NatRates {
  readonly hourlyUsd: number;
  readonly perGbUsd: number;
}

/** A public IPv4 address, in every region. */
const PUBLIC_IPV4_HOURLY_USD = 0.005;

const NAT_RATES: Readonly<Record<string, NatRates>> = {
  'us-east-1': { hourlyUsd: 0.045, perGbUsd: 0.045 },
  'us-east-2': { hourlyUsd: 0.045, perGbUsd: 0.045 },
  'us-west-2': { hourlyUsd: 0.045, perGbUsd: 0.045 },
  'eu-west-1': { hourlyUsd: 0.048, perGbUsd: 0.048 },
  'eu-west-2': { hourlyUsd: 0.05, perGbUsd: 0.05 },
  'eu-central-1': { hourlyUsd: 0.052, perGbUsd: 0.052 },
  'ap-southeast-1': { hourlyUsd: 0.059, perGbUsd: 0.059 },
};

/** The NAT gateway's and its address's monthly price in a region, or `null`. */
export function natMonthlyUsd(region: string): number | null {
  const rates = NAT_RATES[region];
  if (!rates) return null;
  return (
    Math.round(
      (rates.hourlyUsd + PUBLIC_IPV4_HOURLY_USD) * HOURS_PER_MONTH * 100,
    ) / 100
  );
}

/**
 * How a plan line prices it: `about $38.69/month plus $0.048 per GB it
 * carries`, or where the rate table has no price.
 */
export function natCost(region: string | undefined): string {
  const rates = region ? NAT_RATES[region] : undefined;
  const monthly = region ? natMonthlyUsd(region) : null;
  if (!rates || monthly === null) {
    return `Cloudgate's rate table has no price for ${region ?? 'this region'}; see AWS's VPC pricing`;
  }
  return `about ${formatUsd(monthly)}/month plus $${rates.perGbUsd} per GB it carries`;
}
