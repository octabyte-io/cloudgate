import { Controller, ForbiddenException, Get, Query } from '@nestjs/common';
import type { AuthSession } from '../auth/auth.config';
import type { ValidatedRequest } from '../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import type { PermissionCtx } from '../rbac/permission.service';
import { TraefikConfigStatusQueryDto } from './dto/traefik.dto';
import { TraefikService } from './traefik.service';

type Session = NonNullable<ValidatedRequest['session']>;

/** The caller's permission ctx in the session's active organization. */
function toCtx(user: AuthSession['user'], session: Session): PermissionCtx {
  if (!session.activeOrganizationId) {
    throw new ForbiddenException('No active organization');
  }
  return {
    user: { id: user.id },
    session: { activeOrganizationId: session.activeOrganizationId },
  };
}

/**
 * Traefik's verdict on the configuration Cloudgate wrote (H-38).
 *
 * `service:read` and the same row-level access a Domain or Redirect read takes,
 * because it says the same things about the same rows. Deliberately not under
 * `/settings/traefik/*`: that surface is `traefikFiles`-permissioned and is the
 * *instance's* Traefik installation — one file, one operator. This is one
 * Application's config, and a member entitled to that Application is exactly
 * who needs to know their Domain has stopped routing.
 */
@Controller('traefik')
export class TraefikController {
  constructor(private readonly traefikService: TraefikService) {}

  @Get('config-status')
  @RequirePermission('service', 'read')
  configStatus(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: TraefikConfigStatusQueryDto,
  ) {
    return this.traefikService.configStatus(
      toCtx(user, session),
      query.applicationId,
    );
  }

  /**
   * Traefik's verdict on the console's own routers (H-61).
   *
   * No `@RequirePermission`: the two files behind it are instance-wide, so the
   * gate is `checkInstanceAuthority` in the service — the same question
   * `settings.controller.ts` asks before it lets anyone *write* them. A
   * decorator naming an organization-scoped resource would be the wrong
   * question asked convincingly.
   */
  @Get('config-status/console')
  consoleConfigStatus(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.traefikService.consoleConfigStatus(toCtx(user, session));
  }
}
