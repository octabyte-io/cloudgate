import { Module } from '@nestjs/common';
import { BackupsModule } from '../backups/backups.module';
import { DestinationsModule } from '../destinations/destinations.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { VolumeBackupsController } from './volume-backups.controller';
import { VolumeBackupsService } from './volume-backups.service';

// Feature module copied from the Phase 07 projects template.
@Module({
  imports: [
    BackupsModule,
    DestinationsModule,
    NotificationsModule,
    SchedulingModule,
  ],
  controllers: [VolumeBackupsController],
  providers: [VolumeBackupsService],
  exports: [VolumeBackupsService],
})
export class VolumeBackupsModule {}
