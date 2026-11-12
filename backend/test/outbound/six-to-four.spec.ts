import {
  isPrivateAddress,
  sixToFourAddress,
} from '../../src/outbound/outbound-address';

/**
 * 6to4 (RFC 3056, `2002::/16`) is delivered by a relay to the IPv4 address its
 * next 32 bits spell, so `2002:7f00:1::` is loopback and `2002:a9fe:a9fe::`
 * the cloud metadata endpoint. The address rule reads the IPv4 out and holds
 * it to the IPv4 ranges, rather than refusing the prefix whole: a public IPv4
 * behind it is as public as itself.
 */
describe('sixToFourAddress', () => {
  it.each([
    ['2002:7f00:1::', '127.0.0.1'],
    ['2002:a9fe:a9fe::1', '169.254.169.254'],
    ['2002:c0a8:010a:1:2:3:4:5', '192.168.1.10'],
    ['2002:808:808::', '8.8.8.8'],
    ['2002::', '0.0.0.0'],
  ])('reads %s as %s', (address, embedded) => {
    expect(sixToFourAddress(address)).toBe(embedded);
  });

  it.each(['2001:db8::1', '::1', '127.0.0.1', 'not-an-address'])(
    'reads nothing out of %s',
    (address) => {
      expect(sixToFourAddress(address)).toBeNull();
    },
  );
});

describe('isPrivateAddress, for a 6to4 address', () => {
  it.each([
    '2002:7f00:1::',
    '2002:a9fe:a9fe::1',
    '2002:a00:1::',
    '2002:c0a8:010a::',
    '2002::',
  ])('refuses %s, whose IPv4 is private', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it('allows one whose IPv4 is public', () => {
    expect(isPrivateAddress('2002:808:808::1')).toBe(false);
  });
});
