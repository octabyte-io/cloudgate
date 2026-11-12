import type { OutboundAddressGuard } from '../../src/outbound/outbound-address-guard';

/**
 * An `OutboundAddressGuard` that lets every dial through as it is, for a suite
 * whose subject is what a service sends rather than where it may send it:
 * the transport it wraps is the suite's own mock, so nothing leaves the
 * process either way. Where a dial may go is `outbound-address-guard.spec.ts`'s.
 */
export const passThroughGuard = {
  fetchFor: (base: unknown) => base,
  addressToDial: (host: string) => Promise.resolve(host),
  // Hands every host back as an exempt dial would, so it acts for the instance.
  actsForInstance: () => Promise.resolve(true),
  runWithGuardedFetch: <T>(work: () => Promise<T>) => work(),
} as unknown as OutboundAddressGuard;
