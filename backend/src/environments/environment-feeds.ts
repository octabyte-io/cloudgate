import { and, desc, eq, getTableColumns, inArray, sql, SQL } from 'drizzle-orm';
import { backup } from '../backups/backup.schema';
import type { ServiceType } from '../applications/application.schema';
import type { DrizzleDB } from '../db/drizzle.module';
import { deployment } from '../deployments/deployment.schema';
import type { Deployment } from '../deployments/deployment.schema';
import {
  ownedServiceId,
  ownerOf,
  serviceScope,
} from '../deployments/service-scope';
import type { DeploymentOwner } from '../deployments/service-scope';
import { domain } from '../domains/domain.schema';
import type { Domain } from '../domains/domain.schema';
import { schedule } from '../scheduling/schedules/schedule.schema';
import { volumeBackup } from '../volume-backups/volume-backup.schema';

// An Environment's Deployments and Domains tabs had no read behind
// them, and the services summary only unblocked the *first* step — `GET
// /environments/:id` enumerates the services, so a client could have fanned out
// one request per service per tab. This is the other option, and the reason it
// was chosen: one request per tab means there is no partial-failure state to
// design, because there is no set of independent requests that can half-fail.
//
// Both feeds are the same join, and it is deliberately the one `GET /deployments`
// already writes for the Organization (`deployments/service-scope.ts`):
// the eight service tables as one `(serviceId, serviceType, name,
// environmentId)` relation. The Organization feed leaves that relation's
// `environmentId` to be walked up to a `project.organizationId`; an Environment
// feed stops one join earlier and filters on `environmentId` itself. A second,
// differently shaped join over the same tables is how two endpoints start
// disagreeing about the same question.

/** The service a feed row is about — always resolved, because both feeds
 * reach their rows *through* a service in this Environment. Enough to name it
 * and follow it to its own screen, like the services summary. */
export interface FeedService {
  serviceType: ServiceType;
  serviceId: string;
  name: string;
}

/**
 * `serviceScope`'s relation with its columns renamed `svc_*`.
 *
 * A union's output columns are named after its first branch, so the relation
 * arrives as `application_id`/`service_type`/`name`/`environment_id` — and
 * drizzle references a subquery's `sql` field by its bare output name. Both
 * feeds join tables that carry those same names (`volume_backup.service_type`,
 * `domain.service_name`), and Postgres rejects the bare reference as
 * ambiguous. Re-projecting through one more subquery — which Postgres flattens
 * — gives every column a name nothing else in either query has, without
 * teaching this file the alias `service-scope.ts` chose.
 */
function environmentServices(db: DrizzleDB) {
  const inner = serviceScope(db);
  return db
    .select({
      serviceId: sql<string>`${inner.serviceId}`.as('svc_id'),
      serviceType: sql<ServiceType>`${inner.serviceType}`.as('svc_type'),
      name: sql<string>`${inner.name}`.as('svc_name'),
      environmentId: sql<string>`${inner.environmentId}`.as('svc_env_id'),
    })
    .from(inner)
    .as('env_service');
}

/**
 * One row of an Environment's Deployment feed: the record, the service whose
 * Environment put it in this feed, and the owner the record actually hangs off.
 *
 * `owner` and `service` differ for the three run kinds. A nightly Postgres
 * backup's record belongs to the `backup` row — that is what names it — while
 * the service that puts it in *this* Environment is the Postgres instance. The
 * Organization feed carries `project`/`environment` in this slot instead; here
 * both are the Environment being read, so the service is the useful half.
 */
export interface EnvironmentDeploymentRow extends Deployment {
  owner: DeploymentOwner;
  service: FeedService;
}

/** One row of an Environment's Domains feed: the `domain` row plus which
 * service answers it. A domain always has an owning Application or Compose
 * stack (`POST /domains` demands one), so `service` is never null. */
export interface EnvironmentDomainRow extends Domain {
  service: FeedService;
}

/**
 * What the deployment feed's query selects: the record plus the flat names.
 *
 * The joined service's columns are `svc*` here too, matching the domains feed —
 * the record being spread in is the whole of another table, and a name it might
 * one day also use is a collision waiting to eat a column.
 */
interface FeedQueryRow extends Deployment {
  svcType: ServiceType;
  svcId: string;
  svcName: string;
  scheduleName: string | null;
  volumeBackupName: string | null;
  backupName: string | null;
}

/**
 * Every deployment record of every service in one Environment, newest first.
 *
 * **Unpaged, like the two per-service lists it replaces**
 * (`findAllByApplicationId` / `findAllByComposeId`). The Organization feed is
 * cursor-paged because it is the whole tenant's history and its cursor is a
 * wire format that must not become an existence oracle; an Environment's tab
 * is the union of a handful of per-service lists that already answer in full,
 * and inventing a second pagination shape for it would be the disagreement
 * this file exists to avoid.
 *
 * Scoping is the caller's job: this filters on `environmentId` alone and is
 * only reached through `EnvironmentsService`, which has already resolved that
 * Environment inside the caller's organization. `accessedServices`, when
 * given, is the row-level half the per-service reads apply one row at a time.
 */
