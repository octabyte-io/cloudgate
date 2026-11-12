import { Module } from '@nestjs/common';
import { CloudAccountsModule } from '../../cloud-accounts/cloud-accounts.module';
import { ConsoleSavesModule } from '../../project-config/console-saves';
import { ServiceHealthModule } from '../../service-health/service-health.module';
import { CloudDatabaseBackupsService } from '../common/cloud-database-backups.service';
import { CloudDatabaseDeletesModule } from '../common/cloud-database-deletes.module';
import { volumeReleaseClockProvider } from '../common/database-ops';
import { convergenceClockProvider } from '../common/database-convergence';
import { CloudDatabaseLifecycle } from '../common/cloud-database-lifecycle';
import { MysqlController } from './mysql.controller';
import { MysqlService } from './mysql.service';

/** Feature module copied from the Phase 07 projects template. */
@Module({
  // `ServiceHealthModule` for the Stop hook.
  // `ConsoleSavesModule` keeps a Cloudgate-kept Project config in step with
  // each console Save.
  // `CloudAccountsModule` and `CloudDatabaseDeletesModule` for a mysql on
  // RDS, as for a postgres there: its Existing database's lookup
  // workspace, its Backups tab, RDS Stop and Start, and its Delete.
  imports: [
    ServiceHealthModule,
    ConsoleSavesModule,
    CloudAccountsModule,
    CloudDatabaseDeletesModule,
  ],
  controllers: [MysqlController],
  providers: [
    MysqlService,
    CloudDatabaseBackupsService,
    CloudDatabaseLifecycle,
    volumeReleaseClockProvider,
    convergenceClockProvider,
  ],
  exports: [MysqlService],
})
export class MysqlModule {}
