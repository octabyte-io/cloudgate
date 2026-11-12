import { Module } from '@nestjs/common';
import { CloudAccountsModule } from '../../cloud-accounts/cloud-accounts.module';
import { CloudDatabaseBackupsService } from '../common/cloud-database-backups.service';
import { ConsoleSavesModule } from '../../project-config/console-saves';
import { ServiceHealthModule } from '../../service-health/service-health.module';
import { CloudDatabaseDeletesModule } from '../common/cloud-database-deletes.module';
import { volumeReleaseClockProvider } from '../common/database-ops';
import { convergenceClockProvider } from '../common/database-convergence';
import { RedisController } from './redis.controller';
import { RedisService } from './redis.service';

/** Feature module copied from the Phase 07 projects template. */
@Module({
  // `ServiceHealthModule` for the Stop hook.
  // `ConsoleSavesModule` keeps a Cloudgate-kept Project config in step with
  // each console Save.
  // `CloudAccountsModule` for an ElastiCache redis's Backups tab;
  // `CloudDatabaseDeletesModule` for a Delete in a Cloud account.
  imports: [
    ServiceHealthModule,
    ConsoleSavesModule,
    CloudAccountsModule,
    CloudDatabaseDeletesModule,
  ],
  controllers: [RedisController],
  providers: [
    RedisService,
    CloudDatabaseBackupsService,
    volumeReleaseClockProvider,
    convergenceClockProvider,
  ],
  exports: [RedisService],
})
export class RedisModule {}
