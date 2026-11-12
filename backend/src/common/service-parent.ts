import { NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { application } from '../applications/application.schema';
import type { ServiceType } from '../applications/application.schema';
import { bucket } from '../buckets/bucket.schema';
import { compose } from '../compose/compose.schema';
import type { ComposeType } from '../compose/compose.schema';
import { libsql } from '../databases/libsql/libsql.schema';
import { mariadb } from '../databases/mariadb/mariadb.schema';
import { mongo } from '../databases/mongo/mongo.schema';
import { mysql } from '../databases/mysql/mysql.schema';
import { postgres } from '../databases/postgres/postgres.schema';
import { redis } from '../databases/redis/redis.schema';
import type { DrizzleDB } from '../db/drizzle.module';
import { environment } from '../environments/environment.schema';
import { project } from '../projects/project.schema';

// The polymorphic "which service owns this row" lookup shared by mounts
// (Phase 33) and volume backups (Phase 36, extracted here from
// MountsService): every service table joins environment → project so rows
// outside the caller's organization read as not found.

/**
 * The columns of one service table, by the property names every service table
 * shares. Named and exported so a caller taking a subset of
 * {@link SERVICE_TABLES} can annotate it without restating the shape.
 */
export interface ServiceTableColumns {
  table: PgTable;
  id: AnyPgColumn;
  name: AnyPgColumn;
  appName: AnyPgColumn;
  environmentId: AnyPgColumn;
  serverId: AnyPgColumn;
  /** Compose only — stack vs docker-compose changes generated commands. */
  composeType?: AnyPgColumn;
  /**
   * Only the kinds a Cloud account can run: set when the Service runs there,
   * so it has no container of its own.
   */
  cloudAccountId?: AnyPgColumn;
}

/**
 * The parent tables the polymorphic lookup dispatches over; every service
 * table shares these column property names.
 *
 * **Exported, and the two callers that asked for it are the
 * reason.** It was private while {@link findParentService} was its only
 * reader, and two modules then built narrower copies rather than reach it:
 * `deployments/service-scope.ts` has its own `SERVICE_TABLES`, and the then
 * `BackupsService.servicesOwningPrefixes` composed one out of `ENGINE_TABLES`
 * plus `compose` and recorded in its docblock that *"closing it wants
 * `SERVICE_TABLES` exported and this resolver moved to `common/`"* — the gap
 * being that an `application`'s or a `redis`' bucket prefix reads as unowned
 * there, so a volume-backup tarball parked under one is restorable by anyone
 * the level lets through. A narrower list is sometimes correct (a *database
 * dump* really can only belong to the five engines or a stack), so this is
 * exported rather than made mandatory: a caller that wants six of the eight
 * should now say so against this map instead of restating it (§1.4, the
 * lesson about copies that drift).
 */
export const SERVICE_TABLES: Record<ServiceType, ServiceTableColumns> = {
  application: {
    table: application,
    id: application.applicationId,
    name: application.name,
    appName: application.appName,
    environmentId: application.environmentId,
    serverId: application.serverId,
    cloudAccountId: application.cloudAccountId,
  },
  postgres: {
    table: postgres,
    id: postgres.postgresId,
    name: postgres.name,
    appName: postgres.appName,
    environmentId: postgres.environmentId,
    serverId: postgres.serverId,
    cloudAccountId: postgres.cloudAccountId,
  },
  mysql: {
    table: mysql,
    id: mysql.mysqlId,
    name: mysql.name,
    appName: mysql.appName,
    environmentId: mysql.environmentId,
    serverId: mysql.serverId,
    cloudAccountId: mysql.cloudAccountId,
  },
  mariadb: {
    table: mariadb,
    id: mariadb.mariadbId,
    name: mariadb.name,
    appName: mariadb.appName,
    environmentId: mariadb.environmentId,
    serverId: mariadb.serverId,
  },
  mongo: {
    table: mongo,
    id: mongo.mongoId,
    name: mongo.name,
    appName: mongo.appName,
    environmentId: mongo.environmentId,
    serverId: mongo.serverId,
  },
  redis: {
    table: redis,
    id: redis.redisId,
    name: redis.name,
    appName: redis.appName,
    environmentId: redis.environmentId,
    serverId: redis.serverId,
    cloudAccountId: redis.cloudAccountId,
  },
  compose: {
    table: compose,
    id: compose.composeId,
    name: compose.name,
    appName: compose.appName,
    environmentId: compose.environmentId,
    serverId: compose.serverId,
    // A stack on its own Stack VM (ADR-0070): `serverId: null` there is not
    // the platform host.
    cloudAccountId: compose.cloudAccountId,
    composeType: compose.composeType,
  },
  libsql: {
    table: libsql,
    id: libsql.libsqlId,
    name: libsql.name,
    appName: libsql.appName,
    environmentId: libsql.environmentId,
    serverId: libsql.serverId,
  },
  bucket: {
    table: bucket,
    id: bucket.bucketId,
    name: bucket.name,
    appName: bucket.appName,
    environmentId: bucket.environmentId,
    serverId: bucket.serverId,
    cloudAccountId: bucket.cloudAccountId,
  },
};

export interface ServiceParent {
  serviceId: string;
  /** The service's display name (notification payloads). */
  name: string;
  appName: string;
  serverId: string | null;
  /** The owning project's name and organization (notification payloads). */
  projectName: string;
  organizationId: string;
  /** Compose parents only; null for every other service type. */
  composeType: ComposeType | null;
  /** The Cloud account it runs in; null on a Server or the platform host,
   *  and for every kind no Cloud account can run. */
  cloudAccountId: string | null;
}

/**
 * The service a row attaches to, org-scoped through environment → project
 * like every service lookup, dispatched over the owning table. Throws
 * NotFound for rows outside the organization (cross-org reads look absent).
 * A null organizationId skips the org filter — reserved for scheduled
 * (system) runs, which execute with no user session.
 */
export async function findParentService(
  db: DrizzleDB,
  organizationId: string | null,
  serviceId: string,
  serviceType: ServiceType,
): Promise<ServiceParent> {
  const columns = SERVICE_TABLES[serviceType];
  const fields: Record<string, AnyPgColumn> = {
    serviceId: columns.id,
    name: columns.name,
    appName: columns.appName,
    serverId: columns.serverId,
    projectName: project.name,
    organizationId: project.organizationId,
  };
  if (columns.composeType) fields.composeType = columns.composeType;
  if (columns.cloudAccountId) fields.cloudAccountId = columns.cloudAccountId;
  const [found] = await db
    .select(fields)
    .from(columns.table)
    .innerJoin(
      environment,
      eq(columns.environmentId, environment.environmentId),
    )
    .innerJoin(project, eq(environment.projectId, project.projectId))
    .where(
      and(
        eq(columns.id, serviceId),
        ...(organizationId ? [eq(project.organizationId, organizationId)] : []),
      ),
    )
    .limit(1);
  if (!found) throw new NotFoundException('Service not found');
  return {
    composeType: null,
    cloudAccountId: null,
    ...found,
  } as unknown as ServiceParent;
}
