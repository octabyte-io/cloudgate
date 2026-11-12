import {
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
} from '@nestjs/common';

import type { AuthSession } from '../auth/auth.config';
import type { ValidatedRequest } from '../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import type { PermissionCtx } from '../rbac/permission.service';
import { PendingSetups } from './setup/pending-setups.service';

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
 * An Environment's **Pending setups** (ADR-0065): listed on the Environment
 * and cancelled there. Under `environments/` because a Pending setup belongs
 * to its Environment, and kept in the templates module because that is what
 * makes one. No Agent reaches either route (ADR-0023).
 */
@Controller('environments/:environmentId/pending-setups')
export class PendingSetupsController {
  constructor(private readonly setups: PendingSetups) {}

  /**
   * The Environment's Pending setups, each value as present only, and the
   * notes of those the 30-day sweep dropped.
   */
  @Get()
  @RequirePermission('environment', 'read')
  list(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('environmentId') environmentId: string,
  ) {
    return this.setups.list(toCtx(user, session), environmentId);
  }

  /** Cancels one Pending setup; answers it, and the plan made again. */
  @Delete(':pendingSetupId')
  @RequirePermission('environment', 'update')
  remove(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('environmentId') environmentId: string,
    @Param('pendingSetupId') pendingSetupId: string,
  ) {
    return this.setups.cancel(
      toCtx(user, session),
      environmentId,
      pendingSetupId,
    );
  }
}
