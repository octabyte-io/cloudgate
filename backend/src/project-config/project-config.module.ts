import { CloudDatabaseDeletesModule } from '../databases/common/cloud-database-deletes.module';
import { Module } from '@nestjs/common';

import { ApplicationsModule } from '../applications/applications.module';
import { CloudAccountsModule } from '../cloud-accounts/cloud-accounts.module';
import { MysqlModule } from '../databases/mysql/mysql.module';
import { BucketsModule } from '../buckets/buckets.module';
import { ComposeModule } from '../compose/compose.module';
import { PostgresModule } from '../databases/postgres/postgres.module';
import { RedisModule } from '../databases/redis/redis.module';
import { DeploymentsModule } from '../deployments/deployments.module';
import { CLOUD_DOMAIN_RUNNER } from '../domains/cloud-domain-runner.port';
import { STATIC_ROLLBACK_RUNNER } from '../rollbacks/static-rollback-runner.port';
import { MountsModule } from '../mounts/mounts.module';
import { DomainsModule } from '../domains/domains.module';
import { CONFIG_PUSH_PLANNER } from '../git-providers/config-push-planner.port';
import { GitProvidersModule } from '../git-providers/git-providers.module';
import { InstanceUrlModule } from '../settings/instance-url.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { CloudDomainRuns } from './applier/cloud-domain-runs.service';
import { CloudPostgresRuns } from './applier/cloud-postgres-runs.service';
import { CloudBucketRuns } from './applier/cloud-bucket-runs.service';
import { CloudStackVmRuns } from './applier/cloud-stack-vm-runs.service';
import { CloudRedisRuns } from './applier/cloud-redis-runs.service';
import { CloudStaticRuns } from './applier/cloud-static-runs.service';
import { CloudStaticDeploys } from './applier/cloud-static-deploys.service';
import { AwsStaticDeploys } from './applier/aws-static-deploys.service';
import { AwsCloudBuilds } from './applier/aws-cloud-builds.service';
import { GoogleCloudBuilds } from './applier/google-cloud-builds.service';
import { GoogleStaticDeploys } from './applier/google-static-deploys.service';
import {
  STATIC_SPREAD_CLOCK,
  systemSpreadClock,
} from './applier/static-spread';
import { ObjectStorageModule } from '../object-storage/object-storage.module';
import { CloudServiceDeploys } from './applier/cloud-service-deploys.service';
import { GoogleDomainRuns } from './applier/google-domain-runs.service';
import { StackVmDomainRuns } from './applier/stack-vm-domain-runs.service';
import { GoogleServiceDeploys } from './applier/google-service-deploys.service';
import { EnvironmentNetworkRemovals } from './applier/environment-network-removals.service';
import { GoogleNetworkRemovalSteps } from './applier/google-network-removal';
import { EnvironmentNetworkRuns } from './applier/environment-network-runs.service';
import { ENVIRONMENT_CLOUD_DELETES } from '../environments/environment-cloud-deletes.port';
import { EnvironmentCloudDeletes } from './environment-cloud-deletes.service';
import { PlanApplier } from './applier/plan-applier';
import { ConfigGenerationService } from './generator/config-generation.service';
import { ConfigLocations } from './config-locations.service';
import { CloudPlanReads } from './cloud-plan-reads.service';
import { AwsPlanReads } from './aws-plan-reads.service';
import { GooglePlanReads } from './google-plan-reads.service';
import {
  NetworkCloudResourcesController,
  ServiceCloudResourcesController,
} from './cloud-resources/cloud-resources.controller';
import { CloudResources } from './cloud-resources/cloud-resources.service';
import { ConfigMoves } from './config-moves.service';
import { GitConnectionResolver } from './git-connections';
import { PlanStore } from './plan-store.service';

import {
  PlansController,
  ProjectConfigSchemaController,
  ProjectConfigsController,
} from './project-config.controller';
import { ProjectConfigService } from './project-config.service';
import { PushPlans } from './push-plans.service';
import { CloudRuntimeLogs } from './runtime-log/cloud-runtime-logs.service';
import { GoogleRuntimeLogs } from './runtime-log/google-runtime-logs.service';
import { RuntimeLogController } from './runtime-log/runtime-log.controller';
import { StoppedDeployPlans } from './stopped-deploy-plans.service';
import { CONFIG_READER_PROVIDERS } from './reader/config-readers';
import { ConsoleSavesModule } from './console-saves';
import { WiredVariablesController } from './wired-variables.controller';
import { WiredVariablesService } from './wired-variables.service';

