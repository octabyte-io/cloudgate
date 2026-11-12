import { Global, Module } from '@nestjs/common';
import { OutboundAddressGuard } from './outbound-address-guard';
import { addressResolverProvider } from './outbound-address';
import { OwnAddresses } from './own-addresses';

/**
 * Global so every module that dials a customer-supplied host — notifications,
 * service health, the Gitea and GitLab connections — injects the one guard
 * without importing this module, the way `PermissionService`, which the guard
 * reads, is injected. Names resolve through `ADDRESS_RESOLVER`, so the
 * override a suite already gives the AI and Server address checks keeps this
 * one off real DNS too. `OwnAddresses` is exported for `ServerAddressGuard`,
 * which refuses the same list of the box's addresses.
 */
@Global()
@Module({
  providers: [OutboundAddressGuard, OwnAddresses, addressResolverProvider],
  exports: [OutboundAddressGuard, OwnAddresses],
})
export class OutboundModule {}
