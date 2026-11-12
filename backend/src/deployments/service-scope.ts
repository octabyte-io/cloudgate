import { NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { unionAll } from 'drizzle-orm/pg-core';
import { application } from '../applications/application.schema';
import type { ServiceType } from '../applications/application.schema';
import { backupServiceFk } from '../backups/backup.schema';
import { bucket } from '../buckets/bucket.schema';
import { SERVICE_TABLES as PARENT_TABLES } from '../common/service-parent';
import { compose } from '../compose/compose.schema';
import { libsql } from '../databases/libsql/libsql.schema';
import { mariadb } from '../databases/mariadb/mariadb.schema';
import { mongo } from '../databases/mongo/mongo.schema';
import { mysql } from '../databases/mysql/mysql.schema';
import { postgres } from '../databases/postgres/postgres.schema';
import { redis } from '../databases/redis/redis.schema';
import type { DrizzleDB } from '../db/drizzle.module';
import type { DeploymentParentKind } from '../deployment-engine/ports/deployment-recorder';
import { schedule } from '../scheduling/schedules/schedule.schema';
import { volumeBackupServiceFk } from '../volume-backups/volume-backup.schema';
import { deployment } from './deployment.schema';
import type { Deployment } from './deployment.schema';

// The organization-wide feed resolves every deployment to the
// service it belongs to, and a service is any of the eight service tables.
// `findParentService` (src/common/service-parent.ts) dispatches over the same
// eight one row at a time, which a feed cannot do — one query per row is the
// N+1 the feed exists to remove. This is the set-shaped sibling: the eight
// tables as one `(serviceId, serviceType, name, appName, environmentId)` relation
// to join against, leaving the environment → project → organizationId scoping
// to the caller, which needs those columns on the row anyway.

interface ServiceTable {
  table: PgTable;
  id: AnyPgColumn;
  name: AnyPgColumn;
  /** The Docker-side identity: what a managed container's labels carry. */
  appName: AnyPgColumn;
  environmentId: AnyPgColumn;
  type: ServiceType;
}

const SERVICE_TABLES: ServiceTable[] = [
  {
    table: application,
    id: application.applicationId,
    name: application.name,
    appName: application.appName,
    environmentId: application.environmentId,
    type: 'application',
  },
  {
    table: compose,
    id: compose.composeId,
    name: compose.name,
    appName: compose.appName,
    environmentId: compose.environmentId,
    type: 'compose',
  },
  {
    table: postgres,
    id: postgres.postgresId,
    name: postgres.name,
    appName: postgres.appName,
    environmentId: postgres.environmentId,
    type: 'postgres',
  },
  {
    table: mysql,
    id: mysql.mysqlId,
    name: mysql.name,
    appName: mysql.appName,
    environmentId: mysql.environmentId,
    type: 'mysql',
  },
  {
    table: mariadb,
    id: mariadb.mariadbId,
    name: mariadb.name,
    appName: mariadb.appName,
    environmentId: mariadb.environmentId,
    type: 'mariadb',
  },
  {
    table: mongo,
    id: mongo.mongoId,
    name: mongo.name,
    appName: mongo.appName,
    environmentId: mongo.environmentId,
    type: 'mongo',
  },
  {
    table: redis,
    id: redis.redisId,
    name: redis.name,
    appName: redis.appName,
    environmentId: redis.environmentId,
    type: 'redis',
  },
  {
    table: libsql,
    id: libsql.libsqlId,
    name: libsql.name,
    appName: libsql.appName,
    environmentId: libsql.environmentId,
    type: 'libsql',
  },
  {
    table: bucket,
    id: bucket.bucketId,
    name: bucket.name,
    appName: bucket.appName,
    environmentId: bucket.environmentId,
    type: 'bucket',
  },
];

const branch = (db: DrizzleDB, service: ServiceTable) =>
  db
    .select({
      serviceId: service.id,
      // Inlined rather than bound: a bare parameter in a UNION branch's
      // select list has no type for Postgres to infer. The value is one of
      // this file's own literals, never caller input.
      serviceType: sql<ServiceType>`${sql.raw(`'${service.type}'`)}`.as(
        'service_type',
      ),
      name: service.name,
      appName: service.appName,
      environmentId: service.environmentId,
      // Where it runs, for the container gate: a label names a
      // Service, and only a Service on the machine being acted on owns what
      // carries it. Read off the resolver's own map rather than a third copy
      // of which kinds a Cloud account can run; aliased because a bare
      // `server_id` or `cloud_account_id` is ambiguous beside the joins every
      // caller makes.
      serverId: sql<string | null>`${PARENT_TABLES[service.type].serverId}`.as(
        'service_server_id',
      ),
      cloudAccountId: sql<string | null>`${
        PARENT_TABLES[service.type].cloudAccountId ?? sql`null::text`
      }`.as('service_cloud_account_id'),
    })
    .from(service.table);

/**
 * Every service row in the database as one relation, for joining a
 * polymorphic service id against. Org scoping is the caller's job: join
 * `environmentId` through environment → project like every service read does.
 *
 * `appName` rides along for the container listing, which joins the other way — a managed
 * container's Docker labels carry the appName, and the question is which
 * Service that names. Same eight tables, so the same enumeration answers it.
 */
export function serviceScope(db: DrizzleDB) {
  const [first, second, ...rest] = SERVICE_TABLES.map((service) =>
    branch(db, service),
  );
  return unionAll(first, second, ...rest).as('service');
}

// The two deployment feeds — `GET /deployments` for the
// Organization and `GET /environments/:id/deployments` — join the
// relation above to answer the same two questions: which service is this run
// about, and which owner does the record hang off. They answered them with two
// copies of the code below, which is one enumeration of every service-owning
// FK too many: adding an owner kind to one copy and not the other silently
// drops that kind's rows out of a feed through the join. One copy, here, beside
// the relation it is joined against.

/** The owning foreign keys of a deployment record — **at most** one is set.
 * The row type, so it is nullable five ways: `deployment_at_most_one_parent`
 * refuses two, and a parentless deployment is deliberate rather than an orphan
 * ({@link ownerOf} answers 404 for it). The writers say which one they mean by
 * kind instead (ADR-0017); this is what a *reader* is handed. */
export type DeploymentOwnerFks = Pick<
  Deployment,
  | 'applicationId'
  | 'composeId'
  | 'backupId'
  | 'volumeBackupId'
  | 'scheduleId'
  | 'environmentNetworkId'
  | 'postgresId'
  | 'mysqlId'
  | 'bucketId'
  | 'redisId'
>;

/**
 * Which of the five owner kinds a deployment record belongs to.
 *
 * Derived from the write side's own vocabulary rather than spelled a second
 * time: `DeploymentParentKind` is these five plus `none` for the
 * deliberately parentless deployment, which a *reader* has no owner to name
 * and so answers 404 for — see {@link ownerOf}. Two hand-written copies of one
 * enumeration is the shape this file already exists to remove one level down
 * (the two feeds' copies of `ownerOf`), and a write side and a read side that name
 * the same five owners differently is how a precedence disagreement
 * started.
 */
export type DeploymentOwnerType = Exclude<DeploymentParentKind, 'none'>;

/** Which owner a feed row hangs off, and what a feed calls it. */
export interface DeploymentOwner {
  type: DeploymentOwnerType;
  id: string;
  name: string;
}

/** The names a feed row can be titled with, one per owner kind: the owning
 * service's own name for a build, the schedule's or backup's for a run. Null
 * where the feed's join found no row to take a name from. */
export interface OwnerNames {
  serviceName: string | null;
  scheduleName: string | null;
  volumeBackupName: string | null;
  backupName: string | null;
  /**
   * The Environment network's region, which titles its runs as
   * "Environment network (<region>)"; null where the feed did not
   * join the network.
   */
  networkRegion: string | null;
}

/** How an Environment network is named where a person reads it. */
export function environmentNetworkName(region: string | null): string {
  return region === null
    ? 'Environment network'
    : `Environment network (${region})`;
}

/**
 * The service a deployment row is about, whichever owner it hangs off: at most
 * one FK is set on the record (deployment.schema.ts) and exactly one on the
 * run-owning row it reaches, so coalescing them all picks the one service
 * without branching. Null for a run that owns no service — a server or
 * cloudgate-server schedule — and for the parentless record, which owns none.
 *
 * Joined against `serviceScope`'s `serviceId`. Both feeds reach the run-owning
 * rows the same way, left-joining `schedule`, `volume_backup` and `backup` on
 * the record's own FKs, so those tables are in scope wherever this is.
 *
 * **The `coalesce` order is {@link ownerOf}'s precedence, in SQL**
 * (ADR-0017): the record's own two parents first, application before compose,
 * then one group per run-owning table in the same order the branches below
 * test them. It decides which service a row is *listed* under while `ownerOf`
 * decides what it is *titled*, so the two ranking the owner kinds differently
 * would show a feed row under one service with another service's name on it.
 * `test/deployments/service-scope.spec.ts` renders this SQL and asserts the
 * order rather than leaving it to this paragraph.
 */
export function ownedServiceId(): SQL {
  return sql`coalesce(${sql.join(
    [
      deployment.applicationId,
      deployment.composeId,
      schedule.applicationId,
      schedule.composeId,
      ...Object.values(volumeBackupServiceFk),
      ...Object.values(backupServiceFk),
      // A postgres on RDS's own Cloud run: the Service it is about.
      deployment.postgresId,
      // A mysql on RDS's, likewise.
      deployment.mysqlId,
      // A bucket on AWS's own Cloud run, likewise.
      deployment.bucketId,
      // A redis on ElastiCache's, likewise.
      deployment.redisId,
    ],
    sql`, `,
  )})`;
}

/**
 * Which owner a record belongs to, and what to call it.
 *
 * Names are passed in rather than read off the row: a feed resolves them under
 * whatever column names its own query is free of collisions in (`serviceName`
 * here, `svcName` there), and taking them as an argument is what lets a caller
 * destructure them out of the record it spreads onto the wire *and* still use
 * them — no name left unread only to keep it out of a spread.
 *
 * The fallthrough throws rather than returning an untitled owner. It is
 * unreachable from either feed — the Environment feed's inner join on the
 * service relation only matches rows that reached one of the five FKs, and the
 * Organization feed selects from `deployment`, where the schema sets one — so
 * the cost is a branch that never runs, against a feed row naming the wrong
 * thing (or nothing) if that ever stops being true.
 *
 * **The order of these branches is the product's one precedence over a
 * deployment record's owners** — application, compose, schedule, volume
 * backup, backup, and the Environment network, which owns no
 * Service and so changes no listing — and this is the only place it is written in
 * TypeScript. `DeploymentsService.create` used to state the opposite for the
 * first two (`input.composeId ?? input.applicationId`), which is the
 * disagreement that was opened about; it now branches on a discriminated parent and
 * ranks nothing, so there is no second spelling to keep in step. What settled
 * *this* order rather than compose-first is that it is the only one with
 * readers behind it, and one of them has already shipped:
 *
 * - both feeds title every row through this function;
 * - {@link ownedServiceId} coalesces in the same order, so both feeds *list*
 *   rows by it too;
 * - `DeploymentsService.resolveCancelScope` and `resolveLogServer` test
 *   `applicationId` before `composeId`, and `scheduleRunServer` ranks the
 *   same pair the same way one table over (`row.applicationId ??
 *   row.composeId` on a `schedule` row);
 * - **0064 normalized by it.** The migration resolved the two-parented
 *   rows an install could already hold down to `application_id` — "the owner
 *   its feeds already titled it by", `test/db/parent-consistency.e2e-spec.ts`
 *   — so reversing the order now would relabel rows a shipped migration has
 *   already decided about, with nothing left in the database to appeal to.
 *
 * ADR-0017 carries the decision. `test/deployments/service-scope.spec.ts`
 * pins the order against a row carrying several ids, which
 * `deployment_at_most_one_parent` and the parent union together make unwritable
 * but which an install older than 0064 could hand a reader.
 */
export function ownerOf(
  row: DeploymentOwnerFks,
  names: OwnerNames,
): DeploymentOwner {
  const named = (type: DeploymentOwnerType, id: string, name: string | null) =>
    ({ type, id, name: name ?? '' }) as const;
  if (row.applicationId) {
    return named('application', row.applicationId, names.serviceName);
  }
  if (row.composeId) {
    return named('compose', row.composeId, names.serviceName);
  }
  if (row.scheduleId) {
    return named('schedule', row.scheduleId, names.scheduleName);
  }
  if (row.volumeBackupId) {
    return named('volumeBackup', row.volumeBackupId, names.volumeBackupName);
  }
  if (row.backupId) {
    return named('backup', row.backupId, names.backupName);
  }
  // A postgres on RDS's Cloud run, titled by the Service's name.
  if (row.postgresId) {
    return named('postgres', row.postgresId, names.serviceName);
  }
  // A mysql on RDS's Cloud run, likewise.
  if (row.mysqlId) {
    return named('mysql', row.mysqlId, names.serviceName);
  }
  // A bucket on AWS's Cloud run, titled by the Service's name.
  if (row.bucketId) {
    return named('bucket', row.bucketId, names.serviceName);
  }
  // A redis on ElastiCache's Cloud run, likewise.
  if (row.redisId) {
    return named('redis', row.redisId, names.serviceName);
  }
  // Last: a network's run owns no Service, so it is listed under
  // none and only ever titled.
  if (row.environmentNetworkId) {
    return named(
      'environmentNetwork',
      row.environmentNetworkId,
      environmentNetworkName(names.networkRegion),
    );
  }
  throw new NotFoundException('Deployment not found');
}
