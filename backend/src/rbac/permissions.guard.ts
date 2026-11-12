import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { REQUIRE_PERMISSION_KEY } from './decorators/require-permission.decorator';
import { PermissionService } from './permission.service';
import type { Permissions } from './permission.service';

/**
 * Global guard (registered as APP_GUARD in RbacModule, after AuthGuard):
 * enforces @RequirePermission metadata against the caller's role in the
 * active organization. Routes without the metadata pass through.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissionService: PermissionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Permissions | undefined>(
      REQUIRE_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    // The fail-open, and it is deliberate — read
    // `test/coding-standards/route-permissions.spec.ts` before changing it.
    //
    // Making this line fail closed is the obvious fix and it is wrong: 113 of
    // the 307 mutating handlers in `src` carry no decorator on purpose and are
    // gated in the service layer instead — on `requireInstanceAuthority`, on
    // `ensureEnterprise`, on a webhook signature, on "acts on the caller's own
    // record" — so closing this would refuse a third of the product's writes.
    // The contract in the docblock above is what those handlers rely on.
    //
    // What the `service: update` change did instead was make the pass-through
    // *documented*: that spec walks every controller, collects every
    // undecorated mutating handler, and holds it against a checked-in list in
    // which each entry names the gate that actually protects it. A new ungated
    // route goes red there and has to be written down on purpose. One handler
    // in that list has no gate at all; the spec freezes that count so a second
    // cannot arrive quietly. It was four until the two AI probes and the
    // template preview were gated — the spec's own docblock argues why each
    // departure counted.
    if (!required) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const { user, session } = request;
    if (!user || !session?.activeOrganizationId) {
      throw new ForbiddenException('No active organization');
    }

    await this.permissionService.checkPermission(
      {
        user: { id: user.id },
        session: { activeOrganizationId: session.activeOrganizationId },
      },
      required,
    );
    return true;
  }
}
