import { and, inArray, sql } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import type {
  ApplicationStatus,
  ServiceType,
} from '../applications/application.schema';
import { application } from '../applications/application.schema';
import { bucket } from '../buckets/bucket.schema';
import { compose } from '../compose/compose.schema';
import { libsql } from '../databases/libsql/libsql.schema';
import { mariadb } from '../databases/mariadb/mariadb.schema';
import { mongo } from '../databases/mongo/mongo.schema';
import { mysql } from '../databases/mysql/mysql.schema';
import { postgres } from '../databases/postgres/postgres.schema';
import { redis } from '../databases/redis/redis.schema';
import type { DrizzleDB } from '../db/drizzle.module';

// A client could walk Organization → Project → Environment and then
// name nothing inside it, because every service type is findOne-only. The
// Environment read carries its services instead, the way `GET /projects` rows
// carry their children.

/**
 * One deployed service as the Environment read reports it: enough to list it
 * and follow it to its own `GET /<type>/:id`, and nothing more. Deliberately
 * uniform across the eight service types — the summary is a projection, not
 * the service row, so no credential-bearing column can ride along.
 */
export interface EnvironmentServiceSummary {
  /** Which kind of service this is, and so which route reads it in full. */
  serviceType: ServiceType;
  /** The service's own primary key (`applicationId`, `postgresId`, …). */
  serviceId: string;
  name: string;
  appName: string;
  /** The Service's fixed key in a Project config. */
  configName: string;
  description: string | null;
  /** `applicationStatus`, or compose's `composeStatus` — one shared enum. */
  status: ApplicationStatus;
  serverId: string | null;
  createdAt: string;
}

/**
 * A service table and the columns the summary projects out of it. Every
 * service table carries these under the same property names, so the shape is
 * uniform even though the primary key and one status column are not.
 */
export interface ServiceSource {
  serviceType: ServiceType;
  table: PgTable;
  id: AnyPgColumn;
  name: AnyPgColumn;
  appName: AnyPgColumn;
  configName: AnyPgColumn;
  description: AnyPgColumn;
  status: AnyPgColumn;
  serverId: AnyPgColumn;
  createdAt: AnyPgColumn;
  environmentId: AnyPgColumn;
}

/**
 * Every table a service can live in. Keyed by `serviceType` so it stays
 * exhaustive over the `service_type` enum — a ninth engine that forgets to
 * register here would be silently missing from every Environment read.
 */
export const SERVICE_SOURCES: Record<ServiceType, ServiceSource> = {
  application: {
    serviceType: 'application',
    table: application,
    id: application.applicationId,
    name: application.name,
    appName: application.appName,
    configName: application.configName,
    description: application.description,
    status: application.applicationStatus,
    serverId: application.serverId,
    createdAt: application.createdAt,
    environmentId: application.environmentId,
  },
  compose: {
    serviceType: 'compose',
    table: compose,
    id: compose.composeId,
    name: compose.name,
    appName: compose.appName,
    configName: compose.configName,
    description: compose.description,
    // Compose is the one table that names the column after itself.
    status: compose.composeStatus,
    serverId: compose.serverId,
    createdAt: compose.createdAt,
    environmentId: compose.environmentId,
  },
  postgres: {
    serviceType: 'postgres',
    table: postgres,
    id: postgres.postgresId,
    name: postgres.name,
    appName: postgres.appName,
    configName: postgres.configName,
    description: postgres.description,
    status: postgres.applicationStatus,
    serverId: postgres.serverId,
    createdAt: postgres.createdAt,
    environmentId: postgres.environmentId,
  },
  mysql: {
    serviceType: 'mysql',
    table: mysql,
    id: mysql.mysqlId,
    name: mysql.name,
    appName: mysql.appName,
    configName: mysql.configName,
    description: mysql.description,
    status: mysql.applicationStatus,
    serverId: mysql.serverId,
    createdAt: mysql.createdAt,
    environmentId: mysql.environmentId,
  },
  mariadb: {
    serviceType: 'mariadb',
    table: mariadb,
    id: mariadb.mariadbId,
    name: mariadb.name,
    appName: mariadb.appName,
    configName: mariadb.configName,
    description: mariadb.description,
    status: mariadb.applicationStatus,
    serverId: mariadb.serverId,
    createdAt: mariadb.createdAt,
    environmentId: mariadb.environmentId,
  },
  mongo: {
    serviceType: 'mongo',
    table: mongo,
    id: mongo.mongoId,
    name: mongo.name,
    appName: mongo.appName,
    configName: mongo.configName,
    description: mongo.description,
    status: mongo.applicationStatus,
    serverId: mongo.serverId,
    createdAt: mongo.createdAt,
    environmentId: mongo.environmentId,
  },
  redis: {
    serviceType: 'redis',
    table: redis,
    id: redis.redisId,
    name: redis.name,
    appName: redis.appName,
    configName: redis.configName,
    description: redis.description,
    status: redis.applicationStatus,
    serverId: redis.serverId,
    createdAt: redis.createdAt,
    environmentId: redis.environmentId,
  },
  libsql: {
    serviceType: 'libsql',
    table: libsql,
    id: libsql.libsqlId,
    name: libsql.name,
    appName: libsql.appName,
    configName: libsql.configName,
    description: libsql.description,
    status: libsql.applicationStatus,
    serverId: libsql.serverId,
    createdAt: libsql.createdAt,
    environmentId: libsql.environmentId,
  },
  bucket: {
    serviceType: 'bucket',
    table: bucket,
    id: bucket.bucketId,
    name: bucket.name,
    appName: bucket.appName,
    configName: bucket.configName,
    description: bucket.description,
    status: bucket.applicationStatus,
    serverId: bucket.serverId,
    createdAt: bucket.createdAt,
    environmentId: bucket.environmentId,
  },
};

