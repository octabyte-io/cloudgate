import {
  isPrivateAddress,
  teredoAddresses,
} from '../../src/outbound/outbound-address';
import { isRefusedServerAddress } from '../../src/servers/server-address-guard';

/**
 * Teredo (RFC 4380, `2001:0000::/32`) carries two IPv4 addresses: its Teredo
 * server's in bits 32-63, and its client's in the last 32 bits with every bit
 * flipped. A packet to one is delivered over UDP to that client, through that
 * server, so `2001:0:…:80ff:fffe` is loopback spelt in IPv6. The address rule
 * reads both out and holds each to the IPv4 ranges, as it does 6to4's.
 *
 * Example vectors: RFC 4380 §4's `2001:0000:4136:e378:8000:63bf:3fff:fdd2`,
 * and the same server with a client of `127.0.0.1` (`7f00:0001`, flipped
 * `80ff:fffe`), `169.254.169.254` (`5601:5601`) or `8.8.8.8` (`f7f7:f7f7`).
 */
describe('teredoAddresses', () => {
  it.each([
    [
      '2001:0000:4136:e378:8000:63bf:3fff:fdd2',
      { server: '65.54.227.120', client: '192.0.2.45' },
    ],
    [
      '2001:0:4136:e378:8000:63bf:80ff:fffe',
      { server: '65.54.227.120', client: '127.0.0.1' },
    ],
    ['2001:0:a00:1::f7f7:f7f7', { server: '10.0.0.1', client: '8.8.8.8' }],
    // `::` running into the client's half reads it as zero, flipped all ones.
    ['2001::', { server: '0.0.0.0', client: '255.255.255.255' }],
  ])('reads %s', (address, embedded) => {
    expect(teredoAddresses(address)).toEqual(embedded);
  });

  it.each([
    // The rest of `2001::/16` is not Teredo: documentation, Google's resolver,
    // and the next /32 along.
    '2001:db8::1',
    '2001:4860:4860::8888',
    '2001:1::5601:5601',
    '2002:7f00:1::',
    '::1',
    '127.0.0.1',
    'not-an-address',
  ])('reads nothing out of %s', (address) => {
    expect(teredoAddresses(address)).toBeNull();
  });
});

describe('isPrivateAddress, for a Teredo address', () => {
  it.each([
    ['a loopback client', '2001:0:4136:e378:8000:63bf:80ff:fffe'],
    ['the cloud metadata endpoint as client', '2001:0:4136:e378::5601:5601'],
    ['a private Teredo server', '2001:0:a00:1::f7f7:f7f7'],
    ['the unspecified prefix', '2001::'],
  ])('refuses one with %s', (_what, address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it('allows one whose client and server are both public', () => {
    expect(isPrivateAddress('2001:0:4136:e378:8000:63bf:f7f7:f7f7')).toBe(
      false,
    );
  });

  it('leaves the rest of 2001::/16 as it was', () => {
    expect(isPrivateAddress('2001:4860:4860::8888')).toBe(false);
  });
});

/**
 * The box's own public IPv4 as either half of a Teredo address is the box, as
 * its 6to4 spelling is.
 */
describe('isRefusedServerAddress, for a Teredo address', () => {
  // `203.0.113.99` is `cb00:7163`, flipped `34ff:8e9c`.
  const own = ['203.0.113.99'];

  it.each([
    ["the box's own address as client", '2001:0:4136:e378:8000:63bf:34ff:8e9c'],
    ["the box's own address as server", '2001:0:cb00:7163::f7f7:f7f7'],
    ['a loopback client', '2001:0:4136:e378:8000:63bf:80ff:fffe'],
  ])('refuses %s', (_what, address) => {
    expect(isRefusedServerAddress(address, own)).toBe(true);
  });

  it('allows one whose client and server are public and not the box', () => {
    expect(
      isRefusedServerAddress('2001:0:4136:e378:8000:63bf:f7f7:f7f7', own),
    ).toBe(false);
  });
});