/**
 * The Project config (ADR-0029): one deep module that owns the format,
 * planning and the config's location, and as the slice lands, generation,
 * applying and moves. Other modules call {@link ProjectConfigService} (or the
 * pure functions in `index.ts`) and never reach inside.
 */
@Module({
  // The Applier writes through each kind's own create and update paths and
  // queues ordinary Deployments; none of these imports this module
  // back.
  imports: [
    ApplicationsModule,
    PostgresModule,
    BucketsModule,
    MysqlModule,
    RedisModule,
    // A `compose` entry's stack (ADR-0069).
    ComposeModule,
    DomainsModule,
    // A Template part's config files are file mounts (#1373).
    MountsModule,
    DeploymentsModule,
    GitProvidersModule,
    // A cloud step's plan reads AWS through the cloud port.
    CloudAccountsModule,
    // The generated config's `$schema` comment names this instance's URL.
    InstanceUrlModule,
    // The ACM certificate poller of cloud Domains.
    SchedulingModule,
    // A link Save is a console Save of the config.
    ConsoleSavesModule,
    // A static site's deploy uploads its files to its own bucket.
    ObjectStorageModule,
    // A cloud database's destroy row names its final snapshot, and an
    // Environment's Delete deletes each cloud database.
    CloudDatabaseDeletesModule,
  ],
  controllers: [
    ProjectConfigSchemaController,
    ProjectConfigsController,
    PlansController,
    // A cloud Service's Runtime log, read with its deploy role.
    RuntimeLogController,
    // What Cloudgate made, and Rebuild from the cloud.
    ServiceCloudResourcesController,
    NetworkCloudResourcesController,
    // A Service's wired variables, and the console Save of a link.
    WiredVariablesController,
  ],
  providers: [
    ProjectConfigService,
    ConfigLocations,
    PlanStore,
    CloudPlanReads,
    AwsPlanReads,
    GooglePlanReads,
    ConfigMoves,
    PushPlans,
    // The push handlers' port: they cannot import this module, which
    // imports theirs, so they resolve the token when a push arrives.
    { provide: CONFIG_PUSH_PLANNER, useExisting: PushPlans },
    PlanApplier,
    // An Apply's Environment network, made first as its own Cloud run.
    EnvironmentNetworkRuns,
    // An Environment network's removal, a destroy-only Cloud run;
    // on Google Cloud its steps are GoogleNetworkRemovalSteps'.
    EnvironmentNetworkRemovals,
    GoogleNetworkRemovalSteps,
    // An Environment's Delete in a Cloud account: its cloud Services'
    // Deletes, then its networks'. The environments module cannot import this
    // one, which imports theirs, so it resolves the token when a Delete is
    // asked; the projects module imports this one.
    EnvironmentCloudDeletes,
    {
      provide: ENVIRONMENT_CLOUD_DELETES,
      useExisting: EnvironmentCloudDeletes,
    },
    // A cloud Service's deploy: the Cloud run after its build.
    CloudServiceDeploys,
    GoogleServiceDeploys,
    GoogleDomainRuns,
    StackVmDomainRuns,
    CloudPostgresRuns,
    CloudBucketRuns,
    CloudStackVmRuns,
    CloudRedisRuns,
    CloudStaticRuns,
    // A static site's Deployment, and each cloud's half of it: S3 +
    // CloudFront, Cloud Storage + Cloud CDN.
    CloudStaticDeploys,
    AwsStaticDeploys,
    AwsCloudBuilds,
    GoogleCloudBuilds,
    GoogleStaticDeploys,
    { provide: STATIC_SPREAD_CLOCK, useValue: systemSpreadClock },
    // Its rollback points' folders: rolled back to and removed.
    { provide: STATIC_ROLLBACK_RUNNER, useExisting: CloudStaticDeploys },
    CloudRuntimeLogs,
    GoogleRuntimeLogs,
    CloudResources,
    // A cloud Service's Domains: their short Cloud runs and the ACM poller.
    // The Domains module cannot import this one, which imports it,
    // so it resolves the token when a cloud Domain is written.
    CloudDomainRuns,
    { provide: CLOUD_DOMAIN_RUNNER, useExisting: CloudDomainRuns },
    // The plan a cloud deploy that met more than its image leaves open.
    StoppedDeployPlans,
    GitConnectionResolver,
    ConfigGenerationService,
    WiredVariablesService,
    // The config reader port and one implementation per provider.
    ...CONFIG_READER_PROVIDERS,
  ],
  exports: [
    ProjectConfigService,
    CONFIG_PUSH_PLANNER,
    ENVIRONMENT_CLOUD_DELETES,
  ],
})
export class ProjectConfigModule {}
