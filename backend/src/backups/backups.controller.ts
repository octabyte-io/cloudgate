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
import { BackupsService } from './backups.service';
import {
  CreateBackupDto,
  ListBackupFilesDto,
  ListBackupsDto,
  RestoreBackupDto,
  UpdateBackupDto,
} from './dto/backup.dto';

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

// `backup` permissions: read on queries, create on create and the manual run,
// update/delete/restore on their verbs.
@Controller('backups')
export class BackupsController {
  constructor(private readonly backupsService: BackupsService) {}

  @Post()
  @RequirePermission('backup', 'create')
  create(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateBackupDto,
  ) {
    return this.backupsService.create(toCtx(user, session), body);
  }

  // The schedules of one backed-up service (mounts' list route's shape).
  // Without it a created backup's id is unrecoverable.
  @Get()
  @RequirePermission('backup', 'read')
  listByService(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ListBackupsDto,
  ) {
    return this.backupsService.listByService(toCtx(user, session), query);
  }

  /**
   * **`204`, not `200`**. `BackupsService.restore` is `Promise<void>` and
   * this handler adds nothing to it, so there is no body for a status to be
   * about. `200` was the alternative and is what the sweep chose everywhere a
   * `{ success }`-shaped body already existed; inventing one here to justify a
   * `200` would be exactly the response-body change that was put out of scope.
   */
  @Post('restore')
  @HttpCode(204)
  @RequirePermission('backup', 'restore')
  restore(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: RestoreBackupDto,
  ) {
    return this.backupsService.restore(toCtx(user, session), body);
  }

  @Get('files')
  @RequirePermission('backup', 'read')
  listBackupFiles(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ListBackupFilesDto,
  ) {
    return this.backupsService.listBackupFiles(toCtx(user, session), query);
  }

  @Get(':id')
  @RequirePermission('backup', 'read')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.backupsService.findOne(toCtx(user, session), id);
  }

  /** Void like {@link restore}, so `204` for the same reason. */
  @Post(':id/run')
  @HttpCode(204)
  @RequirePermission('backup', 'create')
  runManual(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.backupsService.runManual(toCtx(user, session), id);
  }

  @Patch(':id')
  @RequirePermission('backup', 'update')
  update(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateBackupDto,
  ) {
    return this.backupsService.update(toCtx(user, session), id, body);
  }

  @Delete(':id')
  @RequirePermission('backup', 'delete')
  remove(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.backupsService.remove(toCtx(user, session), id);
  }
}
