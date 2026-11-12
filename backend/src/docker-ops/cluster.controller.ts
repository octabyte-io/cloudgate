import {
  Controller,
  Delete,
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
import { ClusterService } from './cluster.service';
import { NodeIdParamsDto, ServerIdQueryDto } from './dto/docker-ops.dto';

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

// Permissions: server:read to look, server:create to mint join commands,
// server:delete to remove a node.
@Controller('cluster')
export class ClusterController {
  constructor(private readonly cluster: ClusterService) {}

  @Get('nodes')
  @RequirePermission('server', 'read')
  getNodes(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ServerIdQueryDto,
  ) {
    return this.cluster.getNodes(toCtx(user, session), query);
  }

  @Get('add-worker')
  @RequirePermission('server', 'create')
  addWorker(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ServerIdQueryDto,
  ) {
    return this.cluster.addWorker(toCtx(user, session), query);
  }

  @Get('add-manager')
  @RequirePermission('server', 'create')
  addManager(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ServerIdQueryDto,
  ) {
    return this.cluster.addManager(toCtx(user, session), query);
  }

  @Delete('nodes/:nodeId')
  @RequirePermission('server', 'delete')
  removeWorker(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param() params: NodeIdParamsDto,
    @Query() query: ServerIdQueryDto,
  ) {
    return this.cluster.removeWorker(toCtx(user, session), {
      nodeId: params.nodeId,
      serverId: query.serverId,
    });
  }
}
