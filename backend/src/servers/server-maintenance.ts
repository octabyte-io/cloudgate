import { ConflictException } from '@nestjs/common';
import { and, inArray, isNotNull } from 'drizzle-orm';
import type { DrizzleDB } from '../db/drizzle.module';
import { server } from './server.schema';

/**
 * Whether new work may start on a Server, as far as its **Maintenance** goes
 * (spec #1420, CONTEXT.md): while an Owner or Admin holds it in maintenance,
 * nothing new starts a Service's containers on it, as its run Server or its
 * build Server — no deploy, redeploy, rebuild, rollback, Start or restart
 * (a Compose restart, an Application reload, a container's start or restart
 * from the Docker tab) and no Cron service's Run now — and a build queued for
 * it is refused when picked up. What already runs keeps running, and so do
 * scheduled Cron service runs, backups and Uptime checks, and Cloudgate's own
 * setup on it (Server setup, monitoring setup, Traefik reload), which are the
 * operator's maintenance tools.
 *
 * The sibling of the Bought Server not-Ready check
 * (`bought-servers/server-readiness.ts`), and plain functions over the
 * database for the same reason: the callers are the deploy paths of modules
 * the Servers module must not be imported into, and the read is one select.
 */

/** The code of every refusal of new work on a Server in maintenance. */
export const SERVER_IN_MAINTENANCE_CODE = 'SERVER_IN_MAINTENANCE';

/** The refusal's words, naming the Server. */
export function inMaintenanceMessage(serverName: string): string {
  return `${serverName} is in maintenance`;
}

/**
 * Refuses new work on any of these Servers that is in maintenance, with a
 * 409 naming it. `null` (the platform host) and an absent id are skipped, so
 * a caller passes its run and build Server ids as they are.
 */
export async function refuseWhileInMaintenance(
  db: DrizzleDB,
  serverIds: readonly (string | null | undefined)[],
): Promise<void> {
  const refusal = await maintenanceRefusal(db, serverIds);
  if (refusal) {
    throw new ConflictException({
      code: SERVER_IN_MAINTENANCE_CODE,
      message: refusal,
    });
  }
}

/**
 * The sentence new work on these Servers is refused with, or null when none
 * of them is in maintenance: for the queued claim, which writes it on the
 * Deployment instead of throwing.
 */
export async function maintenanceRefusal(
  db: DrizzleDB,
  serverIds: readonly (string | null | undefined)[],
): Promise<string | null> {
  const ids = [...new Set(serverIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return null;
  const [held] = await db
    .select({ name: server.name })
    .from(server)
    .where(
      and(inArray(server.serverId, ids), isNotNull(server.maintenanceSince)),
    )
    .limit(1);
  return held ? inMaintenanceMessage(held.name) : null;
}
