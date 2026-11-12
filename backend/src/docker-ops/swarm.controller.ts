import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  Query,
} from '@nestjs/common';
import type { AuthSession } from '../auth/auth.config';
import type { ValidatedRequest } from '../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import type { PermissionCtx } from '../rbac/permission.service';
import {
  AppInfosQueryDto,
  NodeIdParamsDto,
  ServerIdQueryDto,
} from './dto/docker-ops.dto';
import { SwarmService } from './swarm.service';

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

// Everything server:read.
@Controller('swarm')
export class SwarmController {
  constructor(private readonly swarm: SwarmService) {}

  @Get('nodes')
  @RequirePermission('server', 'read')
  getNodes(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ServerIdQueryDto,
  ) {
    return this.swarm.getSwarmNodes(toCtx(user, session), query);
  }

  @Get('nodes/:nodeId')
  @RequirePermission('server', 'read')
  getNodeInfo(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param() params: NodeIdParamsDto,
    @Query() query: ServerIdQueryDto,
  ) {
    return this.swarm.getNodeInfo(toCtx(user, session), {
      nodeId: params.nodeId,
      serverId: query.serverId,
    });
  }

  @Get('apps')
  @RequirePermission('server', 'read')
  getNodeApps(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ServerIdQueryDto,
  ) {
    return this.swarm.getNodeApplications(toCtx(user, session), query);
  }

  @Get('apps/info')
  @RequirePermission('server', 'read')
  getAppInfos(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: AppInfosQueryDto,
  ) {
    return this.swarm.getApplicationInfo(toCtx(user, session), {
      appNames: query.appName,
      serverId: query.serverId,
    });
  }

  @Get('stats')
  @RequirePermission('server', 'read')
  getContainerStats(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ServerIdQueryDto,
  ) {
    return this.swarm.getAllContainerStats(toCtx(user, session), query);
  }
}
