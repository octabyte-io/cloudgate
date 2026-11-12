import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import { application } from '../applications/application.schema';
import type { DrizzleDB } from '../db/drizzle.module';
import { recordsLeftBehind } from '../domains/cloud-domain';
import { domain } from '../domains/domain.schema';
import type { DnsRecord } from '../domains/domain.schema';
import { environmentNetwork } from './environment-network.schema';

/**
 * The DNS records an Environment network's Domains left at the operator's
 * DNS provider (the spec's "Domains"). Cloudgate never writes DNS, so
 * whatever removes the load balancer those records point at names them:
 * each Domain's validation CNAME and the record pointing at the load
 * balancer, as a removed Domain's answer names them.
 *
 * A Domain's row goes with its Service's, long before the network goes, so
 * each cloud Service's row hands its Domains' records to its network as it
 * is dropped ({@link keepDomainRecordsOnNetwork}), and the network keeps
 * them until it is removed.
 */

/** Appends a cloud Service's Domains' records to its network, just before its row goes. */
export async function keepDomainRecordsOnNetwork(
  db: DrizzleDB,
  applicationId: string,
): Promise<void> {
  const [service] = await db
    .select({
      environmentId: application.environmentId,
      cloudAccountId: application.cloudAccountId,
      region: application.region,
    })
    .from(application)
    .where(eq(application.applicationId, applicationId));
  if (!service?.cloudAccountId || !service.region) return;
  const [network] = await db
    .select()
    .from(environmentNetwork)
    .where(
      and(
        eq(environmentNetwork.environmentId, service.environmentId),
        eq(environmentNetwork.cloudAccountId, service.cloudAccountId),
        eq(environmentNetwork.region, service.region),
      ),
    );
  if (!network) return;
  const records = await domainRecordsOf(
    db,
    [applicationId],
    pointTargetOf(network),
  );
  if (records.length === 0) return;
  await db
    .update(environmentNetwork)
    .set({
      dnsRecordsLeft: sql`${environmentNetwork.dnsRecordsLeft} || ${JSON.stringify(records)}::jsonb`,
    })
    .where(
      eq(environmentNetwork.environmentNetworkId, network.environmentNetworkId),
    );
}

/**
 * Every record an Environment's Delete leaves at the DNS provider: what its
 * networks kept, and the records of each Domain its cloud Services still
 * have, in no repeated order.
 */
export async function environmentDnsRecords(
  db: DrizzleDB,
  environmentId: string,
): Promise<DnsRecord[]> {
  const networks = await db
    .select()
    .from(environmentNetwork)
    .where(eq(environmentNetwork.environmentId, environmentId));
  const services = await db
    .select({
      applicationId: application.applicationId,
      cloudAccountId: application.cloudAccountId,
      region: application.region,
    })
    .from(application)
    .where(
      and(
        eq(application.environmentId, environmentId),
        isNotNull(application.cloudAccountId),
      ),
    );
  const records: DnsRecord[] = networks.flatMap((one) => one.dnsRecordsLeft);
  for (const network of networks) {
    const ids = services
      .filter(
        (one) =>
          one.cloudAccountId === network.cloudAccountId &&
          one.region === network.region,
      )
      .map((one) => one.applicationId);
    // A Google network's Domains point at its fixed IP with an A record,
    // never a CNAME to a load balancer's name (the live walk).
    records.push(...(await domainRecordsOf(db, ids, pointTargetOf(network))));
  }
  return distinct(records);
}

/** A record per line, as the log and the answer name them. */
export function dnsRecordLine(record: DnsRecord): string {
  return `${record.type} ${record.name} → ${record.value}`;
}

/**
 * What a network's Domains point at: a Google network's fixed IP with an `A`
 * record, an AWS one's load balancer by name.
 */
function pointTargetOf(network: {
  ipAddress: string | null;
  albDnsName: string | null;
}): { dnsName: string | null; kind: 'load-balancer' | 'fixed-ip' } {
  return network.ipAddress !== null
    ? { dnsName: network.ipAddress, kind: 'fixed-ip' }
    : { dnsName: network.albDnsName, kind: 'load-balancer' };
}

async function domainRecordsOf(
  db: DrizzleDB,
  applicationIds: readonly string[],
  target: { dnsName: string | null; kind: 'load-balancer' | 'fixed-ip' },
): Promise<DnsRecord[]> {
  if (applicationIds.length === 0) return [];
  const domains = await db
    .select({
      host: domain.host,
      validationRecord: domain.validationRecord,
      // A static site's Domain points at its own distribution.
      distribution: application.cloudDistributionDomain,
    })
    .from(domain)
    .innerJoin(application, eq(domain.applicationId, application.applicationId))
    .where(inArray(domain.applicationId, [...applicationIds]))
    .orderBy(domain.host);
  return domains.flatMap((row) =>
    row.distribution
      ? recordsLeftBehind(row, row.distribution, 'cloudfront')
      : recordsLeftBehind(row, target.dnsName, target.kind),
  );
}

/** Each record once, first seen first. */
export function distinct(records: readonly DnsRecord[]): DnsRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = `${record.type} ${record.name} ${record.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
