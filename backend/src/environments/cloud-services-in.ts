import { and, asc, eq, isNotNull } from 'drizzle-orm';

import { application } from '../applications/application.schema';
import { compose } from '../compose/compose.schema';
import { mysql } from '../databases/mysql/mysql.schema';
import { postgres } from '../databases/postgres/postgres.schema';
import { redis } from '../databases/redis/redis.schema';
import type { DrizzleDB } from '../db/drizzle.module';

/** A Service of an Environment that runs in a Cloud account, and where. */
export interface CloudServicePlace {
  readonly name: string;
  readonly serviceType:
    'application' | 'postgres' | 'mysql' | 'redis' | 'compose';
  readonly cloudAccountId: string;
  readonly region: string;
}

/**
 * Every Service of the Environment that runs in a Cloud account (ADR-0035)
 * — a cloud `web`, being deleted or Delete incomplete included, and a
 * postgres or a mysql on RDS and a redis on ElastiCache — by name. What keeps
 * an Environment network from being removed: AWS will not delete a VPC whose
 * subnets or security groups one of them still holds.
 */
export async function cloudServicesIn(
  db: DrizzleDB,
  environmentId: string,
): Promise<CloudServicePlace[]> {
  const place = <
    T extends { cloudAccountId: string | null; region: string | null },
  >(
    rows: T[],
  ) =>
    rows.flatMap((row) =>
      row.cloudAccountId !== null && row.region !== null
        ? [{ ...row, cloudAccountId: row.cloudAccountId, region: row.region }]
        : [],
    );
  const applications = await db
    .select({
      name: application.name,
      cloudAccountId: application.cloudAccountId,
      region: application.region,
    })
    .from(application)
    .where(
      and(
        eq(application.environmentId, environmentId),
        isNotNull(application.cloudAccountId),
      ),
    )
    .orderBy(asc(application.name));
  const databases = await db
    .select({
      name: postgres.name,
      cloudAccountId: postgres.cloudAccountId,
      region: postgres.region,
    })
    .from(postgres)
    .where(
      and(
        eq(postgres.environmentId, environmentId),
        isNotNull(postgres.cloudAccountId),
      ),
    )
    .orderBy(asc(postgres.name));
  const mysqls = await db
    .select({
      name: mysql.name,
      cloudAccountId: mysql.cloudAccountId,
      region: mysql.region,
    })
    .from(mysql)
    .where(
      and(
        eq(mysql.environmentId, environmentId),
        isNotNull(mysql.cloudAccountId),
      ),
    )
    .orderBy(asc(mysql.name));
  const caches = await db
    .select({
      name: redis.name,
      cloudAccountId: redis.cloudAccountId,
      region: redis.region,
    })
    .from(redis)
    .where(
      and(
        eq(redis.environmentId, environmentId),
        isNotNull(redis.cloudAccountId),
      ),
    )
    .orderBy(asc(redis.name));
  // A Compose stack on its own Stack VM there (ADR-0070).
  const stacks = await db
    .select({
      name: compose.name,
      cloudAccountId: compose.cloudAccountId,
      region: compose.region,
    })
    .from(compose)
    .where(
      and(
        eq(compose.environmentId, environmentId),
        isNotNull(compose.cloudAccountId),
      ),
    )
    .orderBy(asc(compose.name));
  return [
    ...place(applications).map((row) => ({
      ...row,
      serviceType: 'application' as const,
    })),
    ...place(databases).map((row) => ({
      ...row,
      serviceType: 'postgres' as const,
    })),
    ...place(mysqls).map((row) => ({
      ...row,
      serviceType: 'mysql' as const,
    })),
    ...place(caches).map((row) => ({
      ...row,
      serviceType: 'redis' as const,
    })),
    ...place(stacks).map((row) => ({
      ...row,
      serviceType: 'compose' as const,
    })),
  ];
}
