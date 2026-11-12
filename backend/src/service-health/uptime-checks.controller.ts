import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
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
import {
  CreateUptimeCheckDto,
  ListPublishedPortsDto,
  ListUptimeChecksDto,
  UpdateUptimeCheckDto,
} from './dto/uptime-check.dto';
import { UptimeChecksService } from './uptime-checks.service';

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
 * A Service's Uptime checks. Writes are `service: ['update']` and reads
 * `service: ['read']`, here for the role and again in the service for
 * the entitlement to the one Service. Named by `serviceType` + `serviceId`,
 * `mounts`' shape, so one route set serves every Service kind. Every write is
 * audited under `uptimeCheck` (`KIND_BY_SEGMENT`).
 */
@Controller('uptime-checks')
export class UptimeChecksController {
  constructor(private readonly uptimeChecks: UptimeChecksService) {}

  @Post()
  @RequirePermission('service', 'update')
  create(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateUptimeCheckDto,
  ) {
    return this.uptimeChecks.create(toCtx(user, session), body);
  }

  @Get()
  @RequirePermission('service', 'read')
  list(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ListUptimeChecksDto,
  ) {
    return this.uptimeChecks.list(
      toCtx(user, session),
      query.serviceType,
      query.serviceId,
    );
  }

  /**
   * The TCP ports a check on this Service may dial, the address it dials them
   * on, and why there are none when there are none — the modal's
   * published-port picker.
   */
  @Get('published-ports')
  @RequirePermission('service', 'read')
  publishedPorts(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ListPublishedPortsDto,
  ) {
    return this.uptimeChecks.publishedPorts(
      toCtx(user, session),
      query.serviceType,
      query.serviceId,
    );
  }

  @Patch(':uptimeCheckId')
  @RequirePermission('service', 'update')
  update(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('uptimeCheckId') uptimeCheckId: string,
    @Body() body: UpdateUptimeCheckDto,
  ) {
    return this.uptimeChecks.update(toCtx(user, session), uptimeCheckId, body);
  }

  @Delete(':uptimeCheckId')
  @RequirePermission('service', 'update')
  remove(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('uptimeCheckId') uptimeCheckId: string,
  ) {
    return this.uptimeChecks.remove(toCtx(user, session), uptimeCheckId);
  }
}
