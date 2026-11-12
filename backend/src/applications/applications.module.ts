import { Module } from '@nestjs/common';
import { CloudAccountsModule } from '../cloud-accounts/cloud-accounts.module';
import { ObjectStorageModule } from '../object-storage/object-storage.module';
import { ConsoleSavesModule } from '../project-config/console-saves';
import { GitProvidersModule } from '../git-providers/git-providers.module';
import { RegistriesModule } from '../registries/registries.module';
import { ServiceHealthModule } from '../service-health/service-health.module';
import { InstanceUrlModule } from '../settings/instance-url.module';
import { SshKeysModule } from '../ssh-keys/ssh-keys.module';
import { TraefikModule } from '../traefik/traefik.module';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';
import { CloudServiceDeletes } from './cloud-delete';
import {
  GOOGLE_LEFTOVER_RECHECK,
  systemLeftoverRecheck,
} from './google-leftover-recheck';
import { GoogleServiceDeleteSteps } from './google-service-delete';
import { CloudServiceLifecycle } from './cloud-lifecycle';
import {
  CRON_SERVICE_CLOCK,
  systemCronServiceClock,
} from '../cron-services/cron-service.clock';

/** Feature module copied from the Phase 07 projects template. */
@Module({
  // Delete removes the Application's dynamic config file, which the traefik
  // module owns.
  //
  // The other three are the modules that own the credential rows a
  // `PATCH /applications/:id` may point the Application at, imported so that
  // `ApplicationsService.credentialRefResolvers` can resolve each id through
  // the owning service's own org-scoped `findOne` rather than through a copy
  // of the lookup (the loop itself is `common/credential-refs.ts`).
  // None of the three imports anything, so none of this can close a cycle back
  // onto this module.
  //
  // `ServiceHealthModule` for the Stop hook; it imports no Service
  // module, so it cannot close a cycle either.
  //
  // `ConsoleSavesModule` keeps a Cloudgate-kept Project config in step with
  // each console Save; it imports no Service module.
  //
  // `InstanceUrlModule` for an AI model's endpoint on the gateway; it
  // imports nothing.
  //
  // `CloudAccountsModule` for a cloud Service's Stop, Start and Reload
  // the cloud port and the deploy-role session. It imports no
  // Service module. A cloud Service's Delete uses it too.
  //
  // `ObjectStorageModule` for a `static` site on AWS's Delete, which empties
  // its own bucket first; it imports nothing.
  imports: [
    CloudAccountsModule,
    ObjectStorageModule,
    InstanceUrlModule,
    ConsoleSavesModule,
    TraefikModule,
    GitProvidersModule,
    RegistriesModule,
    SshKeysModule,
    ServiceHealthModule,
  ],
  controllers: [ApplicationsController],
  providers: [
    ApplicationsService,
    CloudServiceLifecycle,
    CloudServiceDeletes,
    GoogleServiceDeleteSteps,
    // The leftover search's second look; suites move it on at once.
    { provide: GOOGLE_LEFTOVER_RECHECK, useValue: systemLeftoverRecheck },
    // A Cron service's clock: provided here, where its read lists the
    // next fire times, and exported to `CronServicesModule`, whose timetable
    // fires on it — one clock, so the two agree.
    { provide: CRON_SERVICE_CLOCK, useValue: systemCronServiceClock },
  ],
  // CloudServiceDeletes: an Environment's Delete runs each cloud Service's.
  exports: [ApplicationsService, CloudServiceDeletes, CRON_SERVICE_CLOCK],
})
export class ApplicationsModule {}
