import { and, asc, eq, exists, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

import { application } from '../applications/application.schema';
import { bucket } from '../buckets/bucket.schema';
import { compose } from '../compose/compose.schema';
import { existingDatabase } from '../databases/postgres/existing-database.schema';
import { mysql } from '../databases/mysql/mysql.schema';
import { postgres } from '../databases/postgres/postgres.schema';
import { redis } from '../databases/redis/redis.schema';
import type { DrizzleDB } from '../db/drizzle.module';
import { project } from '../projects/project.schema';
import { environment } from './environment.schema';

/**
 * One of an Organization's **Cloud Environments** (`CONTEXT.md`, ADR-0048), and
 * why it counts. It counts once however many Cloud accounts or
 * regions it uses.
 */
export interface CloudEnvironment {
  readonly environmentId: string;
  /** The Organization whose Project holds it. */
  readonly organizationId: string;
  /** Its Deploy target is a Cloud account. */
  readonly targetsCloud: boolean;
  /**
   * It holds a Service in a Cloud account: a cloud `web`, a postgres or a
   * mysql on RDS / Cloud SQL, a redis on ElastiCache / Memorystore, a bucket
   * in a cloud, or an Existing database (ADR-0033).
   */
  readonly holdsCloudService: boolean;
}

/**
 * Every Environment of these Organizations that counts as a Cloud Environment:
 * its Deploy target is a Cloud account, or it still holds a Service in one
 * (ADR-0048: counting only the target would let an Environment keep running
 * in a cloud while counting zero). An Environment stops counting once neither
 * is true, or once its row is gone.
 *
 * The one definition of the count: `BillingService.usageOf` (the billing
 * page, checkout's Add-on floor, the Operator page) and the two refusal
 * points (`BillingService.assertRoomForCloudTarget`, and
 * `assertRoomForCloudServices` on a Project config Apply) all read it.
 *
 * A list of Organizations rather than one, because the count is a pool's: a
 * Paying Organization's and every Organization attached to it, read in one
 * query and told apart by `organizationId` (`paying-organization.ts`,
 * ADR-0059). An empty list holds none.
 */
export async function cloudEnvironmentsOf(
  db: DrizzleDB,
  organizationIds: readonly string[],
): Promise<CloudEnvironment[]> {
  if (organizationIds.length === 0) return [];
  const holding = (
    table: PgTable,
    environmentId: AnyColumn,
    cloudAccountId: AnyColumn,
  ) =>
    exists(
      db
        .select({ one: sql`1` })
        .from(table)
        .where(
          and(
            eq(environmentId, environment.environmentId),
            isNotNull(cloudAccountId),
          ),
        ),
    );
  // An Existing database's place is on its own row, not its Service's.
  const existingOf = (table: typeof postgres | typeof mysql | typeof redis) => {
    const idColumn =
      table === postgres
        ? existingDatabase.postgresId
        : table === mysql
          ? existingDatabase.mysqlId
          : existingDatabase.redisId;
    const serviceId =
      table === postgres
        ? postgres.postgresId
        : table === mysql
          ? mysql.mysqlId
          : redis.redisId;
    return exists(
      db
        .select({ one: sql`1` })
        .from(existingDatabase)
        .innerJoin(table, eq(serviceId, idColumn))
        .where(eq(table.environmentId, environment.environmentId)),
    );
  };

  const rows = await db
    .select({
      environmentId: environment.environmentId,
      organizationId: project.organizationId,
      deployTarget: environment.deployTarget,
      holdsCloudService: sql<boolean>`${or(
        holding(
          application,
          application.environmentId,
          application.cloudAccountId,
        ),
        holding(postgres, postgres.environmentId, postgres.cloudAccountId),
        holding(mysql, mysql.environmentId, mysql.cloudAccountId),
        holding(redis, redis.environmentId, redis.cloudAccountId),
        holding(bucket, bucket.environmentId, bucket.cloudAccountId),
        // A Compose stack's Stack VM, counted only here (ADR-0048, ADR-0070).
        holding(compose, compose.environmentId, compose.cloudAccountId),
        existingOf(postgres),
        existingOf(mysql),
        existingOf(redis),
      )}`,
    })
    .from(environment)
    .innerJoin(project, eq(project.projectId, environment.projectId))
    .where(inArray(project.organizationId, [...organizationIds]))
    .orderBy(asc(environment.createdAt), asc(environment.environmentId));

  return rows.flatMap((row) => {
    const targetsCloud = row.deployTarget.kind === 'cloud';
    const holdsCloudService = row.holdsCloudService === true;
    return targetsCloud || holdsCloudService
      ? [
          {
            environmentId: row.environmentId,
            organizationId: row.organizationId,
            targetsCloud,
            holdsCloudService,
          },
        ]
      : [];
  });
}
