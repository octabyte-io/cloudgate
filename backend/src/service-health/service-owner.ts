import { eq, sql } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { application } from '../applications/application.schema';
import type {
  ApplicationStatus,
  ServiceType,
  WorkloadServiceType,
} from '../applications/application.schema';
import { bucket } from '../buckets/bucket.schema';
import { compose } from '../compose/compose.schema';
import { SERVICE_TABLES } from '../common/service-parent';
import { libsql } from '../databases/libsql/libsql.schema';
import { mariadb } from '../databases/mariadb/mariadb.schema';
import { mongo } from '../databases/mongo/mongo.schema';
import { mysql } from '../databases/mysql/mysql.schema';
import { postgres } from '../databases/postgres/postgres.schema';
import { redis } from '../databases/redis/redis.schema';
import type { DrizzleDB } from '../db/drizzle.module';
import { environment } from '../environments/environment.schema';
import { project } from '../projects/project.schema';
import type { UptimeCheck } from './service-health.schema';

// Which Service owns a check, and what the probe tick and the Notification
// need to know about it. Kept beside the schema rather than in
// `common/service-parent.ts` because the status column is this module's
// question alone: `SERVICE_TABLES` names the columns every service table
// shares, and a Service's status is spelled `compose_status` on one of them.

/** Each Service kind's table, id and status column. */
export const SERVICE_STATUS: Record<
  ServiceType,
  { table: PgTable; id: AnyPgColumn; status: AnyPgColumn }
> = {
  application: {
    table: application,
    id: application.applicationId,
    status: application.applicationStatus,
  },
  compose: {
    table: compose,
    id: compose.composeId,
    status: compose.composeStatus,
  },
  postgres: {
    table: postgres,
    id: postgres.postgresId,
    status: postgres.applicationStatus,
  },
  mysql: { table: mysql, id: mysql.mysqlId, status: mysql.applicationStatus },
  mariadb: {
    table: mariadb,
    id: mariadb.mariadbId,
    status: mariadb.applicationStatus,
  },
  mongo: { table: mongo, id: mongo.mongoId, status: mongo.applicationStatus },
  redis: { table: redis, id: redis.redisId, status: redis.applicationStatus },
  libsql: {
    table: libsql,
    id: libsql.libsqlId,
    status: libsql.applicationStatus,
  },
  bucket: {
    table: bucket,
    id: bucket.bucketId,
    status: bucket.applicationStatus,
  },
};

/** The uptime-check column each Service kind's checks hang off, by property. */
export const UPTIME_CHECK_OWNER_FIELD = {
  application: 'applicationId',
  postgres: 'postgresId',
  mysql: 'mysqlId',
  mariadb: 'mariadbId',
  mongo: 'mongoId',
  redis: 'redisId',
  compose: 'composeId',
  libsql: 'libsqlId',
} as const satisfies Record<WorkloadServiceType, keyof UptimeCheck>;

/**
 * The owning Service's id, read through the column the discriminant names and
 * no other (`uptime_check_parent_matches_service_type` makes them agree).
 */
export function ownerIdOf(
  check: Pick<
    UptimeCheck,
    | 'serviceType'
    | (typeof UPTIME_CHECK_OWNER_FIELD)[UptimeCheck['serviceType']]
  >,
): string {
  return check[UPTIME_CHECK_OWNER_FIELD[check.serviceType]] as string;
}

/**
 * A Stopped Service is not probed, and its open Incident is closed with
 * `service-stopped`. `'stopped'` is what every Stop writes now;
 * a Service stopped in older versions still wears `'idle'` and is
 * indistinguishable from one never deployed, which is probed — and is down,
 * which is true.
 */
export const isStopped = (status: ApplicationStatus | null): boolean =>
  status === 'stopped';

/** The owning Service's status now, or null when the Service is gone. */
export async function ownerStatus(
  db: Pick<DrizzleDB, 'select'>,
  serviceType: ServiceType,
  serviceId: string,
): Promise<ApplicationStatus | null> {
  const { table, id, status } = SERVICE_STATUS[serviceType];
  const [row] = await db
    .select({ status: sql<ApplicationStatus>`${status}` })
    .from(table)
    .where(eq(id, serviceId))
    .limit(1);
  return row?.status ?? null;
}

/** What a Notification names about the owning Service. */
export interface OwnerFacts {
  name: string;
  projectName: string;
  environmentName: string;
  organizationId: string;
}

/**
 * The owning Service's names and Organization, with no caller: the probe tick
 * and a Stop's close run with no session, and the Service's own Organization
 * is who hears about its Incident. Null when the Service is gone.
 */
export async function ownerFacts(
  db: DrizzleDB,
  serviceType: ServiceType,
  serviceId: string,
): Promise<OwnerFacts | null> {
  const columns = SERVICE_TABLES[serviceType];
  const [row] = await db
    .select({
      name: sql<string>`${columns.name}`,
      projectName: project.name,
      environmentName: environment.name,
      organizationId: project.organizationId,
    })
    .from(columns.table)
    .innerJoin(
      environment,
      eq(columns.environmentId, environment.environmentId),
    )
    .innerJoin(project, eq(environment.projectId, project.projectId))
    .where(eq(columns.id, serviceId))
    .limit(1);
  return row ?? null;
}
