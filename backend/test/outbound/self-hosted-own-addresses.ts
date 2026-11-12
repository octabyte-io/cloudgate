import type { OwnAddresses } from '../../src/outbound/own-addresses';

/**
 * `OwnAddresses` as a Self-hosted instance answers the outbound guard: no
 * address of the box's own is refused there. For a suite that builds an
 * `OutboundAddressGuard` by hand and is about something else; the Hosted
 * refusal is `hosted-own-address.e2e-spec.ts`'s.
 */
export const selfHostedOwnAddresses = {
  listOnHosted: () => Promise.resolve([]),
} as unknown as OwnAddresses;
