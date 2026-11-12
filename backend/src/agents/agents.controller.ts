import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthSession } from '../auth/auth.config';
import type { ValidatedRequest } from '../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import type { PermissionCtx } from '../rbac/permission.service';
import { AgentsService } from './agents.service';
import { AddAgentKeyDto, CreateAgentDto } from './dto/agent.dto';

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
 * The Agents of the caller's active Organization. Changing an
 * Agent's role or grant is not here: an Agent is a Member, so the member
 * routes on `OrganizationsController` do it. What is here is what a person
 * does not have — its keys, and Suspend and Resume.
 */
@Controller('agents')
export class AgentsController {
  constructor(private readonly agentsService: AgentsService) {}

  // `member: create` is the authority an invitation takes too; the
  // owner/admin rule is the service's, per §2.2.
  @Post()
  @RequirePermission('member', 'create')
  create(
    @Req() req: Request,
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateAgentDto,
  ) {
    return this.agentsService.create(toCtx(user, session), body, req.ip);
  }

  @Get()
  list(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.agentsService.list(toCtx(user, session));
  }

  @Delete(':id')
  @RequirePermission('member', 'delete')
  remove(
    @Req() req: Request,
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.agentsService.remove(toCtx(user, session), id, req.ip);
  }

  // The four writes below change an existing Agent without adding or removing
  // a Member, so they declare `member: update` — the statement the role and
  // entitlement routes declare. The owner/admin rule is the service's.
  @Post(':id/suspend')
  @HttpCode(200)
  @RequirePermission('member', 'update')
  suspend(
    @Req() req: Request,
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.agentsService.suspend(toCtx(user, session), id, req.ip);
  }

  @Post(':id/resume')
  @HttpCode(200)
  @RequirePermission('member', 'update')
  resume(
    @Req() req: Request,
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.agentsService.resume(toCtx(user, session), id, req.ip);
  }

  @Post(':id/keys')
  @RequirePermission('member', 'update')
  addKey(
    @Req() req: Request,
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: AddAgentKeyDto,
  ) {
    return this.agentsService.addKey(
      toCtx(user, session),
      id,
      body.expiresInDays,
      req.ip,
    );
  }

  @Delete(':id/keys/:keyId')
  @RequirePermission('member', 'update')
  removeKey(
    @Req() req: Request,
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Param('keyId') keyId: string,
  ) {
    return this.agentsService.removeKey(
      toCtx(user, session),
      id,
      keyId,
      req.ip,
    );
  }
}
