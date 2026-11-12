import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthSession } from '../auth/auth.config';
import type { ValidatedRequest } from '../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { InviteMemberDto } from './dto/invite-member.dto';
import {
  CreateOrganizationDto,
  OrganizationCreationDto,
  UpdateOrganizationDto,
} from './dto/organization.dto';
import { AddTeamMemberDto, CreateTeamDto } from './dto/team.dto';
import { UpdateMemberEntitlementsDto } from './dto/update-member-entitlements.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { OrganizationsService } from './organizations.service';
import { AllowedWhenFrozen } from '../cloud/billing/allowed-when-frozen.decorator';

type Session = NonNullable<ValidatedRequest['session']>;

@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Get()
  list(@CurrentUser() user: AuthSession['user']) {
    return this.organizationsService.listForUser(user.id);
  }

  @Post()
  @AllowedWhenFrozen('own-account')
  create(
    @Req() req: Request,
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateOrganizationDto,
  ) {
    return this.organizationsService.create(
      user,
      body,
      req.ip,
      session.activeOrganizationId,
    );
  }

  /**
   * Whether `POST /organizations` would accept this caller now, and why not
   * (`OrganizationsService.creation`). Any signed-in caller may ask: it answers
   * about them, and the refusal it repeats names no Organization but their
   * own and, on Hosted, the open one.
   */
  @Get('creation')
  @ApiOkResponse({ type: OrganizationCreationDto })
  creation(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.organizationsService.creation(
      user,
      session.activeOrganizationId,
    );
  }

  @Get('active')
  active(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.organizationsService.getActive(
      user.id,
      session.activeOrganizationId,
    );
  }

  @Post('invitations')
  invite(
    @Req() req: Request,
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: InviteMemberDto,
  ) {
    return this.organizationsService.inviteMember(req.headers, body, {
      userId: user.id,
      organizationId: session.activeOrganizationId,
      ip: req.ip,
    });
  }

  @Get('invitations')
  listInvitations(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.organizationsService.listInvitations(
      user.id,
      session.activeOrganizationId,
    );
  }

  // The invitee is not a member yet and has no active organization, so this
  // read is scoped by the caller being the invitation's recipient rather than
  // by membership — unlike every other invitation route on this controller.
  @Get('invitations/:id/state')
  readInvitationState(
    @CurrentUser() user: AuthSession['user'],
    @Param('id') id: string,
  ) {
    return this.organizationsService.readInvitationState(id, user.email);
  }

  @Get('members')
  // Passed straight through from better-auth's api.listMembers, which answers
  // with an envelope rather than the bare array the route name suggests.
  // There is no zod DTO to reflect here — better-auth owns the member row — so
  // the envelope is stated, and its contents left open rather than guessed at.
  @ApiOkResponse({
    description:
      "better-auth's member list. Note the envelope: the members are under " +
      '`members`, not at the top level.',
    schema: {
      type: 'object',
      required: ['members', 'total'],
      properties: {
        members: { type: 'array', items: { type: 'object' } },
        total: { type: 'integer' },
      },
    },
  })
  listMembers(@Req() req: Request, @CurrentSession() session: Session) {
    return this.organizationsService.listMembers(
      req.headers,
      session.activeOrganizationId,
    );
  }

  @Patch('members/:id')
  updateMemberRole(
    @Req() req: Request,
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateMemberRoleDto,
  ) {
    return this.organizationsService.updateMemberRole(
      user.id,
      session.activeOrganizationId,
      id,
      body.role,
      req.ip,
    );
  }

  // The row-level grants, beside the role they sit next to on the member row.
  // `member: update` is the permission a grant needs; the owner/admin
  // rule and the Organization scoping are the service's, per §2.2.
  @Patch('members/:id/entitlements')
  @RequirePermission('member', 'update')
  updateMemberEntitlements(
    @Req() req: Request,
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateMemberEntitlementsDto,
  ) {
    return this.organizationsService.updateMemberEntitlements(
      user.id,
      session.activeOrganizationId,
      id,
      body,
      req.ip,
    );
  }

  @Delete('members/:id')
  removeMember(
    @Req() req: Request,
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.organizationsService.removeMember(req.headers, id, {
      userId: user.id,
      organizationId: session.activeOrganizationId,
      ip: req.ip,
    });
  }

  // All six team handlers below take `@CurrentSession()` and hand the resolved
  // `activeOrganizationId` down, the same shape `removeMember` above uses. It
  // is what makes them answer an api key rather than `400 "No active
  // organization"` — see the block above the six service methods.
  // `listTeamMembers` is hand-rolled and needs none of this.
  @Post('teams')
  createTeam(
    @Req() req: Request,
    @CurrentSession() session: Session,
    @Body() body: CreateTeamDto,
  ) {
    return this.organizationsService.createTeam(
      req.headers,
      body.name,
      session.activeOrganizationId,
    );
  }

  @Get('teams')
  listTeams(@Req() req: Request, @CurrentSession() session: Session) {
    return this.organizationsService.listTeams(
      req.headers,
      session.activeOrganizationId,
    );
  }

  @Patch('teams/:id')
  updateTeam(
    @Req() req: Request,
    @CurrentSession() session: Session,
    @Param('id') teamId: string,
    @Body() body: CreateTeamDto,
  ) {
    return this.organizationsService.updateTeam(
      req.headers,
      teamId,
      body.name,
      session.activeOrganizationId,
    );
  }

  @Delete('teams/:id')
  removeTeam(
    @Req() req: Request,
    @CurrentSession() session: Session,
    @Param('id') teamId: string,
  ) {
    return this.organizationsService.removeTeam(
      req.headers,
      teamId,
      session.activeOrganizationId,
    );
  }

  @Post('teams/:id/members')
  addTeamMember(
    @Req() req: Request,
    @CurrentSession() session: Session,
    @Param('id') teamId: string,
    @Body() body: AddTeamMemberDto,
  ) {
    return this.organizationsService.addTeamMember(
      req.headers,
      teamId,
      body.userId,
      session.activeOrganizationId,
    );
  }

  @Get('teams/:id/members')
  listTeamMembers(
    @CurrentUser() user: AuthSession['user'],
    @Param('id') teamId: string,
  ) {
    return this.organizationsService.listTeamMembers(user.id, teamId);
  }

  @Delete('teams/:id/members/:userId')
  removeTeamMember(
    @Req() req: Request,
    @CurrentSession() session: Session,
    @Param('id') teamId: string,
    @Param('userId') userId: string,
  ) {
    return this.organizationsService.removeTeamMember(
      req.headers,
      teamId,
      userId,
      session.activeOrganizationId,
    );
  }

  /**
   * **Left at `201`**, though the path is a verb: accepting is what brings
   * the `member` row into existence, and better-auth answers with it. The
   * invitation is the input, not the thing created. `:id/set-default` below is
   * the controller's one `200` — it flips a flag on a membership that exists.
   */
  @Post('invitations/:id/accept')
  @AllowedWhenFrozen('own-account')
  acceptInvitation(@Req() req: Request, @Param('id') id: string) {
    return this.organizationsService.acceptInvitation(req.headers, id);
  }

  @Delete('invitations/:id')
  removeInvitation(
    @Req() req: Request,
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.organizationsService.removeInvitation(
      user.id,
      session.activeOrganizationId,
      id,
      req.ip,
    );
  }

  // ':id' routes come last so they never shadow the static paths above
  // ('active', 'invitations', 'members', 'teams').

  @Post(':id/set-default')
  @AllowedWhenFrozen('own-account')
  @HttpCode(200)
  setDefault(
    @Req() req: Request,
    @CurrentUser() user: AuthSession['user'],
    @Param('id') id: string,
  ) {
    return this.organizationsService.setDefault(user.id, id, req.ip);
  }

  @Get(':id')
  getById(@CurrentUser() user: AuthSession['user'], @Param('id') id: string) {
    return this.organizationsService.getById(user.id, id);
  }

  @Patch(':id')
  update(
    @Req() req: Request,
    @CurrentUser() user: AuthSession['user'],
    @Param('id') id: string,
    @Body() body: UpdateOrganizationDto,
  ) {
    return this.organizationsService.update(user.id, id, body, req.ip);
  }

  @Delete(':id')
  @AllowedWhenFrozen('delete-organization')
  delete(
    @Req() req: Request,
    @CurrentUser() user: AuthSession['user'],
    @Param('id') id: string,
  ) {
    return this.organizationsService.delete(user.id, id, req.ip);
  }
}
