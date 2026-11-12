import { Module } from '@nestjs/common';
import { InstanceUrlService } from './instance-url.service';

/**
 * InstanceUrlService in its own module so NotificationsModule can build
 * dashboard links without importing SettingsModule (which imports
 * NotificationsModule for the docker-cleanup dispatch).
 */
@Module({
  providers: [InstanceUrlService],
  exports: [InstanceUrlService],
})
export class InstanceUrlModule {}
