import { Module } from '@nestjs/common';
import { fetchClientProvider } from '../git-providers/fetch.provider';
import { MailModule } from '../mail/mail.module';
import { InstanceUrlModule } from '../settings/instance-url.module';
import { AgentRateLimitNotifierAdapter } from './agent-rate-limit-notifier.adapter';
import { AiModelNotAnsweringNotifierAdapter } from './ai-model-not-answering-notifier.adapter';
import { PreviewTeardownStuckNotifierAdapter } from './preview-teardown-stuck-notifier.adapter';
import { NotificationChannelRegistry } from './channels/channel-registry';
import { DeploymentNotifierAdapter } from './deployment-notifier.adapter';
import { NotificationDispatcherService } from './dispatcher.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [MailModule, InstanceUrlModule],
  controllers: [NotificationsController],
  providers: [
    fetchClientProvider,
    NotificationsService,
    NotificationDispatcherService,
    DeploymentNotifierAdapter,
    AgentRateLimitNotifierAdapter,
    PreviewTeardownStuckNotifierAdapter,
    AiModelNotAnsweringNotifierAdapter,
    NotificationChannelRegistry,
  ],
  exports: [
    NotificationsService,
    NotificationDispatcherService,
    DeploymentNotifierAdapter,
    AgentRateLimitNotifierAdapter,
    PreviewTeardownStuckNotifierAdapter,
    AiModelNotAnsweringNotifierAdapter,
  ],
})
export class NotificationsModule {}
