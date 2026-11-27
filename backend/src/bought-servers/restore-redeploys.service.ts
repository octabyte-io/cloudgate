import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { and, eq, exists, gt, isNull, sql } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { application } from '../applications/application.schema';
import { bucket } from '../buckets/bucket.schema';
import { compose } from '../compose/compose.schema';
import { libsql } from '../databases/libsql/libsql.schema';
import { mariadb } from '../databases/mariadb/mariadb.schema';
import { mongo } from '../databases/mongo/mongo.schema';
import { mysql } from '../databases/mysql/mysql.schema';
import { postgres } from '../databases/postgres/postgres.schema';
import { redis } from '../databases/redis/redis.schema';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { deployment } from '../deployments/deployment.schema';
import { backupDateOf } from './restore';
import { RESTORE_REDEPLOYER } from './restore-redeployer.port';
import type {
  RedeployedKind,
  RestoreRedeployer,
} from './restore-redeployer.port';

/** A Database engine's table, as the read of what to redeploy needs it. */
interface Engine {
  kind: Exclude<RedeployedKind, 'application' | 'compose' | 'bucket'>;
  table: PgTable;
  id: AnyPgColumn;
  name: AnyPgColumn;
  serverId: AnyPgColumn;
  deployedAt: AnyPgColumn;
}

const ENGINES: readonly Engine[] = [
  {
    kind: 'postgres',
    table: postgres,
    id: postgres.postgresId,
    name: postgres.name,
    serverId: postgres.serverId,
    deployedAt: postgres.deployedAt,
  },
  {
    kind: 'mysql',
    table: mysql,
    id: mysql.mysqlId,
    name: mysql.name,
    serverId: mysql.serverId,
    deployedAt: mysql.deployedAt,
  },
  {
    kind: 'mariadb',
    table: mariadb,
    id: mariadb.mariadbId,
    name: mariadb.name,
    serverId: mariadb.serverId,
    deployedAt: mariadb.deployedAt,
  },
  {
    kind: 'mongo',
    table: mongo,
    id: mongo.mongoId,
    name: mongo.name,
    serverId: mongo.serverId,
    deployedAt: mongo.deployedAt,
  },
  {
    kind: 'redis',
    table: redis,
    id: redis.redisId,
    name: redis.name,
    serverId: redis.serverId,
    deployedAt: redis.deployedAt,
  },
  {
    kind: 'libsql',
    table: libsql,
    id: libsql.libsqlId,
    name: libsql.name,
    serverId: libsql.serverId,
    deployedAt: libsql.deployedAt,
  },
];

/** One Service a Restore redeploys. */
export interface RestoreRedeploy {
  kind: RedeployedKind;
  id: string;
  name: string;
}

/**
 * **The redeploys after a Restore** (#181, ADR-0093): the disk is back as it
 * was at a Server backup, so every Service on it whose current Deployment
 * is newer than the backup runs older code than its record says. Each is
 * redeployed through the same call a person's deploy takes, which keeps the
 * data the backup's and puts the code back to the current version.
 *
 * "Its current Deployment" is each deploy path's own: an Application's or a
 * Compose stack's newest Deployment that ended `done` (not a preview's, not
 * a Cron service's run); a Database's or a Bucket's `deployed_at`, since
 * neither writes a Deployment row.
 *
 * The deploys themselves go through {@link RESTORE_REDEPLOYER}, resolved at
 * call time: the deploy paths are in modules that import the Bought Servers
 * readiness rule.
 */
@Injectable()
export class RestoreRedeploys {
  private readonly logger = new Logger(RestoreRedeploys.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Every Service on the Server whose current Deployment finished after `takenAt`. */
  async newerThan(
    serverId: string,
    takenAt: string,
  ): Promise<RestoreRedeploy[]> {
    const after = (column: AnyPgColumn) =>
      gt(sql`${column}::timestamptz`, sql`${takenAt}::timestamptz`);
    // Some Deployment after it that ended `done` is the same as the newest
    // `done` one being after it.
    const builtAfter = (parent: AnyPgColumn, id: AnyPgColumn) =>
      exists(
        this.db
          .select({ one: sql`1` })
          .from(deployment)
          .where(
            and(
              eq(parent, id),
              eq(deployment.status, 'done'),
              isNull(deployment.previewDeploymentId),
              isNull(deployment.cronRun),
              after(deployment.finishedAt),
            ),
          ),
      );

    const applications = await this.db
      .select({ id: application.applicationId, name: application.name })
      .from(application)
      .where(
        and(
          eq(application.serverId, serverId),
          builtAfter(deployment.applicationId, application.applicationId),
        ),
      );
    const stacks = await this.db
      .select({ id: compose.composeId, name: compose.name })
      .from(compose)
      .where(
        and(
          eq(compose.serverId, serverId),
          builtAfter(deployment.composeId, compose.composeId),
        ),
      );
    const databases: RestoreRedeploy[] = [];
    for (const engine of ENGINES) {
      const rows = (await this.db
        .select({ id: engine.id, name: engine.name })
        .from(engine.table)
        .where(
          and(eq(engine.serverId, serverId), after(engine.deployedAt)),
        )) as { id: string; name: string }[];
      databases.push(...rows.map((row) => ({ kind: engine.kind, ...row })));
    }
    const buckets = await this.db
      .select({ id: bucket.bucketId, name: bucket.name })
      .from(bucket)
      .where(
        and(
          eq(bucket.serverId, serverId),
          isNull(bucket.cloudAccountId),
          after(bucket.deployedAt),
        ),
      );
    return [
      ...applications.map((row) => ({ kind: 'application' as const, ...row })),
      ...stacks.map((row) => ({ kind: 'compose' as const, ...row })),
      ...databases,
      ...buckets.map((row) => ({ kind: 'bucket' as const, ...row })),
    ];
  }

  /**
   * Starts each redeploy, never throwing: each fails as its deploy does, on
   * its own Service, and a refusal to start one is logged. Neither fails
   * the Restore.
   */
  async start(
    serverName: string,
    backupTakenAt: string,
    redeploys: readonly RestoreRedeploy[],
  ): Promise<void> {
    if (redeploys.length === 0) return;
    const meta = {
      title: `Redeploy after restoring ${serverName}`,
      description: `Queued by restoring ${serverName} from its backup of ${backupDateOf(backupTakenAt)}, since it was deployed after that backup`,
    };
    const redeployer = this.moduleRef.get<RestoreRedeployer>(
      RESTORE_REDEPLOYER,
      { strict: false },
    );
    for (const one of redeploys) {
      try {
        await redeployer.redeploy({ kind: one.kind, id: one.id }, meta);
      } catch (error) {
        this.logger.warn(
          `${one.name} was not redeployed after ${serverName} was restored: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
