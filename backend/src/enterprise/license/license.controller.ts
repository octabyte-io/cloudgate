import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Patch,
  Post,
} from '@nestjs/common';
import type { AuthSession } from '../../auth/auth.config';
import type { ValidatedRequest } from '../../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../../auth/decorators/current-user.decorator';
import type { PermissionCtx } from '../../rbac/permission.service';
import {
  ActivateLicenseDto,
  UpdateEnterpriseSettingsDto,
} from './dto/license.dto';
import { LicenseService } from './license.service';

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

/**
 * License routes: `GET /license/status` is readable by any member of the
 * organization, everything else is owner-only and enforced in LicenseService.
 */
@Controller('license')
export class LicenseController {
  constructor(private readonly license: LicenseService) {}

  /**
   * Whether the organization is licensed (`licensed`), with the stored state
   * that produced the answer, so a console can warn before an expiry and tell a
   * refused license from a missing one.
   */
  @Get('status')
  status(@CurrentSession() session: Session) {
    if (!session.activeOrganizationId) {
      throw new ForbiddenException('No active organization');
    }
    return this.license.getStatus(session.activeOrganizationId);
  }

  @Get('settings')
  getEnterpriseSettings(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.license.getEnterpriseSettings(toCtx(user, session));
  }

  @Patch('settings')
  updateEnterpriseSettings(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: UpdateEnterpriseSettingsDto,
  ) {
    return this.license.updateEnterpriseSettings(toCtx(user, session), body);
  }

  @Post('activate')
  @HttpCode(200)
  activate(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: ActivateLicenseDto,
  ) {
    return this.license.activate(toCtx(user, session), body.licenseKey);
  }

  @Post('validate')
  @HttpCode(200)
  validate(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.license.validate(toCtx(user, session));
  }

  /**
   * "I've renewed, check now": re-activates the stored key, answering with the
   * license status that results.
   */
  @Post('check-now')
  @HttpCode(200)
  checkNow(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.license.checkNow(toCtx(user, session));
  }

  @Post('deactivate')
  @HttpCode(200)
  deactivate(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.license.deactivate(toCtx(user, session));
  }
}
