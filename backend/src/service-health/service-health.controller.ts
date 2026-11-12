import {
  Controller,
  ForbiddenException,
  Get,
  Param,
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
import {
  ServiceHealthParamsDto,
  ServiceHealthQueryDto,
} from './dto/service-health.dto';
import { ServiceHealthService } from './service-health.service';

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
 * A Service's health summary, the Health tab's one read.
 * `service: ['read']` plus the entitlement to the one Service, never
 * `monitoring: ['read']`. The batched read for an Environment's Services
 * is `GET /environments/:id/health`, beside that Environment's other feeds.
 */
@Controller('service-health')
export class ServiceHealthController {
  constructor(private readonly serviceHealth: ServiceHealthService) {}

  @Get(':serviceType/:serviceId')
  @RequirePermission('service', 'read')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param() params: ServiceHealthParamsDto,
    @Query() query: ServiceHealthQueryDto,
  ) {
    return this.serviceHealth.summary(
      toCtx(user, session),
      params.serviceType,
      params.serviceId,
      query,
    );
  }
}
