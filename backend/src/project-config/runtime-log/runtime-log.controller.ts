import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  Query,
} from '@nestjs/common';
import type { AuthSession } from '../../auth/auth.config';
import type { ValidatedRequest } from '../../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../../auth/decorators/current-user.decorator';
import type { PermissionCtx } from '../../rbac/permission.service';
import { RuntimeLogQueryDto } from '../dto/runtime-log.dto';
import { CloudRuntimeLogs } from './cloud-runtime-logs.service';

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

/** A cloud Service's Runtime log over REST. */
@Controller('applications')
export class RuntimeLogController {
  constructor(private readonly runtimeLogs: CloudRuntimeLogs) {}

  /**
   * Every task's lines from `since` on, merged by time, each naming its
   * task, and the `since` of the next read. Gated by `service: read` in the
   * service, like the Service's own read; no statement of its own.
   */
  @Get(':id/runtime-log')
  read(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Query() query: RuntimeLogQueryDto,
  ) {
    return this.runtimeLogs.read(toCtx(user, session), id, query.since);
  }
}