/** The projected columns, in the order the union selects them. */
export const summaryColumns = (
  source: ServiceSource,
): Record<
  keyof Omit<EnvironmentServiceSummary, 'serviceType'>,
  AnyPgColumn
> => ({
  serviceId: source.id,
  name: source.name,
  appName: source.appName,
  configName: source.configName,
  description: source.description,
  status: source.status,
  serverId: source.serverId,
  createdAt: source.createdAt,
});

/**
 * One arm of the union: this table's services in the given environments,
 * narrowed to `serviceIds` when a scope is given.
 */
function selectFrom(
  db: DrizzleDB,
  source: ServiceSource,
  environmentIds: string[],
  serviceIds: string[] | null,
) {
  const columns = summaryColumns(source);
  return db
    .select({
      // The discriminator is a literal, cast because a bare parameter in a
      // union arm has no inferable type.
      serviceType: sql<ServiceType>`${source.serviceType}::text`.as(
        'service_type',
      ),
      serviceId: sql<string>`${columns.serviceId}`.as('service_id'),
      name: sql<string>`${columns.name}`.as('name'),
      appName: sql<string>`${columns.appName}`.as('app_name'),
      configName: sql<string>`${columns.configName}`.as('config_name'),
      description: sql<string | null>`${columns.description}`.as('description'),
      status: sql<ApplicationStatus>`${columns.status}`.as('status'),
      serverId: sql<string | null>`${columns.serverId}`.as('server_id'),
      createdAt: sql<string>`${columns.createdAt}`.as('created_at'),
    })
    .from(source.table)
    .where(
      and(
        inArray(source.environmentId, environmentIds),
        serviceIds ? inArray(source.id, serviceIds) : undefined,
      ),
    );
}

type ServiceSelect = ReturnType<typeof selectFrom>;
type ServiceUnion = ServiceSelect | ReturnType<ServiceSelect['unionAll']>;

/**
 * Every service deployed in one environment that the caller may see, as a
 * single round trip: the eight tables are `union all`-ed rather than queried
 * one by one.
 *
 * Organization scoping is the caller's job — this is only ever reached through
 * `EnvironmentsService.findOne`, which has already resolved that environment
 * inside the caller's organization. `accessedServices`, when given, is the
 * row-level half, the same argument `listEnvironmentDeployments` and
 * `listEnvironmentDomains` take: `null` is every service (owner and admin),
 * and an empty array is none (this read used to take no scope at all,
 * so a member granted one service was told the name, app name, status and
 * Server of every other service in the Environment).
 */
export function listEnvironmentServices(
  db: DrizzleDB,
  environmentId: string,
  accessedServices: string[] | null,
): Promise<EnvironmentServiceSummary[]> {
  if (accessedServices?.length === 0) return Promise.resolve([]);
  return unionOfServices(db, [environmentId], accessedServices);
}

/**
 * The same union across several environments at once — what a Project delete
 * needs, since it has to reach every Service in every Environment beneath it
 * before it may drop the row.
 *
 * One query rather than one per Environment, for `listEnvironmentServices`'s
 * own reason: a Project with four Environments would otherwise pay four round
 * trips before it had even started asking Docker anything. An empty list of
 * environments is answered without touching the database — `inArray` over an
 * empty array is a query whose answer is known.
 */
export function listServicesInEnvironments(
  db: DrizzleDB,
  environmentIds: string[],
): Promise<EnvironmentServiceSummary[]> {
  if (environmentIds.length === 0) return Promise.resolve([]);
  return unionOfServices(db, environmentIds, null);
}

/**
 * The union both readers share. A Project delete passes `null` on purpose: it
 * must reach every Service beneath it, and authorizes each one itself.
 */
function unionOfServices(
  db: DrizzleDB,
  environmentIds: string[],
  serviceIds: string[] | null,
): Promise<EnvironmentServiceSummary[]> {
  const [first, ...rest] = Object.values(SERVICE_SOURCES).map((source) =>
    selectFrom(db, source, environmentIds, serviceIds),
  );
  const union = rest.reduce<ServiceUnion>(
    (acc, arm) => acc.unionAll(arm),
    first,
  );
  // Ordered by the union's output column names — display order first, then
  // enough tie-breakers to make the order total.
  return union.orderBy(sql`name`, sql`service_type`, sql`service_id`);
}
