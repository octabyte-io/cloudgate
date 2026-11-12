import { Controller, ForbiddenException, Param, Post } from '@nestjs/common';
import type { AuthSession } from '../auth/auth.config';
import type { ValidatedRequest } from '../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { CronRunsService } from './cron-runs.service';

type Session = NonNullable<ValidatedRequest['session']>;

/**
 * **Run now** on a Cron service (ADR-0034): one run, started by hand,
 * from the image of its last successful build. A deployment action, gated
 * like Deploy.
 */
@Controller('applications')
export class CronRunsController {
  constructor(private readonly runs: CronRunsService) {}

  @Post(':id/run')
  @RequirePermission('deployment', 'create')
  run(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    if (!session.activeOrganizationId) {
      throw new ForbiddenException('No active organization');
    }
    return this.runs.runNow(
      {
        user: { id: user.id },
        session: { activeOrganizationId: session.activeOrganizationId },
      },
      id,
    );
  }
}
