import { Module } from '@nestjs/common';
import { ConsoleSavesModule } from '../../project-config/console-saves';
import { ServiceHealthModule } from '../../service-health/service-health.module';
import { volumeReleaseClockProvider } from '../common/database-ops';
import { convergenceClockProvider } from '../common/database-convergence';
import { MariadbController } from './mariadb.controller';
import { MariadbService } from './mariadb.service';

/** Feature module copied from the Phase 07 projects template. */
@Module({
  // `ServiceHealthModule` for the Stop hook.
  // `ConsoleSavesModule` keeps a Cloudgate-kept Project config in step with
  // each console Save.
  imports: [ServiceHealthModule, ConsoleSavesModule],
  controllers: [MariadbController],
  providers: [
    MariadbService,
    volumeReleaseClockProvider,
    convergenceClockProvider,
  ],
  exports: [MariadbService],
})
export class MariadbModule {}
