import { BlockList, isIP } from 'node:net';

import { isPrivateAddress } from '../outbound/outbound-address';

/**
 * The documentation ranges (RFC 5737, RFC 3849): addresses no packet on the
 * internet is ever routed to, so no certificate authority can reach one.
 */
const DOCUMENTATION = new BlockList();
DOCUMENTATION.addSubnet('192.0.2.0', 24, 'ipv4');
DOCUMENTATION.addSubnet('198.51.100.0', 24, 'ipv4');
DOCUMENTATION.addSubnet('203.0.113.0', 24, 'ipv4');
DOCUMENTATION.addSubnet('2001:db8::', 32, 'ipv6');

/**
 * Whether an address literal is one the internet can reach, so Let's
 * Encrypt can answer an HTTP-01 challenge on a host that resolves to it.
 * A generated sslip.io host on such an address is served over HTTPS; one on
 * a private, loopback or documentation address stays plain HTTP, since no
 * certificate could be issued for it. Shape only, as `ipLiteral` is: it
 * cannot tell whether a firewall closes ports 80 and 443.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (DOCUMENTATION.check(address, family === 4 ? 'ipv4' : 'ipv6')) {
    return false;
  }
  return !isPrivateAddress(address);
}
