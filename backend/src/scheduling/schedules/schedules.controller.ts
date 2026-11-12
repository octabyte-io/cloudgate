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
import { SchedulesService } from './schedules.service';
import {
  CreateScheduleDto,
  ListSchedulesDto,
  UpdateScheduleDto,
} from './dto/schedule.dto';

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

// Permission mapping: read on queries, create on create and the manual run,
// update/delete on their verbs.
@Controller('schedules')
export class SchedulesController {
  constructor(private readonly schedulesService: SchedulesService) {}

  @Post()
  @RequirePermission('schedule', 'create')
  create(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateScheduleDto,
  ) {
    return this.schedulesService.create(toCtx(user, session), body);
  }

  @Get()
  @RequirePermission('schedule', 'read')
  list(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ListSchedulesDto,
  ) {
    return this.schedulesService.list(toCtx(user, session), query);
  }

  @Get(':id')
  @RequirePermission('schedule', 'read')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.schedulesService.findOne(toCtx(user, session), id);
  }

  /**
   * `204`: `runManual` is `Promise<void>` — the run's own record is the
   * schedule-run row the job writes, not a body this request can answer with.
   * `POST /schedules` above it stays `201`; it really does create one.
   */
  @Post(':id/run')
  @HttpCode(204)
  @RequirePermission('schedule', 'create')
  runManual(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.schedulesService.runManual(toCtx(user, session), id);
  }

  @Patch(':id')
  @RequirePermission('schedule', 'update')
  update(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateScheduleDto,
  ) {
    return this.schedulesService.update(toCtx(user, session), id, body);
  }

  @Delete(':id')
  @RequirePermission('schedule', 'delete')
  remove(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.schedulesService.remove(toCtx(user, session), id);
  }
}
