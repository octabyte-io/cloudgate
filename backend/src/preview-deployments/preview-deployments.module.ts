import { Module } from '@nestjs/common';
import { ApplicationsModule } from '../applications/applications.module';
import { DeploymentEngineModule } from '../deployment-engine/deployment-engine.module';
import { DeploymentsModule } from '../deployments/deployments.module';
import { GitProvidersModule } from '../git-providers/git-providers.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PreviewTeardownStuckNotifierAdapter } from '../notifications/preview-teardown-stuck-notifier.adapter';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { TraefikModule } from '../traefik/traefik.module';
import { PreviewDeploymentsController } from './preview-deployments.controller';
import { PreviewDeploymentsService } from './preview-deployments.service';
import { PreviewExpiryService } from './preview-expiry.service';
import { PREVIEW_TEARDOWN_STUCK_NOTIFIER } from './teardown-stuck-episodes';

/** Feature module copied from the Phase 07 projects template. */
@Module({
  imports: [
    ApplicationsModule,
    DeploymentEngineModule,
    // A preview build is recorded pending as a Deployment of its parent and
    // queued through it.
    DeploymentsModule,
    GitProvidersModule,
    // The stuck-teardown Notification the expiry sweep raises.
    NotificationsModule,
    // The cron registry the Requested-preview expiry sweep arms itself on,
    // as `DeploymentLogRetentionService` does in DeploymentsModule.
    SchedulingModule,
    // A preview's host is routed the way a Domain is.
    TraefikModule,
  ],
  controllers: [PreviewDeploymentsController],
  providers: [
    PreviewDeploymentsService,
    PreviewExpiryService,
    {
      provide: PREVIEW_TEARDOWN_STUCK_NOTIFIER,
      useExisting: PreviewTeardownStuckNotifierAdapter,
    },
  ],
  exports: [PreviewDeploymentsService],
})
export class PreviewDeploymentsModule {}
