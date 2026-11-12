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
import type { AuthSession } from '../auth/auth.config';
import type { ValidatedRequest } from '../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import type { PermissionCtx } from '../rbac/permission.service';
import { CreateMountDto, ListMountsDto, UpdateMountDto } from './dto/mount.dto';
import { MountsService } from './mounts.service';

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

// Volume-scoped permissions: read on queries, create on mutations (update
// included), delete on delete.
@Controller('mounts')
export class MountsController {
  constructor(private readonly mountsService: MountsService) {}

  @Post()
  @RequirePermission('volume', 'create')
  create(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateMountDto,
  ) {
    return this.mountsService.create(toCtx(user, session), body);
  }

  @Get()
  @RequirePermission('volume', 'read')
  listByService(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ListMountsDto,
  ) {
    return this.mountsService.listByService(toCtx(user, session), query);
  }

  @Get(':mountId')
  @RequirePermission('volume', 'read')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('mountId') mountId: string,
  ) {
    return this.mountsService.findOne(toCtx(user, session), mountId);
  }

  @Patch(':mountId')
  @RequirePermission('volume', 'create')
  update(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('mountId') mountId: string,
    @Body() body: UpdateMountDto,
  ) {
    return this.mountsService.update(toCtx(user, session), mountId, body);
  }

  @Delete(':mountId')
  @RequirePermission('volume', 'delete')
  remove(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('mountId') mountId: string,
  ) {
    return this.mountsService.remove(toCtx(user, session), mountId);
  }
}
