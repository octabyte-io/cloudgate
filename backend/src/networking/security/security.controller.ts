import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { AuthSession } from '../../auth/auth.config';
import type { ValidatedRequest } from '../../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../../auth/decorators/current-user.decorator';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import type { PermissionCtx } from '../../rbac/permission.service';
import {
  CreateSecurityDto,
  ListSecurityDto,
  UpdateSecurityDto,
} from './dto/security.dto';
import { SecurityService } from './security.service';

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

// Service-scoped permissions (basic-auth users have no resource of their
// own), read on queries, create on mutations — including delete.
@Controller('security')
export class SecurityController {
  constructor(private readonly securityService: SecurityService) {}

  @Post()
  @RequirePermission('service', 'create')
  create(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateSecurityDto,
  ) {
    return this.securityService.create(toCtx(user, session), body);
  }

  @Get()
  @RequirePermission('service', 'read')
  listByApplication(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ListSecurityDto,
  ) {
    return this.securityService.listByApplication(toCtx(user, session), query);
  }

  @Get(':securityId')
  @RequirePermission('service', 'read')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('securityId') securityId: string,
  ) {
    return this.securityService.findOne(toCtx(user, session), securityId);
  }

  @Patch(':securityId')
  @RequirePermission('service', 'create')
  update(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('securityId') securityId: string,
    @Body() body: UpdateSecurityDto,
  ) {
    return this.securityService.update(toCtx(user, session), securityId, body);
  }

  /**
   * `?force=true` is the escape hatch for a Server that is gone for good, as
   * on an Application Delete: without it, a Server that cannot be reached is a
   * 409 naming it and the row is kept; with it, the row goes and the response
   * names the router left in that Server's file. Compared to 'true' like the
   * Application Delete's.
   */
  @Delete(':securityId')
  @RequirePermission('service', 'create')
  remove(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('securityId') securityId: string,
    @Query('force') force?: string,
  ) {
    return this.securityService.remove(
      toCtx(user, session),
      securityId,
      force === 'true',
    );
  }
}
