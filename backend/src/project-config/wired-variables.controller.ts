import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Put,
} from '@nestjs/common';

import type { AuthSession } from '../auth/auth.config';
import type { ValidatedRequest } from '../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import type { PermissionCtx } from '../rbac/permission.service';
import { SaveLinksDto } from './dto/wired-variables.dto';
import { WiredVariablesService } from './wired-variables.service';

type Session = NonNullable<ValidatedRequest['session']>;

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
 * A Service's **wired variables** (ADR-0031), for an Application, a
 * postgres, a mysql or a redis: its links without a value, the sources and
 * Outputs a link may name, and the console Save that sets them.
 */
@Controller('services')
export class WiredVariablesController {
  constructor(private readonly wired: WiredVariablesService) {}

  @Get(':serviceType/:serviceId/links')
  @RequirePermission('service', 'read')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('serviceType') serviceType: string,
    @Param('serviceId') serviceId: string,
  ) {
    return this.wired.findOne(toCtx(user, session), serviceType, serviceId);
  }

  /**
   * Sets the whole set of links, as a console Save of a Cloudgate-kept
   * config. `PROJECT_CONFIG_REPOSITORY_KEPT` (409, with a pointer) on a
   * repository-kept one, `LINK_NEEDS_PROJECT_CONFIG` where there is none,
   * `LINK_REFUSED` for a link its plan would refuse.
   */
  @Put(':serviceType/:serviceId/links')
  @RequirePermission('service', 'update')
  update(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('serviceType') serviceType: string,
    @Param('serviceId') serviceId: string,
    @Body() body: SaveLinksDto,
  ) {
    return this.wired.update(
      toCtx(user, session),
      serviceType,
      serviceId,
      body.links,
    );
  }
}
