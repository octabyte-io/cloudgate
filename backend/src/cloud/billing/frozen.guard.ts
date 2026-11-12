import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from '../../auth/auth.guard';
import { ALLOWED_WHEN_FROZEN_KEY } from './allowed-when-frozen.decorator';
import { FrozenOrganizations } from './frozen-organizations.service';

/** The methods that can change something. A `GET` (live logs included) never is. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Refuses every write to a Frozen Organization (ADR-0052), except the
 * routes marked `@AllowedWhenFrozen` — paying, removing, disconnecting a
 * Cloud account, deleting the Organization, and the caller's own account.
 *
 * Registered as an APP_GUARD by BillingModule, which AppModule imports after
 * AuthModule and RbacModule, so it runs after `AuthGuard` has put the session
 * on the request: the Organization is the session's active one, and a request
 * with no session (`@Public()` routes, webhooks) is not an Organization's
 * write. The MCP endpoint is `@Public()` and authenticates its own Agent key,
 * so its write tools ask the same question in `McpDispatcher`. Reads are never
 * refused, and on a Self-hosted instance nothing is.
 */
@Injectable()
export class FrozenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly frozen: FrozenOrganizations,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!MUTATING_METHODS.has(request.method)) return true;
    const organizationId = request.session?.activeOrganizationId;
    if (!organizationId) return true;
    const carveOut = this.reflector.getAllAndOverride<string | undefined>(
      ALLOWED_WHEN_FROZEN_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (carveOut) return true;
    await this.frozen.assertNotFrozen(organizationId);
    return true;
  }
}
