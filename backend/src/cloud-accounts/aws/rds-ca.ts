import { X509Certificate } from 'node:crypto';

import { RDS_GLOBAL_BUNDLE } from './rds-global-bundle';

/**
 * The CA bundle a client trusts to reach an RDS instance over TLS: Amazon's
 * public roots for the instance's region, the `ca` Output
 * of a postgres on RDS.
 *
 * One region's roots, not Amazon's whole global bundle: an Output reaches a
 * cloud task as one SSM SecureString, which holds at most 8 KB, and
 * the global bundle is some 170 KB. A region's three roots (RSA2048,
 * RSA4096 and ECC384, G1) are the same certificates Amazon publishes as
 * `<region>-bundle.pem`, picked out of the vendored global bundle by their
 * subject, `Amazon RDS <region> Root CA …` — never the `Beta` or `Preview`
 * endpoints' roots. Empty for a region the bundle has no roots for.
 */
export function rdsCaBundle(region: string): string {
  const cached = byRegion.get(region);
  if (cached !== undefined) return cached;
  const prefix = `CN=Amazon RDS ${region} Root CA `;
  const bundle = certificates()
    .filter((pem) =>
      new X509Certificate(pem).subject
        .split('\n')
        .some((part) => part.startsWith(prefix)),
    )
    .map((pem) => `${pem}\n`)
    .join('');
  byRegion.set(region, bundle);
  return bundle;
}

const byRegion = new Map<string, string>();

let parsed: string[] | null = null;

function certificates(): string[] {
  parsed ??=
    RDS_GLOBAL_BUNDLE.match(
      /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
    ) ?? [];
  return parsed;
}
