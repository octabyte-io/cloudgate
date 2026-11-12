import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import type { AuthSession } from '../auth/auth.config';
import type { ValidatedRequest } from '../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import type { PermissionCtx } from '../rbac/permission.service';
import { CreateSshKeyDto, UpdateSshKeyDto } from './dto/ssh-key.dto';
import { SshKeysService } from './ssh-keys.service';

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

// Permission mapping: read on queries, create on create/update, delete on
// remove.
@Controller('ssh-keys')
export class SshKeysController {
  constructor(private readonly sshKeysService: SshKeysService) {}

  @Post()
  @RequirePermission('sshKeys', 'create')
  create(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateSshKeyDto,
  ) {
    return this.sshKeysService.create(toCtx(user, session), body);
  }

  @Get()
  @RequirePermission('sshKeys', 'read')
  list(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.sshKeysService.list(toCtx(user, session));
  }

  @Get(':id')
  @RequirePermission('sshKeys', 'read')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.sshKeysService.findOne(toCtx(user, session), id);
  }

  @Patch(':id')
  @RequirePermission('sshKeys', 'create')
  update(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateSshKeyDto,
  ) {
    return this.sshKeysService.update(toCtx(user, session), id, body);
  }

  @Delete(':id')
  @RequirePermission('sshKeys', 'delete')
  remove(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.sshKeysService.remove(toCtx(user, session), id);
  }
}
