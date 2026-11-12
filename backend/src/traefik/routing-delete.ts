import { HttpException } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import type { UnreclaimedArtifact } from '../common/teardown-steps';
import { routeKeptRefusal } from '../common/workload-kept-refusal';
import type { DrizzleDB } from '../db/drizzle.module';
import { server } from '../db/schema';
import { HOST_UNREACHABLE_CODE } from '../docker-ops/host-reachability';
import type { DrizzleTx } from '../environments/config-name';
import { dynamicTraefikConfigPath } from './traefik-writer.service';

/** The file a routing delete rewrites, and what its refusal calls the row. */
export interface RoutingDeleteTarget {
  /** The owner's `appName`, which a report entry is named by. */
  appName: string;
  /** The file's name under `dynamic/`: `appName`, or a stack's `compose+…`. */
  configName: string;
  serverId: string | null;
  /** The row being deleted, as the refusal names it: `Domain`, `redirect`… */
  noun: string;
}

/**
 * The rewrite of a Server's Traefik file that a Domain, redirect or basic-auth
 * user Delete runs inside its own transaction, answered the way an Application
 * Delete answers a Server it could not reach (#1417).
 *
 * `rewrite` is `TraefikAppConfigService`'s, which answers a Server it never
 * reached with the 503 `HOST_UNREACHABLE` every route gives. On a delete that
 * is the wrong answer twice over: it does not say which Server, and it has no
 * way out, so a row on a Server that is gone for good could never be deleted.
 * So here, and only for a delete — a create or an edit keeps the 503, with
 * nothing to force:
 *
 * - **without `force`**, the 409 `ROUTE_REMOVAL_UNREACHABLE`, in
 *   `workloadKeptRefusal`'s body shape, naming the Server and offering
 *   `?force=true`. Thrown inside the caller's transaction, so the delete rolls
 *   back and the row is kept (ADR-0068's shape).
 * - **with `force`**, the rewrite is let go and the router left in the file is
 *   answered as a `'traefik-config'` entry for `unreclaimedArtifacts`, which is
 *   how the Application Delete's force reports the file it could not remove
 *   (ADR-0018). The delete commits.
 *
 * A write that reached the Server and failed there, or the platform host not
 * answering, propagates as it was: neither is a Server that may be gone.
 *
 * The Server's name is read through `db`, the caller's transaction, after the
 * row it names has been checked for access by the caller's own route.
 */
export async function rewriteRoutingForDelete(
  db: DrizzleDB | DrizzleTx,
  target: RoutingDeleteTarget,
  force: boolean,
  rewrite: () => Promise<void>,
): Promise<UnreclaimedArtifact[]> {
  try {
    await rewrite();
    return [];
  } catch (error) {
    if (!target.serverId || !isServerUnreachable(error)) throw error;
    if (force) {
      return [
        {
          kind: 'traefik-config',
          appName: target.appName,
          serverId: target.serverId,
          path: dynamicTraefikConfigPath(target.configName, target.serverId),
        },
      ];
    }
    const [row] = await db
      .select({ name: server.name })
      .from(server)
      .where(eq(server.serverId, target.serverId));
    const named = row ? `Server ${row.name}` : 'Its Server';
    throw routeKeptRefusal(
      `${named} could not be reached to take this ${target.noun} out of its Traefik file, so the ${target.noun} was kept and still routes there — delete again when the Server is reachable, or delete with ?force=true to remove it here and leave its router in that file`,
    );
  }
}

/** Whether `error` is the 503 `HOST_UNREACHABLE` the routing writer throws. */
function isServerUnreachable(error: unknown): boolean {
  if (!(error instanceof HttpException) || error.getStatus() !== 503) {
    return false;
  }
  const body = error.getResponse();
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { code?: unknown }).code === HOST_UNREACHABLE_CODE
  );
}
