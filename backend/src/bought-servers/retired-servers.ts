import { and, eq, inArray, notExists } from 'drizzle-orm';
import type { AnyColumn, SQL } from 'drizzle-orm';
import type { DrizzleDB } from '../db/drizzle.module';
import { boughtServer } from './bought-server.schema';
import type { BoughtServerStage } from './bought-server.schema';

/**
 * **A Server Cloudgate no longer reaches** (spec #1387, story 76): one whose
 * Bought Server is Deleting or Deleted. From the moment Delete starts, its
 * machine may be gone and its address handed to another of the provider's
 * customers, so nothing connects to it and no loop over every Server sends
 * it anything. A `server` row outlives this only as a record (a Bought
 * Server deleted for non-payment keeps its Services listed, #1397).
 *
 * Plain functions over the table, like `paying-organization.ts`: the
 * connection seam, monitoring, the access log, cleanup and the request
 * metrics all ask, and none of them may import the Bought Servers module.
 * Self-hosted there is no `bought_server` row, so every answer is "reached".
 */
export const RETIRED_STAGES: readonly BoughtServerStage[] = [
  'deleting',
  'deleted',
];

/** Whether the stage is one Cloudgate never connects at. */
export function isRetiredStage(stage: BoughtServerStage | null): boolean {
  return stage !== null && RETIRED_STAGES.includes(stage);
}

/** Whether this Server's Bought Server is Deleting or Deleted. */
export async function isRetiredServer(
  db: DrizzleDB,
  serverId: string,
): Promise<boolean> {
  const [found] = await db
    .select({ id: boughtServer.id })
    .from(boughtServer)
    .where(
      and(
        eq(boughtServer.serverId, serverId),
        inArray(boughtServer.stage, [...RETIRED_STAGES]),
      ),
    )
    .limit(1);
  return found !== undefined;
}

/**
 * A `where` condition for a read of every Server: only the ones still
 * reached. `serverIdColumn` is the `server_id` of the rows being read.
 */
export function notRetired(db: DrizzleDB, serverIdColumn: AnyColumn): SQL {
  return notExists(
    db
      .select({ id: boughtServer.id })
      .from(boughtServer)
      .where(
        and(
          eq(boughtServer.serverId, serverIdColumn),
          inArray(boughtServer.stage, [...RETIRED_STAGES]),
        ),
      ),
  );
}
