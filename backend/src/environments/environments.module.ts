import { BucketsModule } from '../buckets/buckets.module';
import { Module } from '@nestjs/common';
import { CloudAccountsModule } from '../cloud-accounts/cloud-accounts.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { EnvironmentHealthService } from '../service-health/environment-health.service';
import { ErrorRateService } from '../service-health/error-rate.service';
import { requestMetricsStateProvider } from '../service-health/request-metrics-state.port';
import { TraefikModule } from '../traefik/traefik.module';
import { EnvironmentsController } from './environments.controller';
import { EnvironmentsService } from './environments.service';
import { SubnetHoldRetries } from './subnet-hold-retries.service';

/** Feature module copied from the Phase 07 projects template. */
@Module({
  // As in ProjectsModule: Delete removes each Application's dynamic config
  // file, which the traefik module owns.
  // CloudAccountsModule checks a cloud Deploy target.
  // SchedulingModule arms the subnet-hold sweep (S13).
  imports: [
    TraefikModule,
    CloudAccountsModule,
    BucketsModule,
    SchedulingModule,
  ],
  controllers: [EnvironmentsController],
  // The Services table's Health column. Provided here rather than by
  // importing ServiceHealthModule: it needs only the database, and the import
  // would register that module's controllers and probe tick ahead of their turn.
  // ErrorRateService answers whether an Error-rate threshold has a rate to
  // judge; it too needs only the database and the request-metrics state.
  providers: [
    EnvironmentsService,
    EnvironmentHealthService,
    ErrorRateService,
    requestMetricsStateProvider,
    // Cloudgate's own tries at Google's subnet hold, swept once a minute (S13).
    SubnetHoldRetries,
  ],
  exports: [EnvironmentsService],
})
export class EnvironmentsModule {}
