import { Module } from '@nestjs/common';
import { ApplicationsModule } from '../applications/applications.module';
import { ComposeModule } from '../compose/compose.module';
import { DeploymentsModule } from '../deployments/deployments.module';
import { DomainsModule } from '../domains/domains.module';
import { GitProvidersModule } from '../git-providers/git-providers.module';
import { DeploymentNotifierAdapter } from '../notifications/deployment-notifier.adapter';
import { NotificationsModule } from '../notifications/notifications.module';
import { PatchModule } from '../patch/patch.module';
import { RollbacksModule } from '../rollbacks/rollbacks.module';
import { DeploymentEngineService } from './deployment-engine.service';
import { DEPLOYMENT_NOTIFIER } from './ports/deployment-notifier';

@Module({
  imports: [
    ApplicationsModule,
    ComposeModule,
    DomainsModule,
    GitProvidersModule,
    DeploymentsModule,
    NotificationsModule,
    PatchModule,
    RollbacksModule,
  ],
  providers: [
    DeploymentEngineService,
    { provide: DEPLOYMENT_NOTIFIER, useExisting: DeploymentNotifierAdapter },
  ],
  exports: [DeploymentEngineService],
})
export class DeploymentEngineModule {}
