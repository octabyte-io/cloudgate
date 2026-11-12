import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SchedulingService } from './scheduling.service';

// The scheduling module (Phase 37). Deliberately dependency-free so every
// feature module whose rows carry a cron expression (backups, volume backups,
// user schedules) can import it without cycles. `SchedulingService` keeps its
// own timers; `ScheduleModule` stays for the SchedulerRegistry
// intervals other modules add (the Cron service timetable, health probes,
// monitoring).
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [SchedulingService],
  exports: [SchedulingService],
})
export class SchedulingModule {}
