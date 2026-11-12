import { Module } from '@nestjs/common';
import { ApplicationsModule } from '../applications/applications.module';
import { ApplicationsService } from '../applications/applications.service';
import { ComposeModule } from '../compose/compose.module';
import { ComposeService } from '../compose/compose.service';
import { DeploymentEngineModule } from '../deployment-engine/deployment-engine.module';
import { PreviewDeploymentsModule } from '../preview-deployments/preview-deployments.module';
import { PreviewDeploymentsService } from '../preview-deployments/preview-deployments.service';
import { buildsConcurrencyProvider } from './builds-concurrency.provider';
import {
  cloudRunSettingsProvider,
  cloudRunTimingProvider,
} from './cloud-runs-concurrency.provider';
import { CloudReadWorks } from './cloud-read-work';
import { CLOUD_RUN_EXECUTOR, CloudRunsService } from './cloud-runs.service';
import { BUILDS_CONCURRENCY } from './concurrency';
import {
  DEPLOYABLE_APPLICATIONS,
  DEPLOYABLE_COMPOSES,
  DeploymentProcessor,
  PREVIEW_DEPLOYMENTS,
} from './deployment-processor';
import { InMemoryQueue } from './in-memory-queue';
import { DEPLOYMENT_QUEUE } from './queue.port';
import type { QueuePort } from './queue.port';

@Module({
  imports: [
    ApplicationsModule,
    ComposeModule,
    DeploymentEngineModule,
    PreviewDeploymentsModule,
  ],
  providers: [
    DeploymentProcessor,
    { provide: DEPLOYABLE_APPLICATIONS, useExisting: ApplicationsService },
    { provide: DEPLOYABLE_COMPOSES, useExisting: ComposeService },
    { provide: PREVIEW_DEPLOYMENTS, useExisting: PreviewDeploymentsService },
    buildsConcurrencyProvider,
    // The Cloud run pool, beside builds and never behind the
    // deployment queue.
    cloudRunSettingsProvider,
    cloudRunTimingProvider,
    // Plan reads are the runs built so far; their work is registered
    // by the plan code under the state each read locks.
    CloudReadWorks,
    {
      provide: CLOUD_RUN_EXECUTOR,
      inject: [CloudReadWorks],
      useFactory: (works: CloudReadWorks) => works.executor,
    },
    CloudRunsService,
    {
      provide: DEPLOYMENT_QUEUE,
      inject: [DeploymentProcessor, BUILDS_CONCURRENCY],
      // Every instance, hosted or not, builds through this in-process queue
      // and over SSH.
      useFactory: (
        processor: DeploymentProcessor,
        resolveConcurrency: (partition: string) => Promise<number>,
      ): QueuePort => {
        const queue = new InMemoryQueue({ resolveConcurrency });
        queue.process((job) => processor.process(job.data));
        return queue;
      },
    },
  ],
  exports: [
    DEPLOYMENT_QUEUE,
    BUILDS_CONCURRENCY,
    CloudRunsService,
    CloudReadWorks,
  ],
})
export class QueueModule {}
