import { NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { DrizzleDB } from '../db/drizzle.module';
import type { PermissionCtx } from '../rbac/permission.service';
import { server } from '../servers/server.schema';
import type { Server } from '../servers/server.schema';

/**
 * The one org-scoped Server lookup: a `serverId` a caller supplied must name a
 * server in the caller's active organization before anything runs on it.
 *
 * There were five of these. Four were private `findOwnedServer` methods —
 * destinations, backups and scheduling returning `Promise<void>`, monitoring
 * returning the row because its callers use it — and the fifth was the exported
 * `checkServerAccess` in `docker-ops/server-access.ts` that docker-ops, swarm,
 * cluster and roughly a dozen settings routes share. All five ran the same
 * `serverId = ? AND organizationId = ?` select and raised the same
 * `NotFoundException('Server not found')`; what differed was only how much of
 * the row they projected. So this one keeps `checkServerAccess`'s optional-id
 * signature and monitoring's full-row return, which is the widest of the five
 * and source-compatible with the narrowest — `{ serverId, ipAddress }` is a
 * subset of `Server`.
 *
 * **The name is deliberate, and load-bearing.** ADR-0008's second consequence
 * and ADR-0010's third paragraph both cite `checkServerAccess` by name when they
 * record why the gateways may not simply reuse it. Renaming it on the way to a
 * new home would strand two decisions on a symbol that no longer exists.
 *
 * A plain exported function taking the injected `DrizzleDB`, not an
 * `@Injectable()` — `common/service-parent.ts`'s precedent, cited again by
 * `destinations/rclone-exec.ts` for the same reason: a provider holding no state
 * would need wiring in seven modules to answer one select. It lives in `common/`
 * rather than in either the docker-ops module that used to own it or the
 * `servers` module that owns the table, because seven modules now ask the
 * question and the settings module was already reaching across for it.
 *
 * **`docker-ops/server-access.ts` deliberately does not re-export this.** Every
 * former call site imports this file directly instead. A one-line re-export
 * would be the smaller diff and the dishonest one: it would leave `grep` saying
 * the guard still lives in docker-ops, and leave six modules importing their
 * organization check out of a module about Docker.
 *
 * **The absent-id branch is not a bug — do not "fix" it.** `!serverId` resolves
 * to `undefined` and must never throw. Per ADR-0008 "no server row to check" is
 * the contract for the platform host across the whole HTTP surface, and per
 * ADR-0010 the platform host has no `server` row to find. Making the absent case
 * throw would break the local-host branch of every docker-ops, swarm, cluster
 * and settings route at once. Call sites that require an id enforce that
 * themselves — `requireServiceId` in the scheduling service is one — rather than
 * asking this to do it for them. `test/common/owned-server.spec.ts` pins the
 * contract so a later refactor cannot quietly reverse it.
 *
 * NotFound rather than Forbidden for a cross-organization row, on the backups
 * precedent: a caller who may not see the fleet learns nothing about which ids
 * exist in it. Every swarm query runs the check too.
 */
export async function checkServerAccess(
  db: DrizzleDB,
  ctx: PermissionCtx,
  serverId?: string | null,
): Promise<Server | undefined> {
  if (!serverId) return undefined;
  const [found] = await db
    .select()
    .from(server)
    .where(
      and(
        eq(server.serverId, serverId),
        eq(server.organizationId, ctx.session.activeOrganizationId),
      ),
    )
    .limit(1);
  if (!found) throw new NotFoundException('Server not found');
  return found;
}
