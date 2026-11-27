import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { BucketsService } from '../buckets/buckets.service';
import { LibsqlService } from '../databases/libsql/libsql.service';
import { MariadbService } from '../databases/mariadb/mariadb.service';
import { MongoService } from '../databases/mongo/mongo.service';
import { MysqlService } from '../databases/mysql/mysql.service';
import { PostgresService } from '../databases/postgres/postgres.service';
import { RedisService } from '../databases/redis/redis.service';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import {
  bucket,
  libsql,
  mariadb,
  mongo,
  mysql,
  postgres,
  redis,
} from '../db/schema';
import { DeploymentsService } from '../deployments/deployments.service';
import { maintenanceRefusal } from '../servers/server-maintenance';
import type {
  RedeployedKind,
  RestoreRedeployer,
} from './restore-redeployer.port';
import { deployRefusal } from './server-readiness';

/** A Service a Database's or a Bucket's own deploy runs for. */
type OwnDeployKind = Exclude<RedeployedKind, 'application' | 'compose'>;

/** The table of each kind whose deploy writes no Deployment row, and the columns read here. */
const TABLES: Record<
  OwnDeployKind,
  {
    table: PgTable;
    id: AnyPgColumn;
    serverId: AnyPgColumn;
    applicationStatus: AnyPgColumn;
  }
> = {
  postgres: {
    table: postgres,
    id: postgres.postgresId,
    serverId: postgres.serverId,
    applicationStatus: postgres.applicationStatus,
  },
  mysql: {
    table: mysql,
    id: mysql.mysqlId,
    serverId: mysql.serverId,
    applicationStatus: mysql.applicationStatus,
  },
  mariadb: {
    table: mariadb,
    id: mariadb.mariadbId,
    serverId: mariadb.serverId,
    applicationStatus: mariadb.applicationStatus,
  },
  mongo: {
    table: mongo,
    id: mongo.mongoId,
    serverId: mongo.serverId,
    applicationStatus: mongo.applicationStatus,
  },
  redis: {
    table: redis,
    id: redis.redisId,
    serverId: redis.serverId,
    applicationStatus: redis.applicationStatus,
  },
  libsql: {
    table: libsql,
    id: libsql.libsqlId,
    serverId: libsql.serverId,
    applicationStatus: libsql.applicationStatus,
  },
  bucket: {
    table: bucket,
    id: bucket.bucketId,
    serverId: bucket.serverId,
    applicationStatus: bucket.applicationStatus,
  },
};

/**
 * {@link RestoreRedeployer} over the deploy paths themselves (#181): an
 * Application's redeploy and a stack's Deploy queued through
 * `DeploymentsService`, a Database's deploy (`apply`, so one someone
 * stopped stays stopped with the current spec) and a Bucket's Garage
 * deploy run on in the background, each failing on its own Service as its
 * deploy does.
 *
 * A refusal before the deploy starts is thrown, so the caller can record
 * it ({@link recordRefused}) and name it apart. The Database and Bucket
 * deploys answer only once they have run, so their refusals (a Server not
 * Ready, or in maintenance) are asked here first, in the deploy's own
 * words; the deploy asks them again as it starts.
 */
@Injectable()
export class RestoreRedeployerAdapter implements RestoreRedeployer {
  private readonly logger = new Logger(RestoreRedeployerAdapter.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
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
    await this.refuseBeforeStart(kind, id);
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

  async recordRefused(
    service: { kind: RedeployedKind; id: string },
    meta: { title: string },
    reason: string,
  ): Promise<void> {
    const { kind, id } = service;
    if (kind === 'application' || kind === 'compose') {
      await this.deployments.recordRefusedAfterServerRestore(
        { kind, id },
        meta,
        reason,
      );
      return;
    }
    // As a failed deploy of its own leaves it: no Deployment row, its status.
    const own = TABLES[kind];
    await this.db
      .update(own.table)
      .set({ applicationStatus: 'error' })
      .where(eq(own.id, id));
  }

  /** What its deploy would refuse it for before starting, thrown as the deploy throws it. */
  private async refuseBeforeStart(kind: OwnDeployKind, id: string) {
    const own = TABLES[kind];
    const [row] = (await this.db
      .select({ serverId: own.serverId })
      .from(own.table)
      .where(eq(own.id, id))
      .limit(1)) as { serverId: string | null }[];
    if (!row) throw new ConflictException('it no longer exists');
    const refusal =
      (await deployRefusal(this.db, [row.serverId])) ??
      (await maintenanceRefusal(this.db, [row.serverId]));
    if (refusal) throw new ConflictException(refusal);
  }

  private engine(kind: Exclude<OwnDeployKind, 'bucket'>) {
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
