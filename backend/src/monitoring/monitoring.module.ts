import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { AccessLogService } from './access-log.service';
import { MonitoringController } from './monitoring.controller';
import { MonitoringService } from './monitoring.service';
import { ServerAccessLogService } from './server-access-log.service';
import { ThresholdService } from './threshold.service';

/**
 * Phase 41 — monitoring, in-process: server/container stat collection,
 * threshold alerts, and Traefik access-log analytics.
 */
@Module({
  imports: [NotificationsModule, RealtimeModule, SchedulingModule],
  controllers: [MonitoringController],
  providers: [
    MonitoringService,
    ThresholdService,
    AccessLogService,
    ServerAccessLogService,
  ],
  exports: [MonitoringService, ThresholdService, AccessLogService],
})
export class MonitoringModule {}
