import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
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
  ChangeLibsqlStatusDto,
  CreateLibsqlDto,
  SaveLibsqlEnvironmentDto,
  SaveLibsqlExternalPortsDto,
  UpdateLibsqlDto,
} from './dto/libsql.dto';
import { LibsqlService } from './libsql.service';
import { AllowedWhenFrozen } from '../../cloud/billing/allowed-when-frozen.decorator';

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

@Controller('libsql')
export class LibsqlController {
  constructor(private readonly libsqlService: LibsqlService) {}

  @Post()
  @RequirePermission('service', 'create')
  create(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateLibsqlDto,
  ) {
    return this.libsqlService.create(toCtx(user, session), body);
  }

  @Post(':id/deploy')
  @HttpCode(200)
  @RequirePermission('deployment', 'create')
  deploy(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.libsqlService.deploy(toCtx(user, session), id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateLibsqlDto,
  ) {
    return this.libsqlService.update(toCtx(user, session), id, body);
  }

  @Patch(':id/environment')
  saveEnvironment(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: SaveLibsqlEnvironmentDto,
  ) {
    return this.libsqlService.saveEnvironment(toCtx(user, session), id, body);
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermission('deployment', 'create')
  changeStatus(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: ChangeLibsqlStatusDto,
  ) {
    return this.libsqlService.changeStatus(toCtx(user, session), id, body);
  }

  /**
   * `?force=true` drops the row even though Cloudgate could not confirm the
   * swarm service is gone, and the response names what was left behind.
   * Default false, a string query parameter compared to 'true' like compose's
   * `deleteVolumes`.
   */
  /**
   * Whether `<appName>-data` is on the Server now, for the Delete dialog.
   * Guarded as the Delete is. `present` is `null` when it cannot be
   * known — a multi-node swarm, or a Server that did not answer.
   */
  @Get(':id/volume')
  @RequirePermission('service', 'delete')
  dataVolume(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.libsqlService.dataVolume(toCtx(user, session), id);
  }

  /**
   * `?deleteData=true` also removes its data volume, `<appName>-data`, once
   * the service is confirmed gone; without it the volume stays (#1413).
   */
  @Delete(':id')
  @AllowedWhenFrozen('remove')
  @RequirePermission('service', 'delete')
  remove(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Query('force') force?: string,
    @Query('deleteData') deleteData?: string,
  ) {
    return this.libsqlService.remove(
      toCtx(user, session),
      id,
      force === 'true',
      {
        deleteData: deleteData === 'true',
      },
    );
  }

  @Post(':id/external-ports')
  @HttpCode(200)
  @RequirePermission('service', 'create')
  saveExternalPorts(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: SaveLibsqlExternalPortsDto,
  ) {
    return this.libsqlService.saveExternalPorts(toCtx(user, session), id, body);
  }

  @Post(':id/rebuild')
  @HttpCode(200)
  @RequirePermission('deployment', 'create')
  rebuild(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.libsqlService.rebuild(toCtx(user, session), id);
  }

  @Post(':id/start')
  @HttpCode(200)
  @RequirePermission('deployment', 'create')
  start(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.libsqlService.start(toCtx(user, session), id);
  }

  @Post(':id/stop')
  @HttpCode(200)
  @RequirePermission('deployment', 'create')
  stop(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.libsqlService.stop(toCtx(user, session), id);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.libsqlService.findOne(toCtx(user, session), id);
  }
}
