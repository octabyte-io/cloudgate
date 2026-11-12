import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Post,
} from '@nestjs/common';
import type { AuthSession } from '../auth/auth.config';
import type { ValidatedRequest } from '../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../auth/decorators/current-user.decorator';
import type { PermissionCtx } from '../rbac/permission.service';
import { AdminService } from './admin.service';
import { SetupWebMonitoringBodyDto } from './dto/admin.dto';

type Session = NonNullable<ValidatedRequest['session']>;

function toCtx(user: AuthSession['user'], session: Session): PermissionCtx {
  if (!session.activeOrganizationId) {
    throw new ForbiddenException('No active organization');
  }
  return {
    user: { id: user.id },
    session: { activeOrganizationId: session.activeOrganizationId },
  };
}

/** Instance administration routes. */
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  /**
   * Saves the local web server's metricsConfig and re-registers its collection
   * jobs; instance authority only.
   */
  @Post('setup-monitoring')
  @HttpCode(200)
  setupMonitoring(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: SetupWebMonitoringBodyDto,
  ) {
    return this.admin.setupMonitoring(toCtx(user, session), body.metricsConfig);
  }
}
