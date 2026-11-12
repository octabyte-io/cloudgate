import { ConflictException } from '@nestjs/common';
import { and, eq, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';

import { application } from '../../applications/application.schema';
import { bucket } from '../../buckets/bucket.schema';
import { mysql } from '../../databases/mysql/mysql.schema';
import { existingDatabase } from '../../databases/postgres/existing-database.schema';
import { postgres } from '../../databases/postgres/postgres.schema';
import { redis } from '../../databases/redis/redis.schema';
import type { DrizzleDB } from '../../db/drizzle.module';
import type { ConfigLinks } from '../project-config.types';

/** The refusal code for a Delete of a source a Service still links to. */
export const SERVICE_IS_LINKED_CODE = 'SERVICE_IS_LINKED';

/** The Service tables whose rows can hold applied links. */
const LINKING = [
  {
    table: application,
    id: application.applicationId,
    environmentId: application.environmentId,
    configName: application.configName,
    name: application.name,
    configLinks: application.configLinks,
    wiredChangedAt: application.wiredChangedAt,
    cloudDelete: application.cloudDelete,
  },
  {
    table: postgres,
    id: postgres.postgresId,
    environmentId: postgres.environmentId,
    configName: postgres.configName,
    name: postgres.name,
    configLinks: postgres.configLinks,
    wiredChangedAt: postgres.wiredChangedAt,
    cloudDelete: postgres.cloudDelete,
  },
  {
    table: mysql,
    id: mysql.mysqlId,
    environmentId: mysql.environmentId,
    configName: mysql.configName,
    name: mysql.name,
    configLinks: mysql.configLinks,
    wiredChangedAt: mysql.wiredChangedAt,
    cloudDelete: mysql.cloudDelete,
  },
  {
    table: redis,
    id: redis.redisId,
    environmentId: redis.environmentId,
    configName: redis.configName,
    name: redis.name,
    configLinks: redis.configLinks,
    wiredChangedAt: redis.wiredChangedAt,
    cloudDelete: redis.cloudDelete,
  },
] as const satisfies readonly {
  table: PgTable;
  id: AnyPgColumn;
  environmentId: AnyPgColumn;
  configName: AnyPgColumn;
  name: AnyPgColumn;
  configLinks: AnyPgColumn;
  wiredChangedAt: AnyPgColumn;
  cloudDelete: AnyPgColumn;
}[];

type Db = Pick<DrizzleDB, 'select' | 'update'>;

/** A row whose applied links name `source`, for one of `outputs` when given. */
function linksTo(
  configLinks: AnyPgColumn,
  source: string,
  outputs?: readonly string[],
) {
  const output =
    outputs === undefined
      ? sql``
      : sql` and link.value->>'output' in (${sql.join(
          outputs.map((name) => sql`${name}`),
          sql`, `,
        )})`;
  return sql`exists (select 1 from jsonb_each(${configLinks}) as link where link.value->>'source' = ${source}${output})`;
}

/**
 * Refuses deleting a source while a Service of its Environment links to it
 * (ADR-0031): the link would fail that Service's next deploy. The
 * sentence names each link. A plan that moves or drops links runs that
 * step before its destroy; a plan that removes the linking Service only
 * asks for its Delete there, and in a Cloud account that Delete is a
 * destroy-only Cloud run whose row, links and all, stays until it ends.
 *
 * So a link held by a Service whose cloud Delete is under way — its record
 * `deleting` or `incomplete` (ADR-0038) — does not count: that
 * Service has no next deploy, since ADR-0038 refuses Deploy and Start on
 * it. It reads row state, not a plan, so it holds for a plan removing a
 * database and its linking Service together, applied while the Service's
 * run is still queued, and for the console's Delete of the database then.
 * Nothing waits for that run, and nothing need: no Service's state names a
 * database's resources on either cloud — on AWS a database's security
 * group admits the network's address ranges, not a Service's group; on
 * Google Cloud its endpoints are in its own state and its firewall rule in
 * the network's — so the database's own destroy-only run may end first.
 */
export async function refuseWhileLinked(
  db: Db,
  source: { environmentId: string; configName: string },
): Promise<void> {
  const links: string[] = [];
  for (const one of LINKING) {
    const rows = (await db
      .select({
        configName: one.configName,
        links: one.configLinks,
        cloudDelete: one.cloudDelete,
      })
      .from(one.table)
      .where(
        and(
          eq(one.environmentId, source.environmentId),
          linksTo(one.configLinks, source.configName),
        ),
      )) as {
      configName: string;
      links: ConfigLinks;
      cloudDelete: object | null;
    }[];
    for (const row of rows) {
      if (row.cloudDelete) continue;
      for (const [variable, link] of Object.entries(row.links)) {
        if (link.source !== source.configName) continue;
        links.push(
          `${row.configName}.env.${variable} → ${link.source}.${link.output}`,
        );
      }
    }
  }
  if (links.length === 0) return;
  throw new ConflictException({
    message: `${source.configName} cannot be deleted while a Service links to it (${links.join(', ')}); remove the link from the Project config and apply it first`,
    code: SERVICE_IS_LINKED_CODE,
  });
}

/**
 * Marks every Service of the Environment that links to one of `outputs` of
 * `source`: its Output changed outside a plan, so it reads "deploy
 * to pick up the new value" until a deploy builds its variables again.
 * Nothing is deployed.
 */
export async function markWiredChanged(
  db: Db,
  source: { environmentId: string; configName: string },
  outputs: readonly string[],
): Promise<void> {
  if (outputs.length === 0) return;
  const at = new Date().toISOString();
  for (const one of LINKING) {
    await db
      .update(one.table)
      .set({ wiredChangedAt: at })
      .where(
        and(
          eq(one.environmentId, source.environmentId),
          linksTo(one.configLinks, source.configName, outputs),
        ),
      );
  }
}

/**
 * Every Service of the Environment whose applied links name one of
 * `outputs` of `source`: what an action changing those Outputs
 * redeploys, so each picks up the new value. Ordered by Config name.
 */
export async function servicesLinking(
  db: Db,
  source: { environmentId: string; configName: string },
  outputs: readonly string[],
): Promise<
  {
    serviceType: LinkingType;
    serviceId: string;
    configName: string;
    name: string;
  }[]
> {
  if (outputs.length === 0) return [];
  const found: {
    serviceType: LinkingType;
    serviceId: string;
    configName: string;
    name: string;
  }[] = [];
  for (const [at, one] of LINKING.entries()) {
    const rows = (await db
      .select({ serviceId: one.id, configName: one.configName, name: one.name })
      .from(one.table)
      .where(
        and(
          eq(one.environmentId, source.environmentId),
          linksTo(one.configLinks, source.configName, outputs),
        ),
      )) as { serviceId: string; configName: string; name: string }[];
    for (const row of rows) {
      found.push({ serviceType: LINKING_TYPES[at], ...row });
    }
  }
  return found.sort((a, b) => a.configName.localeCompare(b.configName));
}

/**
 * Marks these Services as {@link markWiredChanged} marks those linking an
 * Output: each runs with a value that is no longer the source's, so
 * it reads "deploy to pick up the new value" until a deploy builds its
 * variables again. A Rotate key whose put-back of one failed marks it.
 */
export async function markServicesWiredChanged(
  db: Db,
  services: readonly { serviceType: LinkingType; serviceId: string }[],
): Promise<void> {
  const at = new Date().toISOString();
  for (const service of services) {
    const one = LINKING[LINKING_TYPES.indexOf(service.serviceType)];
    await db
      .update(one.table)
      .set({ wiredChangedAt: at })
      .where(eq(one.id, service.serviceId));
  }
}

/**
 * Those of `services` still marked, as {@link markServicesWiredChanged}
 * marks them, so not yet deployed since; a deleted one is gone and
 * not among them.
 */
export async function servicesStillWiredChanged<
  T extends { serviceType: LinkingType; serviceId: string },
>(db: Pick<DrizzleDB, 'select'>, services: readonly T[]): Promise<T[]> {
  const still: T[] = [];
  for (const service of services) {
    const one = LINKING[LINKING_TYPES.indexOf(service.serviceType)];
    const [row] = (await db
      .select({ at: one.wiredChangedAt })
      .from(one.table)
      .where(eq(one.id, service.serviceId))) as { at: string | null }[];
    if (row?.at) still.push(service);
  }
  return still;
}

/**
 * Clears a Service's notice once a deploy built its wired variables at
 * `builtAt`: a change marked after that build stays marked.
 */
export async function clearWiredChanged(
  db: Db,
  service: { serviceType: LinkingType; serviceId: string },
  builtAt: string,
): Promise<void> {
  const one = LINKING[LINKING_TYPES.indexOf(service.serviceType)];
  await db
    .update(one.table)
    .set({ wiredChangedAt: null })
    .where(
      and(
        eq(one.id, service.serviceId),
        isNotNull(one.wiredChangedAt),
        lte(one.wiredChangedAt, builtAt),
      ),
    );
}

const LINKING_TYPES = ['application', 'postgres', 'mysql', 'redis'] as const;

/** A Service type whose rows hold applied links. */
export type LinkingType = (typeof LINKING_TYPES)[number];

export function isLinkingType(serviceType: string): serviceType is LinkingType {
  return (LINKING_TYPES as readonly string[]).includes(serviceType);
}

/**
 * The Cloud run states a cloud Service's deploy waits for: each
 * source its applied links name that is made by a Cloud run of its own —
 * a postgres on RDS, `postgres:<id>`, a mysql on RDS, `mysql:<id>`,
 * a redis on ElastiCache,
 * `redis:<id>` — an existing Valkey's endpoints' run too —
 * or a bucket on S3, `bucket:<id>`. The Cloud
 * run pool holds the deploy's run back while a run of one of them is queued
 * or running, so within one Apply a source's create (10–15 minutes for RDS)
 * ends before the Service that links to it reads its address, and a bucket
 * exists before the task its role reaches it from starts. Empty for a
 * Service with no links, or whose sources run on a Server.
 */
export async function linkSourceStates(
  db: Pick<DrizzleDB, 'select'>,
  applicationId: string,
): Promise<string[]> {
  const [found] = await db
    .select({
      environmentId: application.environmentId,
      links: application.configLinks,
    })
    .from(application)
    .where(eq(application.applicationId, applicationId));
  const sources = [
    ...new Set(Object.values(found?.links ?? {}).map((link) => link.source)),
  ];
  if (!found || sources.length === 0) return [];
  const onRds = await db
    .select({ postgresId: postgres.postgresId })
    .from(postgres)
    .where(
      and(
        eq(postgres.environmentId, found.environmentId),
        inArray(postgres.configName, sources),
        isNotNull(postgres.cloudAccountId),
      ),
    );
  const mysqls = await db
    .select({ mysqlId: mysql.mysqlId })
    .from(mysql)
    .where(
      and(
        eq(mysql.environmentId, found.environmentId),
        inArray(mysql.configName, sources),
        isNotNull(mysql.cloudAccountId),
      ),
    );
  // An existing Valkey too: its address is its primary endpoint's,
  // which its endpoints' run makes. One on AWS has no run to wait for.
  const caches = await db
    .select({ redisId: redis.redisId })
    .from(redis)
    .leftJoin(existingDatabase, eq(existingDatabase.redisId, redis.redisId))
    .where(
      and(
        eq(redis.environmentId, found.environmentId),
        inArray(redis.configName, sources),
        or(
          isNotNull(redis.cloudAccountId),
          isNotNull(existingDatabase.existingDatabaseId),
        ),
      ),
    );
  const onS3 = await db
    .select({ bucketId: bucket.bucketId })
    .from(bucket)
    .where(
      and(
        eq(bucket.environmentId, found.environmentId),
        inArray(bucket.configName, sources),
        isNotNull(bucket.cloudAccountId),
      ),
    );
  return [
    ...onRds.map((row) => `postgres:${row.postgresId}`),
    ...mysqls.map((row) => `mysql:${row.mysqlId}`),
    ...caches.map((row) => `redis:${row.redisId}`),
    ...onS3.map((row) => `bucket:${row.bucketId}`),
  ].sort();
}
