import type { CertificateType } from './domain.schema';

/**
 * A Domain's certificate as stored: what was asked for when it serves HTTPS,
 * and none when it does not.
 *
 * The console took HTTPS off with Let's Encrypt, and the row then read
 * "HTTP / Let's Encrypt" on the Domains table and "Certificate: Let's
 * Encrypt" on the Overview, for a host that is served no certificate at all:
 * Traefik's TLS block is written only on the `websecure` router, which HTTPS
 * off never makes. So the stored answer is what Traefik does, not what the
 * form held.
 */
export function certificateOf(row: {
  https?: boolean | null;
  certificateType?: CertificateType | null;
  customCertResolver?: string | null;
}): {
  certificateType: CertificateType | undefined;
  customCertResolver: string | null | undefined;
} {
  if (row.https) {
    return {
      certificateType: row.certificateType ?? undefined,
      customCertResolver: row.customCertResolver,
    };
  }
  return { certificateType: 'none', customCertResolver: null };
}
