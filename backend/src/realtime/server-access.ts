import { ForbiddenException } from '@nestjs/common';
import type { Logger } from '@nestjs/common';
import { PermissionService } from '../rbac/permission.service';
import { ServersService } from '../servers/servers.service';
import { callerOf } from './socket-access';
import type { WsAuthContext } from './ws-auth.guard';

/**
 * Resolves a serverId for a WebSocket caller, org-scoped, and refuses by
 * throwing.
 *
 * The form a socket **renewing its authorization** needs (ADR-0012): a lease
 * ends on a refusal and stands through a failure, so it has to be able to tell
 * "this Server is not the caller's" from "the database could not be asked".
 * `servers.findOne` already draws that line — an unknown or unowned id is an
 * `HttpException`, a dead pool is not — and this keeps it drawn rather than
 * collapsing both into an absent answer.
 */
export async function authorizedServerOrThrow(
  servers: ServersService,
  auth: WsAuthContext,
  serverId: string,
) {
  const organizationId = auth.session.activeOrganizationId;
  if (!organizationId) {
    throw new ForbiddenException('No active organization');
  }
  return servers.findOne(
    {
      user: { id: auth.user.id },
      session: { activeOrganizationId: organizationId },
    },
    serverId,
  );
}

/**
 * The same lookup, answering null instead of throwing. The org-scoped lookup
 * collapses an organization mismatch and an unknown id into the same null →
 * silent close, so a socket never says "Server not found" for an id it would
 * not show the caller (docker-ops precedent).
 *
 * The collapse takes *every* failure with it, including a database that could
 * not answer, and that is right for a connection handler: nothing is streaming
 * yet, so an unanswerable question and a refused one both end in the same
 * silent close. It is wrong for a renewal, which is why the throwing form above
 * exists and is what the leases call.
 *
 * **`journal` is required, and that is the point.** All four gateways
 * that call this closed on this branch without writing a line, while the
 * *entitlement* refusal twenty lines further down in `/terminal` logged one — so
 * an operator asked "why did this id not work" had a journal that distinguished
 * the two exits by absence. Putting the line inside the function rather than at
 * the four call sites is what stops a fifth gateway forgetting it, the same
 * argument `socket-access.ts` makes for `denyConnection` taking its caller as a
 * parameter; making the parameter required is what makes the compiler find every
 * call site.
 */
export async function findAuthorizedServer(
  servers: ServersService,
  auth: WsAuthContext,
  serverId: string,
  journal: { logger: Logger; subject: string },
) {
  try {
    return await authorizedServerOrThrow(servers, auth, serverId);
  } catch {
    // Silent and codeless on the wire (ADR-0008) — an id that is not the
    // caller's and an id that does not exist stay byte-identical, or the socket
    // enumerates another organization's Servers. The operator's copy lives here.
    //
    // "did not resolve" rather than "does not exist": this `catch` also swallows
    // a database that could not answer, per the docstring above, and a journal
    // line claiming more than the code knows is worse than no line at all.
    journal.logger.warn(
      `Refused socket: ${journal.subject} serverId did not resolve in this organization for ${callerOf(
        auth,
      )}`,
    );
    return null;
  }
}

/**
 * That the caller can still reach this Server *and* still holds the entitlement
 * its own HTTP route asks for — `server:read` for `GET /servers/:id`,
 * `server:create` for `POST /servers/:id/setup`. Nest guards never run for a raw
 * ws upgrade, so the two sockets that need those statements ask for them by
 * hand, and they asked in two hand-assembled copies of one question.
 *
 * The permission context is built from the **Server's** organization rather than
 * the session's, which is why `permissionCtxOrDeny` cannot build it: the row was
 * resolved org-scoped already, and this is the check that the caller's standing
 * *in that organization* still admits the action.
 *
 * Throws throughout, and that is what makes it usable twice: a connection
 * handler turns the throw into its own frame — ADR-0010's `4403`,
 * `server-setup`'s `SETUP_CLOSE.forbidden`, or a silent close — while an
 * authorization lease turns the very same throw into `4010` (ADR-0012). It also
 * re-resolves the Server on every call rather than taking one already resolved,
 * because a renewal has to see a Server deleted or moved to another
 * Organization under a shell that is sitting at a prompt.
 */
export async function entitledToServerOrThrow(
  deps: { servers: ServersService; permissions: PermissionService },
  auth: WsAuthContext,
  serverId: string,
  action: 'read' | 'create',
): Promise<void> {
  const server = await authorizedServerOrThrow(deps.servers, auth, serverId);
  await deps.permissions.checkPermission(
    {
      user: { id: auth.user.id },
      session: { activeOrganizationId: server.organizationId },
    },
    { server: [action] },
  );
}
