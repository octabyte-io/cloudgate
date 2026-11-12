import { Module } from '@nestjs/common';
import { ConsoleSavesModule } from '../project-config/console-saves';
import { DomainsModule } from '../domains/domains.module';
import { GitProvidersModule } from '../git-providers/git-providers.module';
import { ServiceHealthModule } from '../service-health/service-health.module';
import { SshKeysModule } from '../ssh-keys/ssh-keys.module';
import { StackVmDeletesModule } from './stack-vm-deletes.module';
import { ComposeController } from './compose.controller';
import { ComposeService } from './compose.service';
import { COMPOSE_SETTLE_CLOCK, systemSettleClock } from './compose.utils';

/**
 * Feature module copied from the Phase 07 projects template. DomainsModule
 * supplies the same findComposeDomains the deployment engine feeds into the
 * rewrite, so the converted-file read and the deploy see identical domains.
 *
 * `GitProvidersModule` and `SshKeysModule` own the credential rows a
 * `PATCH /compose/:id` may point the stack at, imported so that
 * `ComposeService.credentialRefResolvers` can resolve each id through the
 * owning service's own org-scoped `findOne` rather than through a copy of the
 * lookup (the loop itself is `common/credential-refs.ts`).
 * Neither imports anything, so neither can close a cycle back onto this
 * module.
 *
 * `COMPOSE_SETTLE_CLOCK` is the delete path's settle poll (H-99), bound to the
 * system clock. It is a provider only so that a suite can exhaust the whole
 * fifteen-second window in microseconds — see `SettleClock`; the product has
 * exactly one clock and no route chooses it.
 */
@Module({
  // `ServiceHealthModule` for the Stop hook. `ConsoleSavesModule`
  // keeps a Cloudgate-kept Project config in step with each console Save
  // it imports no Service module.
  imports: [
    ConsoleSavesModule,
    DomainsModule,
    GitProvidersModule,
    SshKeysModule,
    ServiceHealthModule,
    // A stack on a Stack VM's Delete, a destroy-only Cloud run (#1367).
    StackVmDeletesModule,
  ],
  controllers: [ComposeController],
  providers: [
    ComposeService,
    { provide: COMPOSE_SETTLE_CLOCK, useValue: systemSettleClock },
  ],
  exports: [ComposeService],
})
export class ComposeModule {}
