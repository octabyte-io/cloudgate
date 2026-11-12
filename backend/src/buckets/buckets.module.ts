import { Module } from '@nestjs/common';
import { CloudAccountsModule } from '../cloud-accounts/cloud-accounts.module';
import { convergenceClockProvider } from '../databases/common/database-convergence';
import { volumeReleaseClockProvider } from '../databases/common/database-ops';
import { MysqlModule } from '../databases/mysql/mysql.module';
import { PostgresModule } from '../databases/postgres/postgres.module';
import { RedisModule } from '../databases/redis/redis.module';
import { DeploymentsModule } from '../deployments/deployments.module';
import { ObjectStorageModule } from '../object-storage/object-storage.module';
import { ConsoleSavesModule } from '../project-config/console-saves';
import { TraefikModule } from '../traefik/traefik.module';
import { BucketDeletes } from './bucket-deletes.service';
import { BucketKeyRotation } from './bucket-key-rotation.service';
import { BucketsController } from './buckets.controller';
import { BucketsService } from './buckets.service';
import { CloudBucketDeletes } from './cloud-bucket-deletes.service';
import { GARAGE_REACH, GarageRelayReach } from './garage-reach';
import { GoogleBucketKeys } from './google-bucket-keys.service';

/**
 * Buckets on a Server (ADR-0037), made by a plan and deleted by a plan
 * or the console, keeping their files unless asked.
 * `ConsoleSavesModule` keeps a Cloudgate-kept Project config in step with a
 * console Delete. Rotate key redeploys the Services linking
 * a bucket — Applications through their Deployments, databases through
 * their own deploy — hence the Deployment and database modules.
 * `TraefikModule` removes a Delete's Domain routes.
 * `CloudAccountsModule` for a bucket on AWS's Delete: the deploy
 * role's session and the bucket's Infrastructure state; it imports no
 * Service module.
 */
@Module({
  imports: [
    CloudAccountsModule,
    ObjectStorageModule,
    ConsoleSavesModule,
    DeploymentsModule,
    PostgresModule,
    MysqlModule,
    RedisModule,
    TraefikModule,
  ],
  controllers: [BucketsController],
  providers: [
    BucketsService,
    BucketDeletes,
    CloudBucketDeletes,
    BucketKeyRotation,
    GoogleBucketKeys,
    { provide: GARAGE_REACH, useClass: GarageRelayReach },
    volumeReleaseClockProvider,
    convergenceClockProvider,
  ],
  exports: [BucketsService, BucketDeletes, CloudBucketDeletes],
})
export class BucketsModule {}
