import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Put,
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
  ErrorRateThresholdServiceDto,
  PutErrorRateThresholdDto,
} from './dto/error-rate-threshold.dto';
import { ErrorRateThresholdsService } from './error-rate-thresholds.service';

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
 * A Service's one Error-rate threshold: get, put (create or
 * replace) and delete. Writes are `service: ['update']` and the read
 * `service: ['read']`, here for the role and again in the service for
 * the entitlement to the one Service. The Service's id is the path parameter —
 * so the audit row's `resourceId` is the Service — and its kind the
 * `serviceType` query parameter. Every write is audited under
 * `errorRateThreshold` (`KIND_BY_SEGMENT`).
 */
@Controller('error-rate-thresholds')
export class ErrorRateThresholdsController {
  constructor(private readonly thresholds: ErrorRateThresholdsService) {}

  @Get(':serviceId')
  @RequirePermission('service', 'read')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('serviceId') serviceId: string,
    @Query() query: ErrorRateThresholdServiceDto,
  ) {
    return this.thresholds.get(
      toCtx(user, session),
      query.serviceType,
      serviceId,
    );
  }

  @Put(':serviceId')
  @RequirePermission('service', 'update')
  update(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('serviceId') serviceId: string,
    @Query() query: ErrorRateThresholdServiceDto,
    @Body() body: PutErrorRateThresholdDto,
  ) {
    return this.thresholds.put(
      toCtx(user, session),
      query.serviceType,
      serviceId,
      body,
    );
  }

  @Delete(':serviceId')
  @RequirePermission('service', 'update')
  remove(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('serviceId') serviceId: string,
    @Query() query: ErrorRateThresholdServiceDto,
  ) {
    return this.thresholds.remove(
      toCtx(user, session),
      query.serviceType,
      serviceId,
    );
  }
}
