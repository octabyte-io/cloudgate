import dns from 'node:dns';
import { BlockList, isIP } from 'node:net';
import type { Provider } from '@nestjs/common';

/**
 * The one address rule for everything the platform host dials on a
 * customer's say-so: which addresses only something on this network can
 * reach, and how a name is resolved to be checked against them.
 *
 * It started as the AI destination check's (`ai-destination.ts`, which still
 * re-exports it under the names its callers and suites import), and moved here
 * when notifications, uptime probes and the Gitea and GitLab connections were
 * found dialling customer-supplied hosts with no check at all: one
 * list, so a range added for one surface is refused on every one.
 * `OutboundAddressGuard` is what applies it at dial time;
 * `ServerAddressGuard` reads {@link isPrivateAddress} for a Server's address.
 */

/**
 * Injectable name resolution, so no test reaches real DNS (`DNS_RESOLVER` in
 * `cdn.service.ts` is the precedent, and `FETCH_CLIENT` before it).
 *
 * **`dns.lookup`, not `dns.resolve4`.** The reason is that this has to agree
 * with what the *connection* would do, and a socket resolves through
 * `getaddrinfo`: the hosts file, both families, and the legacy address forms
 * glibc accepts — `getaddrinfo` answers `2130706433` and `0177.0.0.1` with
 * `127.0.0.1`, which `net.isIP` calls "not an address" and a resolver that
 * only asks for A records would answer NXDOMAIN for. A check that consults a
 * different name database than the connection is not a check.
 * `cdn.service.ts` wants the other thing — the A records a domain publishes —
 * which is why its token is left alone rather than widened.
 */
export const ADDRESS_RESOLVER = Symbol('ADDRESS_RESOLVER');

/** Every address a host name resolves to, in the order the resolver returns. */
export type AddressResolver = (host: string) => Promise<string[]>;

/**
 * `verbatim` so the order is the resolver's own; nothing here depends on the
 * order, and `all` is what makes a refusal cover every record rather than
 * whichever one `getaddrinfo` sorted first.
 */
const resolveEveryAddress: AddressResolver = async (host) =>
  (await dns.promises.lookup(host, { all: true, verbatim: true })).map(
    (entry) => entry.address,
  );

export const addressResolverProvider: Provider = {
  provide: ADDRESS_RESOLVER,
  useValue: resolveEveryAddress,
};

/**
 * The ranges a member of the public internet cannot route to, so a request that
 * arrives at one arrived from inside.
 *
 * `net.BlockList` rather than a hand-rolled CIDR matcher: it is stdlib, it
 * takes both families, and it resolves the bypass a hand-rolled matcher gets
 * wrong — `check('::ffff:7f00:1', 'ipv6')` consults the IPv4 subnets, so an
 * IPv4-mapped loopback is caught by the `127.0.0.0/8` line rather than needing
 * its own.
 */
