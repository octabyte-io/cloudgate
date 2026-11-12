import { and, eq, isNotNull } from 'drizzle-orm';

import type { WebDomain } from '../../cloud-accounts/aws/definitions/web-definition';
import type { DrizzleDB } from '../../db/drizzle.module';
import { domain } from '../../db/schema';
import type { Domain } from '../../db/schema';

/**
 * A Service's Domains as its deploy writes them: each one's
 * certificate and rule, and on the listener only a certificate a Domain run
 * has already attached (live), so a deploy never changes a Domain.
 */
export async function deployedDomains(
  db: DrizzleDB,
  applicationId: string,
): Promise<WebDomain[]> {
  const rows = await db
    .select()
    .from(domain)
    .where(
      and(
        eq(domain.applicationId, applicationId),
        isNotNull(domain.cloudCertificateStatus),
      ),
    )
    .orderBy(domain.createdAt);
  return rows.map((row) =>
    webDomainOf(row, row.cloudCertificateStatus === 'live'),
  );
}

/** A Domain row as the definition takes it. */
export function webDomainOf(row: Domain, attach: boolean): WebDomain {
  return {
    domainId: row.domainId,
    host: row.host,
    path: row.path ?? '/',
    attempt: row.certificateAttempt,
    attach,
  };
}
