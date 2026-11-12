import { Module } from '@nestjs/common';
import { AwsCloudAdapter } from './aws/aws-cloud.adapter';
import { AwsProvider } from './aws/aws-provider';
import { AWS_POLICY, instanceAwsPolicy } from './aws/aws-policy';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import { CloudAccountsController } from './cloud-accounts.controller';
import { CloudAccountsService } from './cloud-accounts.service';
import { AWS_CLOUD_PORT } from './cloud.port';
import { GOOGLE_ROLE, instanceGoogleRole } from './gcp/deploy-role';
import { GoogleCloudAdapter } from './gcp/google-cloud.adapter';
import { GoogleProvider } from './gcp/google-provider';
import { CloudProviders } from './cloud-providers';
import { GOOGLE_CLOUD_PORT } from './google-cloud.port';
import { InfrastructureStatesService } from './infrastructure-state/infrastructure-states.service';
import { InstanceUrlModule } from '../settings/instance-url.module';

/**
 * Cloud accounts, each cloud's provider and the cloud ports (the AWS spec, the
 * Google Cloud spec). `backend/src/cloud/`
 * is billing and unrelated. The ports are exported so the
 * modules that grow on them — plans, Cloud runs, Domains — inject the one
 * adapter of each cloud, which every e2e spec replaces with
 * `test/utils/fake-cloud-port.ts` and `test/utils/fake-google-cloud-port.ts`.
 */
@Module({
  // The install's own address, which a Google Cloud account's tokens are issued under (S16).
  imports: [InstanceUrlModule],
  controllers: [CloudAccountsController],
  providers: [
    CloudAccountsService,
    // Each cloud's Cloud account lifecycle, by `cloud` (ADR-0043).
    AwsProvider,
    GoogleProvider,
    CloudProviders,
    InfrastructureStatesService,
    { provide: AWS_CLOUD_PORT, useClass: AwsCloudAdapter },
    // The policy version this instance's mode needs.
    {
      provide: AWS_POLICY,
      useFactory: (mode: InstanceMode) => instanceAwsPolicy(mode),
      inject: [InstanceMode],
    },
    { provide: GOOGLE_CLOUD_PORT, useClass: GoogleCloudAdapter },
    // The role version this instance's mode needs.
    {
      provide: GOOGLE_ROLE,
      useFactory: (mode: InstanceMode) => instanceGoogleRole(mode),
      inject: [InstanceMode],
    },
  ],
  exports: [
    CloudAccountsService,
    InfrastructureStatesService,
    AWS_CLOUD_PORT,
    GOOGLE_CLOUD_PORT,
  ],
})
export class CloudAccountsModule {}
