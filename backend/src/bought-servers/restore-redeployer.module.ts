import { Module } from '@nestjs/common';
import { BucketsModule } from '../buckets/buckets.module';
import { LibsqlModule } from '../databases/libsql/libsql.module';
import { MariadbModule } from '../databases/mariadb/mariadb.module';
import { MongoModule } from '../databases/mongo/mongo.module';
import { MysqlModule } from '../databases/mysql/mysql.module';
import { PostgresModule } from '../databases/postgres/postgres.module';
import { RedisModule } from '../databases/redis/redis.module';
import { DeploymentsModule } from '../deployments/deployments.module';
import { RollbacksModule } from '../rollbacks/rollbacks.module';
import { RestoreRedeployerAdapter } from './restore-redeployer.adapter';
import { RESTORE_REDEPLOYER } from './restore-redeployer.port';

/**
 * Binds {@link RESTORE_REDEPLOYER} to `RestoreRedeployerAdapter`, beside
 * the modules of every deploy path, which `BoughtServersModule` cannot
 * import (#181).
 */
@Module({
  imports: [
    DeploymentsModule,
    RollbacksModule,
    BucketsModule,
    PostgresModule,
    MysqlModule,
    MariadbModule,
    MongoModule,
    RedisModule,
    LibsqlModule,
  ],
  providers: [
    RestoreRedeployerAdapter,
    { provide: RESTORE_REDEPLOYER, useExisting: RestoreRedeployerAdapter },
  ],
})
export class RestoreRedeployerModule {}
