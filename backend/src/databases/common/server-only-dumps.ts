import { ConflictException } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import type { DrizzleDB } from '../../db/drizzle.module';
import { mysql } from '../mysql/mysql.schema';
import { postgres } from '../postgres/postgres.schema';
import { redis } from '../redis/redis.schema';

/**
 * The `code` of a 409 refusing a dump Backup or a volume backup of a
 * database in a Cloud account, so the console and the MCP tools can
 * tell it from any other refusal (ADR-0005).
 */
export const SERVER_ONLY_DUMPS_CODE = 'SERVER_ONLY_DUMPS';

/** What a cloud database's Backups tab and the refusal both say. */
export const SERVER_ONLY_DUMPS =
  'Dump backups to a Destination are Server-only for now';

/**
 * Refuses a Backup or volume backup row for a database in a Cloud account:
 * its backups are the provider's own (RDS's automated
 * backups and snapshots, ElastiCache's snapshots), read on its Backups tab,
 * and Cloudgate has no container to run a dump or a tar in. A Destination
 * belongs to the Organization and names no database, so refusing the row
 * that links one to a cloud database is the whole of "no Destination for
 * it". An Existing database is refused before this, by
 * `refuseExistingDatabaseBackup`, with its own code.
 *
 * Only `postgres`, `mysql` and `redis` have a cloud place; every
 * other engine passes.
 */
export async function refuseCloudDatabaseDump(
  db: DrizzleDB,
  serviceType: string,
  serviceId: string,
): Promise<void> {
  let found: { name: string; cloudAccountId: string | null } | undefined;
  if (serviceType === 'postgres') {
    [found] = await db
      .select({
        name: postgres.name,
        cloudAccountId: postgres.cloudAccountId,
      })
      .from(postgres)
      .where(eq(postgres.postgresId, serviceId));
  } else if (serviceType === 'mysql') {
    [found] = await db
      .select({ name: mysql.name, cloudAccountId: mysql.cloudAccountId })
      .from(mysql)
      .where(eq(mysql.mysqlId, serviceId));
  } else if (serviceType === 'redis') {
    [found] = await db
      .select({ name: redis.name, cloudAccountId: redis.cloudAccountId })
      .from(redis)
      .where(eq(redis.redisId, serviceId));
  }
  if (!found?.cloudAccountId) return;
  throw new ConflictException({
    message: `${found.name} runs in a Cloud account, whose backups are its provider's own, on its Backups tab. ${SERVER_ONLY_DUMPS}`,
    code: SERVER_ONLY_DUMPS_CODE,
  });
}