const PRIVATE = new BlockList();
// RFC 1122 "this host on this network". `0.0.0.0` reaches loopback on Linux.
PRIVATE.addSubnet('0.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('100.64.0.0', 10, 'ipv4'); // RFC 6598 carrier-grade NAT
PRIVATE.addSubnet('127.0.0.0', 8, 'ipv4');
// The cloud metadata endpoint, and the reason this list exists at all.
PRIVATE.addSubnet('169.254.0.0', 16, 'ipv4');
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE.addSubnet('192.0.0.0', 24, 'ipv4'); // RFC 6890 protocol assignments
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE.addSubnet('198.18.0.0', 15, 'ipv4'); // RFC 2544 benchmarking
PRIVATE.addSubnet('224.0.0.0', 4, 'ipv4'); // multicast
PRIVATE.addSubnet('240.0.0.0', 4, 'ipv4'); // reserved, incl. 255.255.255.255
// `::/96` rather than `::/128` and `::1/128`: it is the deprecated
// IPv4-compatible block, so `[::7f00:1]` — a spelling of loopback that
// `BlockList` does not map back to IPv4 the way `::ffff:` is mapped — is
// refused with the unspecified address and loopback itself.
PRIVATE.addSubnet('::', 96, 'ipv6');
// NAT64 embeds an IPv4 destination this cannot read, so the prefix goes whole.
PRIVATE.addSubnet('64:ff9b::', 96, 'ipv6');
PRIVATE.addSubnet('fc00::', 7, 'ipv6'); // unique local
PRIVATE.addSubnet('fe80::', 10, 'ipv6'); // link-local
PRIVATE.addSubnet('ff00::', 8, 'ipv6'); // multicast

/** 6to4, RFC 3056: `2002:` then the 32 bits of an IPv4 address. */
const SIX_TO_FOUR = new BlockList();
SIX_TO_FOUR.addSubnet('2002::', 16, 'ipv6');

/**
 * The IPv4 address a 6to4 address (`2002:AABB:CCDD::/48`) embeds, or `null`
 * for any other address. A 6to4 packet is delivered by a relay to that IPv4
 * address, so `2002:7f00:1::` is loopback and `2002:a9fe:a9fe::` the cloud
 * metadata endpoint, spelt in IPv6.
 */
export function sixToFourAddress(address: string): string | null {
  if (isIP(address) !== 6 || !SIX_TO_FOUR.check(address, 'ipv6')) return null;
  const hextets = expandIpv6(address);
  if (hextets === null) return null;
  return ipv4Of(hextets[1], hextets[2]);
}

/**
 * Teredo, RFC 4380: `2001:0000:` then the Teredo server's IPv4, 16 bits of
 * flags, the client's UDP port and the client's IPv4, each with every bit
 * flipped. Only this /32: the rest of `2001::/16` (`2001:db8::/32` and the
 * ordinary unicast space around it) is not Teredo.
 */
const TEREDO = new BlockList();
TEREDO.addSubnet('2001::', 32, 'ipv6');

/**
 * The two IPv4 addresses a Teredo address (`2001:0000::/32`) embeds, or
 * `null` for any other address. A packet to one is sent over UDP to its
 * client's address, the last 32 bits flipped back, through its Teredo
 * server's, bits 32-63; so `2001:0:…:80ff:fffe` is loopback, spelt in IPv6.
 */
export function teredoAddresses(
  address: string,
): { server: string; client: string } | null {
  if (isIP(address) !== 6 || !TEREDO.check(address, 'ipv6')) return null;
  const hextets = expandIpv6(address);
  if (hextets === null) return null;
  return {
    server: ipv4Of(hextets[2], hextets[3]),
    client: ipv4Of(~hextets[6] & 0xffff, ~hextets[7] & 0xffff),
  };
}

/**
 * Every IPv4 address an IPv6 address is delivered to through a relay or a
 * tunnel it names: 6to4's one, Teredo's server and client. Empty for any
 * other address. Each is as reachable as the IPv6 spelling, so a rule about
 * IPv4 addresses holds for each of these too.
 */
export function embeddedIpv4Addresses(address: string): string[] {
  const sixToFour = sixToFourAddress(address);
  if (sixToFour !== null) return [sixToFour];
  const teredo = teredoAddresses(address);
  return teredo === null ? [] : [teredo.server, teredo.client];
}

/** The dotted IPv4 address two hextets spell. */
function ipv4Of(high: number, low: number): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/** The eight hextets of an IPv6 literal, `::` and a dotted tail expanded. */
function expandIpv6(address: string): number[] | null {
  let text = address.split('%')[0];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const octets = dotted[1].split('.').map(Number);
    text =
      text.slice(0, dotted.index) +
      `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const part = (side: string | undefined) =>
    side ? side.split(':').map((hextet) => parseInt(hextet, 16)) : [];
  const front = part(head);
  const back = part(tail);
  const missing = 8 - front.length - back.length;
  if (tail === undefined ? front.length !== 8 : missing < 0) return null;
  const hextets = [...front, ...new Array<number>(missing).fill(0), ...back];
  return hextets.some((hextet) => Number.isNaN(hextet)) ? null : hextets;
}

/** Whether an address literal is one only something on this network can reach. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6')) return true;
  // 6to4 and Teredo reach the IPv4 addresses they embed, so either is
  // private when one of those is.
  return embeddedIpv4Addresses(address).some((embedded) =>
    PRIVATE.check(embedded, 'ipv4'),
  );
}

/**
 * Whether an address literal is one of `own`, the box's own addresses
 * (`OwnAddresses`), spelt directly or inside a 6to4 or Teredo address: the
 * box's public IPv4 reached through a relay is still the box. An IPv4-mapped
 * IPv6 spelling is caught by the IPv4 entry, as `BlockList` maps it.
 */
export function isOwnAddress(address: string, own: readonly string[]): boolean {
  const family = isIP(address);
  if (family === 0 || own.length === 0) return false;
  const ownList = new BlockList();
  for (const entry of own) {
    const entryFamily = isIP(entry);
    if (entryFamily !== 0) {
      ownList.addAddress(entry, entryFamily === 4 ? 'ipv4' : 'ipv6');
    }
  }
  if (ownList.check(address, family === 4 ? 'ipv4' : 'ipv6')) return true;
  return embeddedIpv4Addresses(address).some((embedded) =>
    ownList.check(embedded, 'ipv4'),
  );
}

/** A host as `URL.hostname` spells it, without an IPv6 literal's brackets. */
export function bareHost(host: string): string {
  return host.replace(/^\[/, '').replace(/\]$/, '');
}

/**
 * The public address `host` may be dialled at, or `null` when it may not.
 *
 * Fails closed both ways: a literal is decided on the spot; a name is allowed
 * only when **every** address it resolves to is public, and refused when it
 * resolves to nothing or cannot be resolved — an unresolvable name is a
 * destination this cannot vouch for, and the dial would have failed anyway.
 * The answer is the first checked address, so a caller that dials it has made
 * the one lookup there is: no second resolution for a rebind to slip between.
 *
 * `own` is refused as well: the box's own addresses, which
 * `OutboundAddressGuard` passes on the Hosted instance so a customer cannot
 * have the box dial itself at its public address (ADR-0053). Left empty,
 * nothing more is refused.
 */
export async function publicAddressOf(
  host: string,
  resolve: AddressResolver,
  own: readonly string[] = [],
): Promise<string | null> {
  const refused = (address: string) =>
    isPrivateAddress(address) || isOwnAddress(address, own);
  const bare = bareHost(host);
  if (isIP(bare) !== 0) return refused(bare) ? null : bare;

  let addresses: string[];
  try {
    addresses = await resolve(bare);
  } catch {
    return null;
  }
  if (addresses.length === 0 || addresses.some(refused)) return null;
  return addresses[0];
}
