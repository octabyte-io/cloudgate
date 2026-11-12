import { detectCDNProvider } from '../../src/cdn/cdn-providers';
import { CdnService } from '../../src/cdn/cdn.service';

describe('detectCDNProvider', () => {
  it('identifies Cloudflare IPs by CIDR range', () => {
    // 104.16.0.0/13, a range in the Cloudflare table.
    expect(detectCDNProvider('104.16.132.229')?.name).toBe('cloudflare');
    expect(detectCDNProvider('104.16.132.229')?.displayName).toBe('Cloudflare');
  });

  it('identifies Fastly IPs by CIDR range', () => {
    // 151.101.0.0/16, a range in the Fastly table.
    expect(detectCDNProvider('151.101.1.140')?.name).toBe('fastly');
  });

  it('identifies Bunny CDN edge IPs by exact match', () => {
    expect(detectCDNProvider('84.17.46.53')?.name).toBe('bunnycdn');
    // One octet off an edge server is not Bunny.
    expect(detectCDNProvider('84.17.46.55')).toBeNull();
  });

  it('identifies Arvancloud IPs by CIDR range', () => {
    // 185.143.232.0/22, a range in the Arvancloud table.
    expect(detectCDNProvider('185.143.233.10')?.name).toBe('arvancloud');
  });

  it('returns null for a non-CDN IP', () => {
    expect(detectCDNProvider('8.8.8.8')).toBeNull();
    expect(detectCDNProvider('192.168.1.1')).toBeNull();
  });
});

describe('CdnService.validateDomain', () => {
  const makeService = (
    resolve: (host: string) => Promise<string[]>,
  ): CdnService => new CdnService(resolve);

  it('flags a CDN-fronted domain as valid with the provider warning', async () => {
    const service = makeService(() => Promise.resolve(['104.16.132.229']));

    await expect(service.validateDomain('app.example.com')).resolves.toEqual({
      isValid: true,
      resolvedIp: '104.16.132.229',
      cdnProvider: 'Cloudflare',
      error:
        'Domain is behind Cloudflare - actual IP is masked by Cloudflare proxy',
    });
  });

  it('validates against the expected IP and names both addresses on a mismatch', async () => {
    const service = makeService(() => Promise.resolve(['203.0.113.7']));

    await expect(
      service.validateDomain('app.example.com', '203.0.113.7'),
    ).resolves.toEqual({
      isValid: true,
      resolvedIp: '203.0.113.7',
      error: undefined,
    });

    await expect(
      service.validateDomain('app.example.com', '198.51.100.1'),
    ).resolves.toEqual({
      isValid: false,
      resolvedIp: '203.0.113.7',
      error: 'Domain resolves to 203.0.113.7 but should point to 198.51.100.1',
    });
  });

  it('strips protocol and path before resolving and reports all IPs', async () => {
    const seen: string[] = [];
    const service = makeService((host) => {
      seen.push(host);
      return Promise.resolve(['203.0.113.7', '203.0.113.8']);
    });

    const result = await service.validateDomain(
      'https://app.example.com/some/path',
    );
    expect(seen).toEqual(['app.example.com']);
    expect(result).toEqual({
      isValid: true,
      resolvedIp: '203.0.113.7, 203.0.113.8',
    });
  });

  it('reports a resolution failure as invalid', async () => {
    const service = makeService(() =>
      Promise.reject(new Error('queryA ENOTFOUND app.example.com')),
    );

    await expect(service.validateDomain('app.example.com')).resolves.toEqual({
      isValid: false,
      error: 'queryA ENOTFOUND app.example.com',
    });
  });
});
