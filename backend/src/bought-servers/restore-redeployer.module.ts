import { Injectable, Logger, Module } from '@nestjs/common';
import { BucketsModule } from '../buckets/buckets.module';
import { BucketsService } from '../buckets/buckets.service';
import { LibsqlModule } from '../databases/libsql/libsql.module';
import { LibsqlService } from '../databases/libsql/libsql.service';
import { MariadbModule } from '../databases/mariadb/mariadb.module';
import { MariadbService } from '../databases/mariadb/mariadb.service';
import { MongoModule } from '../databases/mongo/mongo.module';
import { MongoService } from '../databases/mongo/mongo.service';
import { MysqlModule } from '../databases/mysql/mysql.module';
import { MysqlService } from '../databases/mysql/mysql.service';
import { PostgresModule } from '../databases/postgres/postgres.module';
import { PostgresService } from '../databases/postgres/postgres.service';
import { RedisModule } from '../databases/redis/redis.module';
import { RedisService } from '../databases/redis/redis.service';
import { DeploymentsModule } from '../deployments/deployments.module';
import { DeploymentsService } from '../deployments/deployments.service';
import { RESTORE_REDEPLOYER } from './restore-redeployer.port';
import type {
  RedeployedKind,
  RestoreRedeployer,
} from './restore-redeployer.port';

/**
 * {@link RestoreRedeployer} over the deploy paths themselves: an
 * Application's redeploy and a stack's Deploy queued through
 * `DeploymentsService`, a Database's deploy (`apply`, so one someone
 * stopped stays stopped with the current spec) and a Bucket's Garage
 * deploy run on in the background, each failing on its own Service as its
 * deploy does.
 */
@Injectable()
export class RestoreRedeployerAdapter implements RestoreRedeployer {
  private readonly logger = new Logger(RestoreRedeployerAdapter.name);

  constructor(
    private readonly deployments: DeploymentsService,
    private readonly buckets: BucketsService,
    private readonly postgres: PostgresService,
    private readonly mysql: MysqlService,
    private readonly mariadb: MariadbService,
    private readonly mongo: MongoService,
    private readonly redis: RedisService,
    private readonly libsql: LibsqlService,
  ) {}

  async redeploy(
    service: { kind: RedeployedKind; id: string },
    meta: { title: string; description: string },
  ): Promise<void> {
    const { kind, id } = service;
    if (kind === 'application' || kind === 'compose') {
      await this.deployments.redeployAfterServerRestore({ kind, id }, meta);
      return;
    }
    const running =
      kind === 'bucket'
        ? this.buckets.deploy(id)
        : this.engine(kind).deployInternal(id, 'apply');
    running.catch((error: unknown) =>
      this.logger.warn(
        `The ${kind} ${id} was not redeployed after its Server was restored: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  private engine(
    kind: Exclude<RedeployedKind, 'application' | 'compose' | 'bucket'>,
  ) {
    switch (kind) {
      case 'postgres':
        return this.postgres;
      case 'mysql':
        return this.mysql;
      case 'mariadb':
        return this.mariadb;
      case 'mongo':
        return this.mongo;
      case 'redis':
        return this.redis;
      case 'libsql':
        return this.libsql;
    }
  }
}

/**
 * Binds {@link RESTORE_REDEPLOYER} beside the modules of every deploy path,
 * which `BoughtServersModule` cannot import (#181).
 */
@Module({
  imports: [
    DeploymentsModule,
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
