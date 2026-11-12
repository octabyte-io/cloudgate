import { Module } from '@nestjs/common';
import { BackupsModule } from '../backups/backups.module';
import { DEPLOYMENT_RECORDER } from '../deployment-engine/ports/deployment-recorder';
import { SchedulesModule } from '../scheduling/schedules/schedules.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { VolumeBackupsModule } from '../volume-backups/volume-backups.module';
import { DeploymentsController } from './deployments.controller';
import { DeploymentsService } from './deployments.service';
import { HELD_BUILDS } from './held-builds.port';
import { DeploymentLogRetentionService } from './log-retention.service';

/** Feature module copied from the Phase 07 projects template. Schedules,
 * volume backups and database backups are imported for their read paths
 * only: their runs are deployment rows, and the list and log routes resolve
 * ownership through the owning module's own findOne.
 *
 * `SchedulingModule` is the fourth import and the only one that is not a read
 * path: it is the cron registry `DeploymentLogRetentionService` arms itself on.
 * Deliberately dependency-free, so importing it costs this module
 * nothing — its own docblock says that is what it is for — and the retention
 * job lives here rather than in `settings/` because the artifact it bounds is a
 * Deployment's log file and the path to it is `DeploymentsService`'s to derive.
 */
@Module({
  imports: [
    BackupsModule,
    SchedulesModule,
    SchedulingModule,
    VolumeBackupsModule,
  ],
  controllers: [DeploymentsController],
  providers: [
    DeploymentsService,
    DeploymentLogRetentionService,
    // The Phase 21 port the deployment engine records builds through.
    { provide: DEPLOYMENT_RECORDER, useExisting: DeploymentsService },
    // The console Saves seam releases held builds through it.
    { provide: HELD_BUILDS, useExisting: DeploymentsService },
  ],
  exports: [DeploymentsService, DEPLOYMENT_RECORDER],
})
export class DeploymentsModule {}
