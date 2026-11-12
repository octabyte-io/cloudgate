import { X509Certificate } from 'node:crypto';

import { ADVANCED_MAX_BYTES } from '../../../src/cloud-accounts/aws/definitions/ssm-variables';
import { rdsCaBundle } from '../../../src/cloud-accounts/aws/rds-ca';
import { AWS_REGIONS } from '../../../src/cloud-accounts/aws/regions';

/**
 * The `ca` Output of a postgres on RDS: Amazon's roots for its
 * region, small enough to be one SSM SecureString.
 */
describe('rdsCaBundle', () => {
  const certificatesOf = (bundle: string) =>
    (
      bundle.match(
        /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
      ) ?? []
    ).map((pem) => new X509Certificate(String(pem)));

  it('is the region’s three Amazon RDS roots, self-signed CAs, and no Beta ones', () => {
    const roots = certificatesOf(rdsCaBundle('eu-west-1'));
    expect(
      roots.map((one) => one.subject.match(/CN=(.*)/)?.[1]).sort(),
    ).toEqual([
      'Amazon RDS eu-west-1 Root CA ECC384 G1',
      'Amazon RDS eu-west-1 Root CA RSA2048 G1',
      'Amazon RDS eu-west-1 Root CA RSA4096 G1',
    ]);
    for (const root of roots) {
      expect(root.ca).toBe(true);
      expect(root.issuer).toBe(root.subject);
    }
  });

  it.each(AWS_REGIONS)(
    'has roots for %s that fit one SSM parameter',
    (region) => {
      const bundle = rdsCaBundle(region);
      expect(certificatesOf(bundle).length).toBeGreaterThanOrEqual(1);
      expect(Buffer.byteLength(bundle, 'utf8')).toBeLessThanOrEqual(
        ADVANCED_MAX_BYTES,
      );
    },
  );

  it('is empty for a region Amazon publishes no roots for', () => {
    expect(rdsCaBundle('xx-nowhere-1')).toBe('');
  });
});
