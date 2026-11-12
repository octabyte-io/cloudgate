import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';

import type { GcpNetworkDomain } from '../../cloud-accounts/gcp/definitions/network-definition';
import { stackVmBackendName } from '../../cloud-accounts/gcp/definitions/stack-vm-definition';
import type { DrizzleDB } from '../../db/drizzle.module';
import { application, compose, domain, environment } from '../../db/schema';
import type { Domain, EnvironmentNetwork } from '../../db/schema';

/**
 * Every Domain on a Google Environment network, as the
 * database holds them: each Domain of each Service of the Environment in
 * the network's Cloud account and region. Google keeps every host rule in
 * the network's one URL map, so each run of the network writes them all;
 * one left out is removed. A Service under a Delete, running or
 * incomplete, is left out: its Delete's network step removed its Domains,
 * or is about to, and no later run puts them back; so is a Compose stack
 * under a Delete (#1367), for the same reason. So is every
 * Domain of an Environment under a Delete, running or incomplete: its
 * Delete's first step is the network run that removes them all.
 *
 * A Compose stack's Domains on its Stack VM (#1371) are on the same URL
 * map, routed to the backend service its own state holds for the Domain's
 * port. Only a port whose backend its stack's Domain run has made is
 * written (`stackVm.routedPorts`): a URL map naming a backend service that
 * does not exist is refused by Google, and would fail every run of the
 * network, not only the stack's.
 */
export async function networkDomainRows(
  db: DrizzleDB,
  network: Pick<
    EnvironmentNetwork,
    'environmentId' | 'cloudAccountId' | 'region'
  >,
): Promise<NetworkDomainRow[]> {
  const rows = await db
    .select({
      domain,
      configKind: application.configKind,
      spa: application.isStaticSpa,
    })
    .from(domain)
    .innerJoin(application, eq(application.applicationId, domain.applicationId))
    .innerJoin(
      environment,
      eq(environment.environmentId, application.environmentId),
    )
    .where(
      and(
        eq(application.environmentId, network.environmentId),
        eq(application.cloudAccountId, network.cloudAccountId),
        eq(application.region, network.region),
        isNotNull(domain.cloudCertificateStatus),
        isNull(application.cloudDelete),
        isNull(environment.cloudDelete),
      ),
    )
    .orderBy(asc(domain.createdAt), asc(domain.domainId));
  const onServices = rows.map((row) => ({
    ...row.domain,
    site: row.configKind === 'static' ? { spa: row.spa ?? false } : null,
  }));
  const stackRows = await db
    .select({ domain, stackVm: compose.stackVm })
    .from(domain)
    .innerJoin(compose, eq(compose.composeId, domain.composeId))
    .innerJoin(
      environment,
      eq(environment.environmentId, compose.environmentId),
    )
    .where(
      and(
        eq(compose.environmentId, network.environmentId),
        eq(compose.cloudAccountId, network.cloudAccountId),
        eq(compose.region, network.region),
        isNotNull(domain.cloudCertificateStatus),
        // A stack under a Delete, running or incomplete: its Delete's
        // network step takes its Domains off before its backends go.
        isNull(compose.cloudDelete),
        isNull(environment.cloudDelete),
      ),
    );
  const onStacks = stackRows
    .filter((row) =>
      (row.stackVm?.routedPorts ?? []).includes(row.domain.port ?? -1),
    )
    .map((row) => ({
      ...row.domain,
      site: null,
      backend: stackVmBackendName(
        row.domain.composeId ?? '',
        row.domain.port ?? 0,
      ),
    }));
  return [...onServices, ...onStacks].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) ||
      a.domainId.localeCompare(b.domainId),
  );
}

/**
 * A Domain on the network, with what its Service routes it to: a `static`
 * site's backend bucket and its `spa`, or `null` for a Service on
 * Cloud Run's backend service. The `spa` is the one the database holds, so a
 * run of the network always writes the site's saved setting.
 */
export type NetworkDomainRow = Domain & {
  readonly site: { readonly spa: boolean } | null;
  /** A Stack VM's stack's Domain: the backend service of its port. */
  readonly backend?: string;
};

/** A Domain row as the network's definition takes it. */
export function networkDomainOf(row: NetworkDomainRow): GcpNetworkDomain {
  return {
    domainId: row.domainId,
    host: row.host,
    path: row.path ?? '/',
    attempt: row.certificateAttempt,
    serviceId: row.applicationId ?? row.composeId ?? '',
    ...(row.site ? { site: row.site } : {}),
    ...(row.backend ? { backend: row.backend } : {}),
  };
}

/** The network's Domains, as its definition takes them. */
export async function networkDomains(
  db: DrizzleDB,
  network: Pick<
    EnvironmentNetwork,
    'environmentId' | 'cloudAccountId' | 'region'
  >,
): Promise<GcpNetworkDomain[]> {
  return (await networkDomainRows(db, network)).map(networkDomainOf);
}