export async function listEnvironmentDeployments(
  db: DrizzleDB,
  environmentId: string,
  accessedServices: string[] | null,
): Promise<EnvironmentDeploymentRow[]> {
  const service = environmentServices(db);

  const conditions: SQL[] = [eq(service.environmentId, environmentId)];
  if (accessedServices) {
    conditions.push(inArray(sql`${service.serviceId}`, accessedServices));
  }

  const found = await db
    .select({
      ...getTableColumns(deployment),
      svcType: sql<ServiceType>`${service.serviceType}`,
      svcId: sql<string>`${service.serviceId}`,
      svcName: sql<string>`${service.name}`,
      scheduleName: schedule.name,
      volumeBackupName: volumeBackup.name,
      backupName: backup.appName,
    })
    .from(deployment)
    // The owner rows a run hangs off, so the service under a scheduled or
    // backup run resolves in the same query as the service under a build.
    .leftJoin(schedule, eq(schedule.scheduleId, deployment.scheduleId))
    .leftJoin(
      volumeBackup,
      eq(volumeBackup.volumeBackupId, deployment.volumeBackupId),
    )
    .leftJoin(backup, eq(backup.backupId, deployment.backupId))
    // Inner, not left: a run that owns no service — a server or
    // cloudgate-server schedule — belongs to the Organization directly and is
    // in no Environment, so it drops out here rather than being filtered.
    .innerJoin(service, eq(service.serviceId, ownedServiceId()))
    .where(and(...conditions))
    .orderBy(desc(deployment.createdAt), desc(deployment.deploymentId));

  return found.map((row) => toDeploymentRow(row));
}

/** The flat query row as a feed row: names nested under what they name. */
function toDeploymentRow(row: FeedQueryRow): EnvironmentDeploymentRow {
  // The six names are destructured to keep them OUT of `...record`: dropping
  // any of them from this list silently puts a flat duplicate back on the wire
  // beside the nested one, which is the bug this shape exists to prevent. Each
  // is then read below, under whatever it names — the shared `ownerOf` takes
  // the owner names as an argument, so none of them is a binding that
  // exists only to be discarded.
  const {
    svcType,
    svcId,
    svcName,
    scheduleName,
    volumeBackupName,
    backupName,
    ...record
  } = row;
  return {
    ...record,
    owner: ownerOf(record, {
      serviceName: svcName,
      scheduleName,
      volumeBackupName,
      backupName,
      // This feed lists Services' runs only: an Environment network's own
      // runs are on its card, which the inner join below leaves out.
      networkRegion: null,
    }),
    service: { serviceType: svcType, serviceId: svcId, name: svcName },
  };
}

/**
 * Every domain answered by a service in one Environment, by host.
 *
 * The same relation the deployment feed joins, against the three FKs a
 * `domain` row can carry, a Server bucket's among them. A managed database has
 * no domains at all — nothing routes to one from outside — so those services
 * simply contribute no rows, which is why this needs no service-type filter of
 * its own.
 */
export async function listEnvironmentDomains(
  db: DrizzleDB,
  environmentId: string,
  accessedServices: string[] | null,
): Promise<EnvironmentDomainRow[]> {
  const service = environmentServices(db);

  const conditions: SQL[] = [eq(service.environmentId, environmentId)];
  if (accessedServices) {
    conditions.push(inArray(sql`${service.serviceId}`, accessedServices));
  }

  const found = await db
    .select({
      ...getTableColumns(domain),
      // `svc*` rather than `serviceName` and friends: a `domain` row has its own
      // `serviceName` — the Compose service the host routes into — and naming
      // the joined service the same thing meant destructuring the join key out
      // of the row also took the domain's column with it, silently. tsc caught
      // it; the assertions on this feed had not.
      svcType: sql<ServiceType>`${service.serviceType}`,
      svcId: sql<string>`${service.serviceId}`,
      svcName: sql<string>`${service.name}`,
    })
    .from(domain)
    .innerJoin(
      service,
      eq(
        service.serviceId,
        sql`coalesce(${domain.applicationId}, ${domain.composeId}, ${domain.bucketId})`,
      ),
    )
    .where(and(...conditions))
    .orderBy(domain.host, domain.path, domain.domainId);

  return found.map(({ svcType, svcId, svcName, ...record }) => ({
    ...record,
    service: { serviceType: svcType, serviceId: svcId, name: svcName },
  }));
}
