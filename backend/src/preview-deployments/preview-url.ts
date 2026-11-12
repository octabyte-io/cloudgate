import { X509Certificate } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DrizzleDB } from '../db/drizzle.module';
import { certificate } from '../db/schema';
import type { ResolverCertificate } from './dns-resolver-certificates';

/** The columns {@link previewUrl} reads off a `certificate` row — never the key. */
export interface PreviewCertificate {
  organizationId: string;
  serverId: string | null;
  certificateData: string;
}

/** Everything {@link previewUrl} decides from. */
export interface PreviewUrlInput {
  /** The preview's host — `preview_deployment.domain`. */
  host: string;
  /** The Application's Organization. */
  organizationId: string;
  /** The Application's run Server; `null` is the platform host. */
  serverId: string | null;
  /** The Application's `previewWildcard`; `null` means a generated name
   * carrying the machine's address. */
  previewWildcard: string | null;
  /** Candidate rows — any Organization's or machine's; the rule filters them. */
  certificates: readonly PreviewCertificate[];
  /** The Application's `previewDnsChallenge` switch. */
  previewDnsChallenge: boolean;
  /**
   * What Traefik's DNS-01 resolver has issued, read out of `acme.json` on a
   * machine with a DNS-01 setup (`dnsResolverCertificatesOn`) — none for a
   * machine without one. Counted only while the switch is on, and matched to
   * the preview's machine as {@link certificates} are.
   */
  resolverCertificates: readonly ResolverCertificate[];
  now: Date;
}

/**
 * The printed link of a Preview deployment. `urlNote` is present exactly when
 * `url` is `http://` — there is no boolean beside the scheme.
 */
export interface PreviewUrl {
  url: string;
  urlNote?: string;
}

/**
 * Whether the leaf of `pem` is unexpired at `now` and carries a DNS SAN that is
 * `host` or `*.` + `host` minus its first label. The subject CN is not read: a
 * browser ignores it, and this answers "is the link trusted", not "what does
 * Traefik serve" (that is `domains/stored-certificate.ts`' `coveringCertificate`).
 * Material that does not parse covers nothing rather than throwing.
 */
const coversHost = (pem: string, host: string, now: Date): boolean => {
  let leaf: X509Certificate;
  try {
    // The first certificate of a chain is the leaf; this reads exactly that one.
    leaf = new X509Certificate(pem);
  } catch {
    return false;
  }
  if (leaf.validToDate.getTime() <= now.getTime()) return false;
  const wildcard = `*.${host.slice(host.indexOf('.') + 1)}`;
  return (leaf.subjectAltName ?? '')
    .split(', ')
    .filter((entry) => entry.startsWith('DNS:'))
    .map((entry) => entry.slice('DNS:'.length).toLowerCase())
    .some((name) => name === host || name === wildcard);
};

/**
 * The one rule every Preview deployment's link is printed by:
 * `https://<host>` only where an unexpired certificate covers the
 * host, and `http://<host>` otherwise. The console's read answer, the
 * pull-request comment and the MCP projection all ask this, so they cannot
 * disagree.
 *
 * **Derived on every read, never stored.** Only the host is on the row, so a
 * wildcard uploaded or issued afterwards flips every live preview's link from
 * then on.
 *
 * **Two sources of a certificate, one check.** A stored `certificate` row
 * counts when it belongs to the Application's Organization. A certificate the
 * machine's DNS-01 resolver issued counts when the Application's
 * `previewDnsChallenge` is on — the caller reads it only from a machine that
 * still has a DNS-01 setup. Naming the resolver is not enough: until issuance
 * succeeds there is nothing in `acme.json` and the link stays `http://`. Both
 * go through the same {@link coversHost}: the host by SAN (exactly, or by a
 * one-label wildcard), with a notAfter still ahead of `now` — not of the
 * preview's own expiry.
 *
 * **The machine is matched exactly, `null` to `null`,** for both sources. A
 * certificate with no Server is written only into the platform host's certs
 * dir (`TraefikWriterService.writeCertificate`), and each machine's
 * `acme.json` is its own Traefik's, while a preview on a Server is routed by
 * that Server's own Traefik (`routePreview` writes to the parent's
 * `serverId`). So a platform-host certificate covers a platform-host preview
 * and not a Server's: printing `https://` there would send the reviewer to
 * Traefik's default certificate. This is `storedCertificatesOn`'s rule too.
 *
 * A preview is never refused for want of a certificate — the answer is only
 * ever which scheme to print, and `urlNote` says why it is `http://`.
 */
export function previewUrl(input: PreviewUrlInput): PreviewUrl {
  const host = input.host.toLowerCase();
  const stored = input.certificates.some(
    (row) =>
      row.organizationId === input.organizationId &&
      row.serverId === input.serverId &&
      coversHost(row.certificateData, host, input.now),
  );
  const issued =
    input.previewDnsChallenge &&
    input.resolverCertificates.some(
      (issuedOn) =>
        issuedOn.serverId === input.serverId &&
        coversHost(issuedOn.certificateData, host, input.now),
    );
  if (stored || issued) return { url: `https://${input.host}` };
  const parent = host.slice(host.indexOf('.') + 1);
  return {
    url: `http://${input.host}`,
    urlNote:
      input.previewWildcard === null
        ? 'This Application sets no preview wildcard, so the host is a generated sslip.io name carrying the IP of the machine this preview runs on, which no stored certificate covers, and its link is http://.'
        : input.previewDnsChallenge
          ? `The DNS-01 certificate for ${input.previewWildcard} has not been issued on the machine this preview runs on, so its link is http://.`
          : `No unexpired certificate stored for the machine this preview runs on covers *.${parent}, so its link is http://.`,
  };
}

/**
 * The candidate rows {@link previewUrl} needs for an Application in
 * `organizationId`: every certificate of that Organization, on any machine,
 * with the three columns the rule reads and never the private key. The rule
 * does the machine match itself, so one read serves a whole list of previews.
 */
export function previewCertificatesOf(
  db: DrizzleDB,
  organizationId: string,
): Promise<PreviewCertificate[]> {
  return db
    .select({
      organizationId: certificate.organizationId,
      serverId: certificate.serverId,
      certificateData: certificate.certificateData,
    })
    .from(certificate)
    .where(eq(certificate.organizationId, organizationId));
}
