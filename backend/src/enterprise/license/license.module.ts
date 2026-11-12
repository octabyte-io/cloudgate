import { Global, Module } from '@nestjs/common';
import { fetchClientProvider } from '../../git-providers/fetch.provider';
import { NotificationsModule } from '../../notifications/notifications.module';
import { MailModule } from '../../mail/mail.module';
import { SchedulingModule } from '../../scheduling/scheduling.module';
import { InstanceUrlModule } from '../../settings/instance-url.module';
import { LICENSE_API } from './license-api';
import { LicenseApiClient } from './license-api.client';
import { LicenseExpiringService } from './license-expiring.service';
import { LicenseLapseService } from './license-lapse.service';
import { LicenseRecheckService } from './license-recheck.service';
import { LicenseController } from './license.controller';
import { LicenseService } from './license.service';

/**
 * Global so the rbac layer and every enterprise module can consult the license
 * without importing this one — RbacModule's PermissionService injects it to
 * resolve custom roles, and the deployment queue reads it to decide whether
 * parallel builds are unlocked.
 */
@Global()
@Module({
  // SchedulingModule is deliberately dependency-free, so the lapse check can
  // ride the one cron mechanism this codebase has without closing a cycle
  // through the module every enterprise feature already depends on.
  //
  // NotificationsModule for the lapse fan-out, the same direct injection
  // of NotificationDispatcherService that backups, volume backups, monitoring
  // and docker cleanup already use. It closes no cycle: NotificationsModule
  // imports only MailModule and InstanceUrlModule, and this module being
  // @Global is exactly what keeps anything that needs the license from having
  // to import it back.
  //
  // MailModule and InstanceUrlModule for the owner email the 14- and 3-day
  // warnings send; both are leaves, so neither closes a cycle.
  imports: [
    SchedulingModule,
    NotificationsModule,
    MailModule,
    InstanceUrlModule,
  ],
  controllers: [LicenseController],
  providers: [
    fetchClientProvider,
    LicenseService,
    LicenseLapseService,
    LicenseRecheckService,
    LicenseExpiringService,
    { provide: LICENSE_API, useClass: LicenseApiClient },
  ],
  exports: [
    LicenseService,
    LicenseLapseService,
    LicenseRecheckService,
    LicenseExpiringService,
  ],
})
export class LicenseModule {}
