import type { PlanRefusal } from '../../../project-config';

/**
 * The private DNS a Private web service on AWS is reached through (the AWS
 * kinds spec, "Private web service on ECS"): a Cloud Map private DNS
 * namespace, one per Environment network, in the network's Infrastructure
 * state. It is made by the first plan that creates a `web-private` in the
 * network and kept, after the last one is gone, until the network goes, the
 * same rule as a Google network's private link. Each `web-private`
 * has its own discovery service in it, in its own state.
 *
 * Not an internal load balancer and not Service Connect: a Cron run's
 * standalone task cannot use Service Connect.
 */

/**
 * An AWS network's parts made only once a Service needs them: the private
 * DNS namespace (`private-dns`), and the NAT gateway a Stack VM's way
 * out goes through (`nat-gateway`, `nat-gateway.ts`).
 */
export type AwsPrivateLinkKind = 'private-dns' | 'nat-gateway';

/** Every AWS kind, in the order a definition writes them. */
export const AWS_PRIVATE_LINK_KINDS: readonly AwsPrivateLinkKind[] = [
  'private-dns',
  'nat-gateway',
];

/**
 * The namespace's name in every Environment network. Two namespaces with
 * this name live side by side in one AWS account and region, each on its
 * own VPC (measured in us-east-1), so no Environment id is needed.
 */
export const PRIVATE_DNS_NAMESPACE = 'cloudgate.internal';

/** A Private web service's host: its Config name in the namespace. */
export function privateHost(configName: string): string {
  return `${configName}.${PRIVATE_DNS_NAMESPACE}`;
}

/**
 * Whether Cloud Map takes `configName` as a Private web service's discovery
 * service, its DNS label in the namespace, as the refusal names it,
 * or `null` when it does. A Config name is already 1 to 63 lower-case
 * letters, digits or hyphens, a letter first, so the one rule a DNS label
 * adds is that it does not end in a hyphen. Checked at plan, so a plan never
 * makes half a Private web service: its task definition and roles made, and
 * Cloud Map refusing the discovery service ten minutes into Apply.
 */
export function privateHostRefusal(configName: string): PlanRefusal | null {
  if (!configName.endsWith('-')) return null;
  return {
    at: configName,
    message: `${configName} is a Private web service, reached on AWS as ${privateHost(configName)}, and a DNS name's label cannot end in a hyphen; rename it without the trailing hyphen`,
  };
}

/**
 * The internal address of a Private web service on AWS: a base URL
 * used whole, never split into a host and a port by its callers.
 */
export function privateAddress(configName: string, port: number): string {
  return `http://${privateHost(configName)}:${port}`;
}

/**
 * What the namespace costs: the private hosted zone Cloud
 * Map makes for it is Route 53's per-zone charge; its queries from inside
 * the VPC are free.
 */
export const PRIVATE_DNS_COST = 'about $0.50/month';

/**
 * How long a caller's resolver keeps a task's record: short, so a task gone
 * with a deploy stops being reached within seconds.
 */
export const PRIVATE_DNS_TTL_SECONDS = 10;
