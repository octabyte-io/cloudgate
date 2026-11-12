import { Controller, ForbiddenException, Get, Query } from '@nestjs/common';
import type { AuthSession } from '../../auth/auth.config';
import type { ValidatedRequest } from '../../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../../auth/decorators/current-user.decorator';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import type { PermissionCtx } from '../../rbac/permission.service';
import { AuditLogService } from './audit-log.service';
import { ListAuditLogsDto } from './dto/audit-log.dto';

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

// A single read of the trail, behind the auditLog:read permission. Static
// roles resolve as owner/admin pass (auditLog is an enterprise-only resource
// they bypass) and member denied.
//
// There is no license gate on the route: the trail is kept unconditionally
// (see AuditLogService), and the permission alone decides who reads it.
//
// **Two trails**, `scope=organization` (the default) and
// `scope=deleted-organizations`; who may read which is
// `AuditLogService.findTrail`'s decision.
@Controller('audit-logs')
export class AuditLogController {
  constructor(private readonly auditLogs: AuditLogService) {}

  @Get()
  @RequirePermission('auditLog', 'read')
  findAll(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ListAuditLogsDto,
  ) {
    return this.auditLogs.findTrail(toCtx(user, session), query);
  }
}
