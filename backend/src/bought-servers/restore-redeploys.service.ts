import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { and, eq, exists, gt, isNull, sql } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { FrozenOrganizations } from '../cloud/billing/frozen-organizations.service';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import {
  application,
  bucket,
  compose,
  deployment,
  libsql,
  mariadb,
  mongo,
  mysql,
  postgres,
  redis,
} from '../db/schema';
import type { RestoreRedeploy } from '../db/schema';
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

/** How starting one redeploy went: started, or refused before it started and why. */
export type RedeployStart =
  { started: true } | { started: false; reason: string };

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
 * readiness rule. Which are started, once each, and the email after, is
 * `BoughtServerRestoreSteps`' (the stored `restoreRedeploys`).
 */
@Injectable()
export class RestoreRedeploys {
  private readonly logger = new Logger(RestoreRedeploys.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly moduleRef: ModuleRef,
    private readonly frozen: FrozenOrganizations,
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
   * Starts one redeploy, never throwing. A Frozen Organization starts no
   * deploy (ADR-0052), so none is started for one, and the refusal says so.
   * A refusal before it starts (that, or one of the deploy's own) is
   * recorded on its Service as a failed deploy and answered with why; once
   * started, it fails on its own Service as its deploy does. Neither fails
   * the Restore.
   */
  async start(
    organizationId: string,
    serverName: string,
    backupTakenAt: string,
    one: RestoreRedeploy,
  ): Promise<RedeployStart> {
    const meta = {
      title: `Redeploy after restoring ${serverName}`,
      description: `Queued by restoring ${serverName} from its backup of ${backupDateOf(backupTakenAt)}, since it was deployed after that backup`,
    };
    const redeployer = this.moduleRef.get<RestoreRedeployer>(
      RESTORE_REDEPLOYER,
      { strict: false },
    );
    const service = { kind: one.kind, id: one.id };
    let reason: string;
    try {
      const frozen = await this.frozen.refusalAt({ organizationId });
      if (frozen === null) {
        await redeployer.redeploy(service, meta);
        return { started: true };
      }
      reason = `its Organization is frozen (${frozen}), so no deploy starts`;
    } catch (error) {
      reason = refusalOf(error);
    }
    this.logger.warn(
      `${one.name} was not redeployed after ${serverName} was restored: ${reason}`,
    );
    try {
      await redeployer.recordRefused(service, meta, reason);
    } catch (error) {
      this.logger.error(
        `${one.name}: could not record that its redeploy after ${serverName} was restored was refused: ${refusalOf(error)}`,
      );
    }
    return { started: false, reason };
  }
}

/** A refusal's own words: an HTTP refusal's message, as its caller is shown it. */
function refusalOf(error: unknown): string {
  if (error instanceof HttpException) {
    const body = error.getResponse();
    if (typeof body === 'object' && body !== null && 'message' in body) {
      const { message } = body;
      if (typeof message === 'string') return message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
