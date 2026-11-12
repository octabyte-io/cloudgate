import { ConflictException } from '@nestjs/common';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { DrizzleDB } from '../db/drizzle.module';
import { server } from '../servers/server.schema';
import { boughtServer } from './bought-server.schema';
import { boughtServerClocksOf } from './deletion-date';
import type { BoughtServerStage } from './bought-server.schema';

/**
 * Whether a Server can be deployed to yet, as far as it is a **Bought
 * Server**: nothing is deployed to one until it is Ready (spec #1387,
 * CONTEXT.md). A Server of the customer's own has no stage and is never
 * held back here.
 *
 * Plain functions over the database rather than a service, because the
 * callers are the deploy paths of three modules that the Bought Servers
 * module must not be imported into, and the read is one indexed select.
 */

/** The code of every refusal to deploy to a Bought Server that is not Ready. */
export const BOUGHT_SERVER_NOT_READY_CODE = 'BOUGHT_SERVER_NOT_READY';

/** What the console shows of the Bought Server behind a Server row. */
export interface ServerPurchase {
  stage: BoughtServerStage;
  /**
   * An Operator's power-off for abuse (#1401), which the Server's page shows
   * as "Powered off by Cloudgate: <reason>"; null while it is not. Only an
   * Operator powers it back on.
   */
  poweredOff: { at: Date; reason: string } | null;
  /**
   * The day it is due for deletion (ADR-0071, #1397), as an ISO timestamp:
   * the red bar on a Server still in use. Null with no date, and once it is
   * Deleting or Deleted.
   */
  deletesOn: string | null;
  /** When its machine was deleted, for the Deleted record; null until then. */
  deletedAt: string | null;
}

/** The stages a deletion date shows on: the machine still exists and is the customer's. */
const DUE_STAGES: readonly BoughtServerStage[] = [
  'setting_up',
  'ready',
  'changing',
];

/**
 * Each row with `boughtServer`: the Bought Server's stage, its deletion
 * date and when it was deleted, or null for a Server of the customer's
 * own. What `GET /servers` and `GET /servers/:id` carry, so the console
 * greys a Server out, and shows the deletion bar or the Deleted record,
 * without a second call.
 */
export async function withPurchase<T extends { serverId: string }>(
  db: DrizzleDB,
  rows: T[],
): Promise<(T & { boughtServer: ServerPurchase | null })[]> {
  const ids = rows.map((row) => row.serverId);
  const bought =
    ids.length === 0
      ? []
      : await db
          .select({
            serverId: boughtServer.serverId,
            organizationId: boughtServer.organizationId,
            stage: boughtServer.stage,
            poweredOffAt: boughtServer.poweredOffAt,
            poweredOffReason: boughtServer.poweredOffReason,
            deletedAt: boughtServer.deletedAt,
          })
          .from(boughtServer)
          .where(inArray(boughtServer.serverId, ids));
  const clocks = await boughtServerClocksOf(
    db,
    bought.map((row) => row.organizationId),
  );
  const purchases = new Map(
    bought.map((row): [string | null, ServerPurchase] => {
      const deletesOn = DUE_STAGES.includes(row.stage)
        ? (clocks.get(row.organizationId)?.shownOn ?? null)
        : null;
      return [
        row.serverId,
        {
          stage: row.stage,
          poweredOff: row.poweredOffAt
            ? { at: row.poweredOffAt, reason: row.poweredOffReason ?? '' }
            : null,
          deletesOn: deletesOn?.toISOString() ?? null,
          deletedAt: row.deletedAt?.toISOString() ?? null,
        },
      ];
    }),
  );
  return rows.map((row) => ({
    ...row,
    boughtServer: purchases.get(row.serverId) ?? null,
  }));
}

/**
 * Refuses a deploy to any of these Servers that is a Bought Server not yet
 * Ready, with a 409 naming it. `null` (the platform host) and an absent id
 * are skipped, so a caller passes its run and build Server ids as they are.
 */
export async function refuseDeployUntilReady(
  db: DrizzleDB,
  serverIds: readonly (string | null | undefined)[],
): Promise<void> {
  const refusal = await deployRefusal(db, serverIds);
  if (refusal) {
    throw new ConflictException({
      code: BOUGHT_SERVER_NOT_READY_CODE,
      message: refusal,
    });
  }
}

/**
 * The sentence a deploy to these Servers is refused with, or null when none
 * of them is a Bought Server short of Ready: for the queued claim, which
 * writes it on the Deployment instead of throwing.
 */
export async function deployRefusal(
  db: DrizzleDB,
  serverIds: readonly (string | null | undefined)[],
): Promise<string | null> {
  const ids = [...new Set(serverIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return null;
  const [held] = await db
    .select({ name: server.name, stage: boughtServer.stage })
    .from(boughtServer)
    .innerJoin(server, eq(server.serverId, boughtServer.serverId))
    .where(
      and(inArray(boughtServer.serverId, ids), ne(boughtServer.stage, 'ready')),
    )
    .limit(1);
  return held ? notReadyMessage(held.name, held.stage) : null;
}

/** The refusal's words: what the Server is doing, and what to wait for. */
export function notReadyMessage(
  serverName: string,
  stage: BoughtServerStage,
): string {
  const doing =
    stage === 'changing'
      ? 'is being changed'
      : stage === 'deleting' || stage === 'deleted'
        ? 'is being deleted'
        : 'is still being set up';
  return `${serverName} ${doing}: deploy to it once it is Ready`;
}
