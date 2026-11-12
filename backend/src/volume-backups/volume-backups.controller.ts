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
import type { AuthSession } from '../auth/auth.config';
import type { ValidatedRequest } from '../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import type { PermissionCtx } from '../rbac/permission.service';
import { VolumeBackupsService } from './volume-backups.service';
import {
  CreateVolumeBackupDto,
  ListVolumeBackupsDto,
  RestoreVolumeBackupDto,
  UpdateVolumeBackupDto,
} from './dto/volume-backup.dto';

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

// `volumeBackup` permissions: read on queries, create on create and the manual
// run, update/delete/restore on their verbs.
@Controller('volume-backups')
export class VolumeBackupsController {
  constructor(private readonly volumeBackupsService: VolumeBackupsService) {}

  @Post()
  @RequirePermission('volumeBackup', 'create')
  create(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateVolumeBackupDto,
  ) {
    return this.volumeBackupsService.create(toCtx(user, session), body);
  }

  /**
   * **`204`, and both of this controller's `204`s are void by design**.
   * `restore` answers nothing because its whole diagnosis is the rclone script's
   * stdout, which reaches the caller as a 400/409 message — success
   * has nothing left to say. `POST /volume-backups` above stays `201`.
   */
  @Post('restore')
  @HttpCode(204)
  @RequirePermission('volumeBackup', 'restore')
  restore(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: RestoreVolumeBackupDto,
  ) {
    return this.volumeBackupsService.restore(toCtx(user, session), body);
  }

  @Get()
  @RequirePermission('volumeBackup', 'read')
  listByService(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ListVolumeBackupsDto,
  ) {
    return this.volumeBackupsService.listByService(toCtx(user, session), query);
  }

  @Get(':id')
  @RequirePermission('volumeBackup', 'read')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.volumeBackupsService.findOne(toCtx(user, session), id);
  }

  @Post(':id/run')
  @HttpCode(204)
  @RequirePermission('volumeBackup', 'create')
  runManual(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.volumeBackupsService.runManual(toCtx(user, session), id);
  }

  @Patch(':id')
  @RequirePermission('volumeBackup', 'update')
  update(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateVolumeBackupDto,
  ) {
    return this.volumeBackupsService.update(toCtx(user, session), id, body);
  }

  @Delete(':id')
  @RequirePermission('volumeBackup', 'delete')
  remove(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.volumeBackupsService.remove(toCtx(user, session), id);
  }
}
