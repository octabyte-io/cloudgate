import { X509Certificate } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { DrizzleDB } from '../db/drizzle.module';
import { certificate } from '../db/schema';
import type { CertificateType } from './domain.schema';

/** A stored certificate as a Domain names it — never its material. */
export type CoveringCertificate = { certificateId: string; name: string };

/** The columns {@link coveringCertificate} reads off a `certificate` row. */
export type StoredCertificateCandidate = CoveringCertificate & {
  certificateData: string;
};

/**
 * Traefik matches an SNI against ASCII names, so an internationalized host is
 * compared by its punycode — the same conversion `traefik/config/domain.ts`
 * applies to the rule.
 */
const toAscii = (host: string): string => {
  try {
    return new URL(`http://${host.trim()}`).hostname;
  } catch {
    return host.trim().toLowerCase();
  }
};

/**
 * Whether the leaf certificate in `pem` names `host`. Material that does not
 * parse names nothing: Traefik cannot load it either.
 */
const leafNamesHost = (
  pem: string,
  host: string,
  wildcards: boolean,
): boolean => {
  try {
    // The first certificate of a chain is the leaf, which is what Traefik
    // matches; `X509Certificate` reads exactly that one.
    const leaf = new X509Certificate(pem);
    // `subject: 'always'` because Traefik indexes the subject CN beside the
    // DNS SANs, so a CN-only certificate is still served for its CN.
    return leaf.checkHost(host, { subject: 'always', wildcards }) !== undefined;
  } catch {
    return false;
  }
};

/**
 * The stored certificate Traefik serves for `host`, or null when none
 * of `candidates` covers it.
 *
 * Read out of the material rather than the certificate's name, because Traefik
 * picks a certificate for an SNI by the names *inside* it: a DNS SAN or the
 * subject CN, case-insensitively, with `*.` covering exactly one label. An
 * exact name wins over a wildcard, as it does in Traefik's store; between two
 * of the same kind the first candidate wins. Material that does not parse is
 * one Traefik cannot load either, so it covers nothing rather than throwing.
 */
export function coveringCertificate(
  host: string,
  candidates: StoredCertificateCandidate[],
): CoveringCertificate | null {
  const ascii = toAscii(host);
  const pick = (wildcards: boolean) =>
    candidates.find((row) =>
      leafNamesHost(row.certificateData, ascii, wildcards),
    );
  const found = pick(false) ?? pick(true);
  return found
    ? { certificateId: found.certificateId, name: found.name }
    : null;
}

/**
 * The organization's stored certificates on one machine — the ones that
 * Server's Traefik has in its certs dir. `serverId` null is the platform host,
 * whose certificates are the rows with no Server.
 *
 * Organization-scoped on purpose: the platform host's Traefik also holds other
 * organizations' certificates, but naming one of those on this
 * organization's screen would leak it, so a host another tenant's material
 * covers reads as uncovered here.
 */
export async function storedCertificatesOn(
  db: DrizzleDB,
  organizationId: string,
  serverId: string | null,
): Promise<StoredCertificateCandidate[]> {
  return db
    .select({
      certificateId: certificate.certificateId,
      name: certificate.name,
      certificateData: certificate.certificateData,
    })
    .from(certificate)
    .where(
      and(
        eq(certificate.organizationId, organizationId),
        serverId === null
          ? isNull(certificate.serverId)
          : eq(certificate.serverId, serverId),
      ),
    )
    .orderBy(certificate.createdAt);
}

/** What {@link withStoredCertificates} reads off a Domain row. */
type DomainTlsRow = {
  host: string;
  https: boolean;
  certificateType: CertificateType;
};

/**
 * Each row with the stored certificate Traefik actually serves for its host
 * or `null` — the one helper both Domain listings use (a service's, in
 * `DomainsService`, and an Environment's feed).
 *
 * Not only for `stored` rows: a certificate in Settings → Certificates that
 * covers a host wins over its resolver, because Traefik looks in its store
 * before it asks ACME. So a `letsencrypt` row a stored certificate covers is
 * served that certificate, and the console must not call it Let's Encrypt
 * without saying so. An HTTP row and a `none` row are left out: the file
 * provider gives neither a `tls` block, so nothing is served for them. The
 * name only — never the material — and only this organization's certificates
 * on the machine each row's service runs on ({@link storedCertificatesOn}),
 * read once per machine.
 */
export async function withStoredCertificates<T extends DomainTlsRow>(
  db: DrizzleDB,
  organizationId: string,
  rows: T[],
  serverIdOf: (row: T) => string | null,
): Promise<(T & { storedCertificate: CoveringCertificate | null })[]> {
  const served = (row: T) => row.https && row.certificateType !== 'none';
  const byServer = new Map<string | null, StoredCertificateCandidate[]>();
  for (const row of rows.filter(served)) {
    const serverId = serverIdOf(row);
    if (!byServer.has(serverId)) {
      byServer.set(
        serverId,
        await storedCertificatesOn(db, organizationId, serverId),
      );
    }
  }
  return rows.map((row) => ({
    ...row,
    storedCertificate: served(row)
      ? coveringCertificate(row.host, byServer.get(serverIdOf(row)) ?? [])
      : null,
  }));
}
