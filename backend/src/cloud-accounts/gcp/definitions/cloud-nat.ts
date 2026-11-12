import { formatUsd } from '../../aws/final-snapshot';
import { HOURS_PER_MONTH } from '../../definitions/stack-vm';

/**
 * **The Environment network's Cloud NAT** (ADR-0070, as amended by the
 * owner's decision on #1359, which holds for Google Cloud too): a Stack VM
 * has no external IP, so its way out — Ubuntu's updates, Docker's packages
 * and image pulls — goes through Cloud NAT on a Cloud Router in the
 * network's region, for the network's one subnet. IAP's tunnel needs none
 * of it: it reaches the Stack VM from Google's own range.
 *
 * It is a part of the network made only once a Service needs it, as the
 * private `run.app` zone is (`cloud-nat` among `privateLinks`): the first
 * plan that creates a Stack VM in an Environment adds it, and an
 * Environment with no Stack VM keeps the network's idle cost. Removing it
 * once the last Stack VM is deleted is that Delete's (#1367).
 */

/** The network's kind of link that holds the router and its NAT (`network-links.ts`). */
export type GoogleNatLinkKind = 'cloud-nat';

/** Every such Google kind, in the order a definition writes them. */
export const GOOGLE_NAT_LINK_KINDS: readonly GoogleNatLinkKind[] = [
  'cloud-nat',
];

/**
 * What Cloud NAT charges, in US dollars, the same in every region: per hour
 * for each VM using the gateway (up to 32), per hour for the external
 * address Google gives the gateway, and per GB it carries. The router
 * itself is free. Coded, as the Stack VM's rates are: the plan has no live
 * price feed.
 */
const NAT_HOURLY_PER_VM_USD = 0.0014;
const NAT_ADDRESS_HOURLY_USD = 0.005;
const NAT_PER_GB_USD = 0.045;

/** Cloud NAT's monthly price with one Stack VM behind it. */
export const CLOUD_NAT_MONTHLY_USD =
  Math.round(
    (NAT_HOURLY_PER_VM_USD + NAT_ADDRESS_HOURLY_USD) * HOURS_PER_MONTH * 100,
  ) / 100;

/** How a plan line prices it: `about $4.67/month for one Stack VM, plus $0.045 per GB it carries`. */
export const CLOUD_NAT_COST = `about ${formatUsd(CLOUD_NAT_MONTHLY_USD)}/month for one Stack VM, plus $${NAT_PER_GB_USD} per GB it carries`;

/** The NAT as a sentence names it: a network run's title and log. */
export const CLOUD_NAT_PART = 'Cloud NAT';
