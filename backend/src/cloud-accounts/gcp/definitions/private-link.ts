import type { NetworkLinkKind } from '../../definitions/network-links';

/**
 * The private link a Google Environment network gives its databases (the Google Cloud databases
 * spec "The private link"): Private Service Connect, set up by
 * Google itself through a service connection policy per kind of database,
 * on one subnet of the network's address plan kept for it. It lives in the
 * network's Infrastructure state, made by the first plan that creates a
 * database of that kind and kept, free, until the network goes.
 */

/**
 * A kind of database the network is linked for, each its own service
 * connection policy: Cloud SQL's, and Memorystore's, which
 * comes with the firewall rule for Redis's ports.
 */
export type PrivateLinkKind = 'cloud-sql' | 'memorystore';

/** Every kind, in the order a definition writes them. */
export const PRIVATE_LINK_KINDS: readonly PrivateLinkKind[] = [
  'cloud-sql',
  'memorystore',
];

/** Each kind's service class, as Google names the producer it links to. */
export const SERVICE_CLASS: { readonly [kind in PrivateLinkKind]: string } = {
  'cloud-sql': 'google-cloud-sql',
  memorystore: 'gcp-memorystore',
};

/** Each kind as a plan line names it. */
export const PRIVATE_LINK_PRODUCT: {
  readonly [kind in PrivateLinkKind]: string;
} = {
  'cloud-sql': 'Cloud SQL',
  memorystore: 'Memorystore',
};

/**
 * The ports a client reaches a Memorystore for Valkey instance on (the Google Cloud
 * databases spec): 6379, then one port per node in 11000–13047, which the
 * instance's topology answer names. Memorystore's link opens them from the
 * network to the private link's subnet.
 */
export const REDIS_PORTS: readonly string[] = ['6379', '11000-13047'];

/** The one line the plan shows with the link's pieces. */
export const PRIVATE_LINK_LINE =
  "Private link: lets this Environment's databases get a private address; made once, kept until the Environment is deleted";

/**
 * What the link costs: the policy and the subnet are free; the
 * private DNS zone Google makes for the instances' names with the first one
 * is Cloud DNS's per-zone charge. Measured by the walk by hand.
 */
export const PRIVATE_LINK_COST =
  "$0/month; the private DNS zone Google makes for its databases' names with the first one is about $0.20/month";

/**
 * Both lists' Google kinds, each once, in definition order: a kind of
 * another cloud's network (`network-links.ts`) is not Google's to write.
 */
export function joinedLinks(
  ...lists: readonly (readonly NetworkLinkKind[])[]
): PrivateLinkKind[] {
  return PRIVATE_LINK_KINDS.filter((kind) =>
    lists.some((list) => list.includes(kind)),
  );
}
