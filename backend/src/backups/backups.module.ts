import { Module } from '@nestjs/common';
import { DestinationsModule } from '../destinations/destinations.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { BackupsController } from './backups.controller';
import { BackupsService } from './backups.service';
import { BackupRunRecorderService } from './run-recorder.service';

// Feature module copied from the Phase 07 projects template.
@Module({
  imports: [DestinationsModule, NotificationsModule, SchedulingModule],
  controllers: [BackupsController],
  providers: [BackupsService, BackupRunRecorderService],
  exports: [BackupsService, BackupRunRecorderService],
})
export class BackupsModule {}
