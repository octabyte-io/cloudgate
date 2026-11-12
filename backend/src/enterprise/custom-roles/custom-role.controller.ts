import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthSession } from '../../auth/auth.config';
import type { ValidatedRequest } from '../../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../../auth/decorators/current-user.decorator';
import type { PermissionCtx } from '../../rbac/permission.service';
import { CustomRolesService } from './custom-roles.service';
import {
  CreateCustomRoleDto,
  UpdateCustomRoleDto,
} from './dto/custom-role.dto';

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

// Gating: the listing, the roster and the statements catalogue are open to any
// member of the organization; the mutations require an owner/admin and a valid
// enterprise license, enforced in CustomRolesService.
@Controller('custom-roles')
export class CustomRoleController {
  constructor(private readonly customRoles: CustomRolesService) {}

  @Get()
  findAll(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.customRoles.findAll(toCtx(user, session));
  }

  @Get('statements')
  getStatements() {
    return this.customRoles.getStatements();
  }

  @Get(':roleName/members')
  membersByRole(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('roleName') roleName: string,
  ) {
    return this.customRoles.membersByRole(toCtx(user, session), roleName);
  }

  @Post()
  create(
    @Req() req: Request,
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateCustomRoleDto,
  ) {
    return this.customRoles.create(toCtx(user, session), body, req.ip);
  }

  @Patch(':roleName')
  update(
    @Req() req: Request,
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('roleName') roleName: string,
    @Body() body: UpdateCustomRoleDto,
  ) {
    return this.customRoles.update(
      toCtx(user, session),
      { roleName, ...body },
      req.ip,
    );
  }

  @Delete(':roleName')
  remove(
    @Req() req: Request,
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('roleName') roleName: string,
  ) {
    return this.customRoles.remove(toCtx(user, session), roleName, req.ip);
  }
}
