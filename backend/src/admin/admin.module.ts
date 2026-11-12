import { Module } from '@nestjs/common';
import { MonitoringModule } from '../monitoring/monitoring.module';
import { SettingsModule } from '../settings/settings.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  // MonitoringModule: setup-monitoring registers the web server's collection
  // jobs from the config it stores.
  imports: [SettingsModule, MonitoringModule],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
