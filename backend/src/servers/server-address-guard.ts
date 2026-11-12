import { isIP } from 'node:net';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ADDRESS_RESOLVER, isPrivateAddress } from '../ai/ai-destination';
import type { AddressResolver } from '../ai/ai-destination';
import { isOwnAddress } from '../outbound/outbound-address';
import { OwnAddresses } from '../outbound/own-addresses';
import { InstanceMode } from '../instance-mode/instance-mode.service';

/**
 * The refusal code a client branches on (ADR-0005) when the Hosted instance
 * is given a Server address that leads back onto its own box or its network
 * (ADR-0053).
 */
export const SERVER_ADDRESS_REFUSED_CODE = 'SERVER_ADDRESS_REFUSED';

/**
 * One sentence for every way an address is refused — loopback, link-local,
 * a private range, one of the box's own addresses, or a name that does not
 * resolve. Which of those it was is a fact about the host's own network
 * (split-horizon DNS answers differently from inside), and a customer is not
 * owed it: `PRIVATE_DESTINATION_REFUSAL` in `ai-destination.ts` is the
 * precedent.
 */
export const SERVER_ADDRESS_REFUSAL =
  "This Cloudgate connects only to a Server's public address. Use an address that isn't loopback, link-local, private or this Cloudgate's own.";

/** The 400 itself. */
export function serverAddressRefused(): BadRequestException {
  return new BadRequestException({
    message: SERVER_ADDRESS_REFUSAL,
    code: SERVER_ADDRESS_REFUSED_CODE,
  });
}

/** Whether a 400 is {@link serverAddressRefused}'s, so a caller can pass it on. */
export function isServerAddressRefusal(error: unknown): boolean {
  if (!(error instanceof BadRequestException)) return false;
  const body = error.getResponse();
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { code?: unknown }).code === SERVER_ADDRESS_REFUSED_CODE
  );
}

/**
 * Whether the Hosted instance refuses to dial `address` (an address literal):
 * loopback, link-local or a private range (the same list the AI destination
 * check uses), or one of `own`. An IPv4-mapped IPv6 spelling is caught by the
 * IPv4 entries, as `BlockList` maps it.
 */
export function isRefusedServerAddress(
  address: string,
  own: readonly string[],
): boolean {
  if (isIP(address) === 0) return true;
  // `isOwnAddress` reads a 6to4 or Teredo spelling of the box's own public
  // IPv4 as the box, as `isPrivateAddress` does for the private ranges.
  return isPrivateAddress(address) || isOwnAddress(address, own);
}

/**
 * On the Hosted instance a Server cannot be the box itself (ADR-0053).
 *
 * {@link addressToDial} is asked twice: when a Server's address is saved
 * (`ServersService.create`/`update`), and at every SSH connect
 * (`ServerConnectionProvider.getConnection`, which every SSH client — exec,
 * forwards, terminals, dockerode-over-SSH — gets its host from). The second is
 * what keeps a hostname that resolved publicly when it was saved from
 * reopening the host once its records change.
 *
 * A name is refused unless **every** address it resolves to is allowed, and
 * refused when it resolves to nothing or cannot be resolved. At connect, the
 * address that was checked is the one dialled, so there is no second lookup
 * for a rebind to slip between.
 *
 * Self-hosted, nothing is checked and the stored address is dialled as it is:
 * a Server on the LAN, or the box itself, is a normal thing to have there.
 */
@Injectable()
export class ServerAddressGuard {
  constructor(
    private readonly instanceMode: InstanceMode,
    @Inject(ADDRESS_RESOLVER) private readonly resolve: AddressResolver,
    /** The box's own addresses, the list `OutboundAddressGuard` refuses too. */
    private readonly own: OwnAddresses,
  ) {}

  /**
   * The address to dial for `host`: `host` itself when self-hosted, otherwise
   * the checked address it resolves to. Throws {@link serverAddressRefused}.
   */
  async addressToDial(host: string): Promise<string> {
    if (!this.instanceMode.isHosted) return host;

    let addresses: string[];
    if (isIP(host) !== 0) {
      addresses = [host];
    } else {
      try {
        addresses = await this.resolve(host);
      } catch {
        throw serverAddressRefused();
      }
    }

    const own = await this.own.list();
    if (
      addresses.length === 0 ||
      addresses.some((address) => isRefusedServerAddress(address, own))
    ) {
      throw serverAddressRefused();
    }
    return addresses[0];
  }
}
