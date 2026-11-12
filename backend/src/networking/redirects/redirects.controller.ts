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
  CreateRedirectDto,
  ListRedirectsDto,
  UpdateRedirectDto,
} from './dto/redirect.dto';
import { RedirectsService } from './redirects.service';

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

// Service-scoped permissions (redirects have no resource of their own), read on queries, create/delete on mutations.
@Controller('redirects')
export class RedirectsController {
  constructor(private readonly redirectsService: RedirectsService) {}

  @Post()
  @RequirePermission('service', 'create')
  create(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateRedirectDto,
  ) {
    return this.redirectsService.create(toCtx(user, session), body);
  }

  @Get()
  @RequirePermission('service', 'read')
  listByApplication(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ListRedirectsDto,
  ) {
    return this.redirectsService.listByApplication(toCtx(user, session), query);
  }

  @Get(':redirectId')
  @RequirePermission('service', 'read')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('redirectId') redirectId: string,
  ) {
    return this.redirectsService.findOne(toCtx(user, session), redirectId);
  }

  @Patch(':redirectId')
  @RequirePermission('service', 'create')
  update(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('redirectId') redirectId: string,
    @Body() body: UpdateRedirectDto,
  ) {
    return this.redirectsService.update(toCtx(user, session), redirectId, body);
  }

  /**
   * `?force=true` is the escape hatch for a Server that is gone for good, as
   * on an Application Delete: without it, a Server that cannot be reached is a
   * 409 naming it and the row is kept; with it, the row goes and the response
   * names the router left in that Server's file. Compared to 'true' like the
   * Application Delete's.
   */
  @Delete(':redirectId')
  @RequirePermission('service', 'delete')
  remove(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('redirectId') redirectId: string,
    @Query('force') force?: string,
  ) {
    return this.redirectsService.remove(
      toCtx(user, session),
      redirectId,
      force === 'true',
    );
  }
}
