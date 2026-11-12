import { X509Certificate } from 'node:crypto';

import { ELASTICACHE_CA_BUNDLE } from '../../../src/cloud-accounts/aws/elasticache-ca';

/**
 * The `ca` Output of a redis on ElastiCache: Amazon Trust
 * Services' four public roots, by subject and by the fingerprints Amazon
 * publishes for them.
 */
describe('ELASTICACHE_CA_BUNDLE', () => {
  const certificates = (
    ELASTICACHE_CA_BUNDLE.match(
      /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
    ) ?? []
  ).map((pem: string) => new X509Certificate(pem));

  it('is Amazon Root CA 1 to 4, each a CA', () => {
    expect(certificates.map((one) => one.subject.split('\n').pop())).toEqual([
      'CN=Amazon Root CA 1',
      'CN=Amazon Root CA 2',
      'CN=Amazon Root CA 3',
      'CN=Amazon Root CA 4',
    ]);
    expect(certificates.every((one) => one.ca)).toBe(true);
  });

  it('is the roots Amazon publishes, by fingerprint', () => {
    expect(certificates[0].fingerprint256).toBe(
      '8E:CD:E6:88:4F:3D:87:B1:12:5B:A3:1A:C3:FC:B1:3D:70:16:DE:7F:57:CC:90:4F:E1:CB:97:C6:AE:98:19:6E',
    );
  });

  it('fits one SSM SecureString, which holds at most 8 KB', () => {
    expect(Buffer.byteLength(ELASTICACHE_CA_BUNDLE)).toBeLessThan(8 * 1024);
  });
});
