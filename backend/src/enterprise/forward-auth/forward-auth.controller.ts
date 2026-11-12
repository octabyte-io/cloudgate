import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthSession } from '../../auth/auth.config';
import type { ValidatedRequest } from '../../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../../auth/decorators/current-user.decorator';
import type { PermissionCtx } from '../../rbac/permission.service';
import {
  DeployForwardAuthDto,
  ForwardAuthServerQueryDto,
  SetForwardAuthSettingsDto,
} from './dto/forward-auth.dto';
import { ForwardAuthService } from './forward-auth.service';

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
 * Forward-auth routes. The server-level routes require an owner/admin, enforced
 * in the service; the per-domain routes are gated on the `domain` permission and
 * row-level service access instead. Setting forward auth up or changing it (the
 * auth domain, the proxy, gating a domain) also needs the paid features — a
 * valid license, or Business on the Hosted instance — while reads, ungating and
 * removal stay open on any plan.
 */
@Controller('forward-auth')
export class ForwardAuthController {
  constructor(private readonly forwardAuth: ForwardAuthService) {}

  @Get('settings')
  getAuthDomain(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ForwardAuthServerQueryDto,
  ) {
    return this.forwardAuth.getAuthDomain(
      toCtx(user, session),
      query.serverId ?? null,
    );
  }

  @Put('settings')
  setAuthDomain(
    @Req() req: Request,
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: SetForwardAuthSettingsDto,
  ) {
    return this.forwardAuth.setAuthDomain(
      toCtx(user, session),
      { ...body, serverId: body.serverId ?? null },
      req.ip,
    );
  }

  @Delete('settings')
  removeAuthDomain(
    @Req() req: Request,
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ForwardAuthServerQueryDto,
  ) {
    return this.forwardAuth.removeAuthDomain(
      toCtx(user, session),
      query.serverId ?? null,
      req.ip,
    );
  }

  @Get('providers')
  listProviders(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.forwardAuth.listProviders(toCtx(user, session));
  }

  @Get('servers')
  serverStatus(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.forwardAuth.serverStatus(toCtx(user, session));
  }

  @Post('proxy')
  @HttpCode(200)
  deployOnServer(
    @Req() req: Request,
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: DeployForwardAuthDto,
  ) {
    return this.forwardAuth.deployOnServer(
      toCtx(user, session),
      { serverId: body.serverId ?? null, providerId: body.providerId },
      req.ip,
    );
  }

  @Delete('proxy')
  removeOnServer(
    @Req() req: Request,
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ForwardAuthServerQueryDto,
  ) {
    return this.forwardAuth.removeOnServer(
      toCtx(user, session),
      query.serverId ?? null,
      req.ip,
    );
  }

  @Get('domains/:domainId')
  getDomainStatus(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('domainId') domainId: string,
  ) {
    return this.forwardAuth.getDomainStatus(toCtx(user, session), domainId);
  }

  @Post('domains/:domainId/enable')
  @HttpCode(200)
  enableOnDomain(
    @Req() req: Request,
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('domainId') domainId: string,
  ) {
    return this.forwardAuth.enableOnDomain(
      toCtx(user, session),
      domainId,
      req.ip,
    );
  }

  @Post('domains/:domainId/disable')
  @HttpCode(200)
  disableOnDomain(
    @Req() req: Request,
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('domainId') domainId: string,
  ) {
    return this.forwardAuth.disableOnDomain(
      toCtx(user, session),
      domainId,
      req.ip,
    );
  }
}
