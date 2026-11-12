import { Module } from '@nestjs/common';
import { BackupsModule } from '../../backups/backups.module';
import { SchedulingModule } from '../scheduling.module';
import { SchedulesController } from './schedules.controller';
import { SchedulesService } from './schedules.service';

// Feature module copied from the Phase 07 projects template. BackupsModule
// provides the shared run recorder.
@Module({
  imports: [SchedulingModule, BackupsModule],
  controllers: [SchedulesController],
  providers: [SchedulesService],
  exports: [SchedulesService],
})
export class SchedulesModule {}
