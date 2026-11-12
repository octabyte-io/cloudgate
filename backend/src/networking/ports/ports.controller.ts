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
import { CreatePortDto, ListPortsDto, UpdatePortDto } from './dto/port.dto';
import { PortsService } from './ports.service';

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

// Service-scoped permissions (ports have no resource of their own), read on queries, create/delete on mutations.
@Controller('ports')
export class PortsController {
  constructor(private readonly portsService: PortsService) {}

  @Post()
  @RequirePermission('service', 'create')
  create(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreatePortDto,
  ) {
    return this.portsService.create(toCtx(user, session), body);
  }

  @Get()
  @RequirePermission('service', 'read')
  listByApplication(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ListPortsDto,
  ) {
    return this.portsService.listByApplication(toCtx(user, session), query);
  }

  @Get(':portId')
  @RequirePermission('service', 'read')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('portId') portId: string,
  ) {
    return this.portsService.findOne(toCtx(user, session), portId);
  }

  @Patch(':portId')
  @RequirePermission('service', 'create')
  update(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('portId') portId: string,
    @Body() body: UpdatePortDto,
  ) {
    return this.portsService.update(toCtx(user, session), portId, body);
  }

  @Delete(':portId')
  @RequirePermission('service', 'delete')
  remove(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('portId') portId: string,
  ) {
    return this.portsService.remove(toCtx(user, session), portId);
  }
}
