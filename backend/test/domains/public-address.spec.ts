import { isPublicAddress } from '../../src/domains/public-address';

describe('isPublicAddress', () => {
  it('holds for an address the internet routes to', () => {
    expect(isPublicAddress('34.117.42.7')).toBe(true);
    expect(isPublicAddress('2606:4700::1111')).toBe(true);
  });

  it('refuses a private, loopback or carrier-grade NAT address, which Let’s Encrypt cannot reach', () => {
    for (const address of [
      '10.0.0.5',
      '172.16.4.2',
      '192.168.1.10',
      '127.0.0.1',
      '100.64.0.1',
      'fd00::1',
    ]) {
      expect(isPublicAddress(address)).toBe(false);
    }
  });

  it('refuses a documentation address, which no packet is routed to', () => {
    for (const address of ['192.0.2.1', '198.51.100.7', '203.0.113.10']) {
      expect(isPublicAddress(address)).toBe(false);
    }
    expect(isPublicAddress('2001:db8::1')).toBe(false);
  });

  it('refuses a hostname, which is not an address at all', () => {
    expect(isPublicAddress('cloudgate.example.com')).toBe(false);
  });
});
