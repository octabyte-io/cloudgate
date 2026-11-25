import { BlockList, isIP } from 'node:net';
import { Inject, Injectable } from '@nestjs/common';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import {
  ADDRESS_RESOLVER,
  bareHost,
  isOwnAddress,
} from '../outbound/outbound-address';
import type { AddressResolver } from '../outbound/outbound-address';
import { OwnAddresses } from '../outbound/own-addresses';

/**
 * Loopback alone: `127.0.0.0/8` and `::1`. An IPv4-mapped spelling
 * (`::ffff:127.0.0.1`) is caught by the IPv4 line, as `BlockList` maps it.
 *
 * Not `isPrivateAddress`'s list: a private range is the LAN, and a Server on
 * the LAN is usually another machine, which is exactly what the Same-machine
 * warning asks for. Warning there would teach people to ignore it.
 */
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

/**
 * Whether an address literal is Cloudgate's own machine: loopback, or one of
 * `own`, the box's own addresses (`OwnAddresses.list`).
 */
export function isSameMachineAddress(
  address: string,
  own: readonly string[],
): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return (
    LOOPBACK.check(address, family === 4 ? 'ipv4' : 'ipv6') ||
    isOwnAddress(address, own)
  );
}

/**
 * Whether a Server's address is Cloudgate's own machine, for the
 * Same-machine warning (spec #146). Asked when the address is saved
 * (`ServersService.create`/`update`) and stored on the row as `sameMachine`,
 * so a Server read stays a database read.
 *
 * Always false on the Hosted instance: `ServerAddressGuard` refuses such an
 * address there outright (ADR-0053), and the Hosted instance never shows the
 * warning. Self-hosted the address is still saved as it is; this only warns.
 *
 * A name counts when **any** address it resolves to is the box, since one is
 * enough for the Server to be it; one that does not resolve counts as another
 * machine, because a warning nothing can vouch for is noise. `localhost` is
 * answered without asking the resolver.
 */
@Injectable()
export class SameMachine {
  constructor(
    private readonly instanceMode: InstanceMode,
    @Inject(ADDRESS_RESOLVER) private readonly resolve: AddressResolver,
    private readonly own: OwnAddresses,
  ) {}

  async isSameMachine(host: string): Promise<boolean> {
    if (this.instanceMode.isHosted) return false;
    const bare = bareHost(host.trim()).toLowerCase().replace(/\.$/, '');
    if (bare === 'localhost') return true;

    let addresses: string[];
    if (isIP(bare) !== 0) {
      addresses = [bare];
    } else {
      try {
        addresses = await this.resolve(bare);
      } catch {
        return false;
      }
    }
    const own = await this.own.list();
    return addresses.some((address) => isSameMachineAddress(address, own));
  }
}
