import { asc, count, desc, eq, inArray } from 'drizzle-orm';

import { application } from '../applications/application.schema';
import { NETWORK_IDLE_COST } from '../cloud-accounts/aws/plan-reader/plan-lines';
import { cloudAccount } from '../cloud-accounts/cloud-account.schema';
import type { CloudKind } from '../cloud-accounts/cloud-account.schema';
import { byCloud } from '../cloud-accounts/cloud-provider';
import { NETWORK_IDLE_COST as GOOGLE_NETWORK_IDLE_COST } from '../cloud-accounts/gcp/plan-reader/plan-lines';
import { infrastructureState } from '../cloud-accounts/infrastructure-state/infrastructure-state.schema';
import type { DrizzleDB } from '../db/drizzle.module';
import { deployment } from '../deployments/deployment.schema';
import type { Deployment } from '../deployments/deployment.schema';
import type { DnsRecord } from '../domains/domain.schema';
import { environmentNetwork } from './environment-network.schema';
import type {
  EnvironmentNetworkStatus,
  NetworkLeftover,
} from './environment-network.schema';
import { subnetHoldOf } from './subnet-hold';

/** One Environment network as the Environment's page shows it. */
export interface EnvironmentNetworkView {
  environmentNetworkId: string;
  cloudAccountId: string;
  /** The Cloud account's name, as reading a Service in it shows it. */
  cloudAccountName: string;
  /** Its Cloud account's cloud, which says which of the addresses below it has. */
  cloud: CloudKind;
  region: string;
  status: EnvironmentNetworkStatus;
  /** An AWS load balancer's address, for the operator's DNS record; `null` until made, and on Google Cloud. */
  albDnsName: string | null;
  /**
   * A Google network's fixed IP, which a Domain's `A` record points at
   * — `null` until made, and on AWS.
   */
  ipAddress: string | null;
  vpcId: string | null;
  /** What a removal left, in AWS or in Google Cloud; empty otherwise. */
  leftovers: NetworkLeftover[];
  /**
   * While Google holds its subnet after a removal (the spec's "The
   * subnet hold"): the subnet and network named, and when Cloudgate tries
   * again by itself. `null` otherwise, and always on AWS.
   */
  subnetHold: string | null;
  /** When Cloudgate's own next try at removing it is due, an ISO timestamp; `null` when none is. */
  holdNextTryAt: string | null;
  /** The DNS records its Domains left at the DNS provider, named again when it is removed. */
  dnsRecordsLeft: DnsRecord[];
  /**
   * What it costs while it runs, whatever runs in it (spec
   * US32): its load balancer bills even with no Service left. The figure a
   * plan shows on its create, in its own cloud's words, so the two never
   * disagree.
   */
  idleCost: string;
  /** The Environment's Services running in it; `0` is an empty network, still billing. */
  serviceCount: number;
  /**
   * Its newest run, the whole Deployment row, so the console opens its
   * Deployment log as it opens any other Deployment's.
   */
  lastRun: Deployment | null;
  /**
   * False when Cloudgate cannot read its Infrastructure state: every
   * run on it fails until Rebuild from the cloud. True with no state yet.
   */
  stateReadable: boolean;
  createdAt: string;
}

/**
 * The Environment's networks, each with its idle cost, how many of
 * the Environment's Services run in it, and its newest run. Scoping is the
 * caller's: `EnvironmentsService` has resolved the Environment first.
 */
export async function listEnvironmentNetworks(
  db: DrizzleDB,
  environmentId: string,
): Promise<EnvironmentNetworkView[]> {
  const rows = await db
    .select({
      network: environmentNetwork,
      cloudAccountName: cloudAccount.name,
      cloud: cloudAccount.cloud,
      stateReadable: infrastructureState.readable,
    })
    .from(environmentNetwork)
    .innerJoin(
      cloudAccount,
      eq(cloudAccount.cloudAccountId, environmentNetwork.cloudAccountId),
    )
    .leftJoin(
      infrastructureState,
      eq(
        infrastructureState.environmentNetworkId,
        environmentNetwork.environmentNetworkId,
      ),
    )
    .where(eq(environmentNetwork.environmentId, environmentId))
    .orderBy(asc(environmentNetwork.region), asc(cloudAccount.name));
  if (rows.length === 0) return [];

  const services = await db
    .select({
      cloudAccountId: application.cloudAccountId,
      region: application.region,
      count: count(),
    })
    .from(application)
    .where(eq(application.environmentId, environmentId))
    .groupBy(application.cloudAccountId, application.region);
  const runs = await db
    .select()
    .from(deployment)
    .where(
      inArray(
        deployment.environmentNetworkId,
        rows.map((row) => row.network.environmentNetworkId),
      ),
    )
    .orderBy(desc(deployment.createdAt), desc(deployment.deploymentId));

  return rows.map(({ network, cloudAccountName, cloud, stateReadable }) => {
    const lastRun = runs.find(
      (run) => run.environmentNetworkId === network.environmentNetworkId,
    );
    return {
      environmentNetworkId: network.environmentNetworkId,
      cloudAccountId: network.cloudAccountId,
      cloudAccountName,
      cloud,
      region: network.region,
      status: network.status,
      albDnsName: network.albDnsName,
      ipAddress: network.ipAddress,
      vpcId: network.vpcId,
      leftovers: network.leftovers,
      subnetHold: subnetHoldOf(network),
      holdNextTryAt: network.holdNextTryAt,
      dnsRecordsLeft: network.dnsRecordsLeft,
      idleCost: byCloud(cloud, {
        aws: NETWORK_IDLE_COST,
        gcp: GOOGLE_NETWORK_IDLE_COST,
      }),
      serviceCount:
        services.find(
          (one) =>
            one.cloudAccountId === network.cloudAccountId &&
            one.region === network.region,
        )?.count ?? 0,
      lastRun: lastRun ?? null,
      stateReadable: stateReadable ?? true,
      createdAt: network.createdAt,
    };
  });
}
