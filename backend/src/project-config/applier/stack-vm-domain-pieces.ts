import { and, asc, eq, isNotNull } from 'drizzle-orm';

import type {
  StackVmDomain,
  StackVmLoadBalancer,
} from '../../cloud-accounts/aws/definitions/stack-vm-definition';
import type { DrizzleDB } from '../../db/drizzle.module';
import { domain, environmentNetwork } from '../../db/schema';
import type { Domain } from '../../db/schema';
import { webDomainOf } from './deployed-domains';

/** The port a Domain row takes when none is stored (`domain.port`'s default). */
const DEFAULT_PORT = 3000;

/** Where a stack runs: its Environment, Cloud account and region. */
export interface StackVmPlace {
  readonly composeId: string;
  readonly environmentId: string;
  readonly cloudAccountId: string;
  readonly region: string;
}

/** The port a Domain reaches on the Stack VM. */
export function stackVmDomainPort(row: Pick<Domain, 'port'>): number {
  return row.port ?? DEFAULT_PORT;
}

/** The stack's cloud Domains, oldest first. */
export function stackVmCloudDomains(
  db: DrizzleDB,
  composeId: string,
): Promise<Domain[]> {
  return db
    .select()
    .from(domain)
    .where(
      and(
        eq(domain.composeId, composeId),
        isNotNull(domain.cloudCertificateStatus),
      ),
    )
    .orderBy(asc(domain.createdAt));
}

/** The AWS Environment network's load balancer, once made. */
export async function awsStackVmLoadBalancer(
  db: DrizzleDB,
  place: Omit<StackVmPlace, 'composeId'>,
): Promise<(StackVmLoadBalancer & { albDnsName: string }) | null> {
  const [found] = await db
    .select({
      httpsListenerArn: environmentNetwork.httpsListenerArn,
      albSecurityGroupId: environmentNetwork.albSecurityGroupId,
      albDnsName: environmentNetwork.albDnsName,
    })
    .from(environmentNetwork)
    .where(
      and(
        eq(environmentNetwork.environmentId, place.environmentId),
        eq(environmentNetwork.cloudAccountId, place.cloudAccountId),
        eq(environmentNetwork.region, place.region),
        eq(environmentNetwork.status, 'ready'),
      ),
    );
  if (
    !found?.httpsListenerArn ||
    !found.albSecurityGroupId ||
    !found.albDnsName
  ) {
    return null;
  }
  return {
    httpsListenerArn: found.httpsListenerArn,
    albSecurityGroupId: found.albSecurityGroupId,
    albDnsName: found.albDnsName,
  };
}

/** A stack's Domain rows as its AWS Stack VM definition writes them. */
export function awsStackVmDomains(rows: readonly Domain[]): StackVmDomain[] {
  return rows.map((one) => ({
    ...webDomainOf(one, one.certificateIssuedAt !== null),
    port: stackVmDomainPort(one),
  }));
}

/**
 * **What a Stack VM's whole definition carries of its Domains** (#1371),
 * for every run that writes all of it again: a resize, a grow, a "replace
 * VM" (#1368), and their plan reads. Its Domain runs write the same pieces
 * on their own; a definition written without them reads as destroying
 * them, and its apply takes the stack's Domains off the load balancer.
 *
 * On AWS every piece is in the stack's own state: its Domains and the
 * network's load balancer; none for a stack with no Domain, or while the
 * network has no load balancer, which no Domain can have been added
 * without.
 */
export async function awsStackVmDomainPieces(
  db: DrizzleDB,
  place: StackVmPlace,
): Promise<{
  readonly domains: StackVmDomain[];
  readonly loadBalancer: StackVmLoadBalancer | null;
}> {
  const rows = await stackVmCloudDomains(db, place.composeId);
  const loadBalancer =
    rows.length > 0 ? await awsStackVmLoadBalancer(db, place) : null;
  if (!loadBalancer) return { domains: [], loadBalancer: null };
  return {
    domains: awsStackVmDomains(rows),
    loadBalancer: {
      httpsListenerArn: loadBalancer.httpsListenerArn,
      albSecurityGroupId: loadBalancer.albSecurityGroupId,
    },
  };
}

/**
 * On Google Cloud the stack's state holds its backends, one per port its
 * last Domain run routed (`routedPorts`); the host rules are the network's
 * URL map, which only a Domain run writes.
 */
export function googleStackVmPorts(stackVm: {
  readonly routedPorts?: readonly number[] | null;
}): number[] {
  return [...(stackVm.routedPorts ?? [])];
}
