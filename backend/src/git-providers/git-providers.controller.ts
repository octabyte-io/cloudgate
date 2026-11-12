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
import {
  CreateGitProviderDto,
  UpdateGitProviderDto,
} from './dto/git-provider.dto';
import { GitProvidersService } from './git-providers.service';

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
@Controller('git-providers')
export class GitProvidersController {
  constructor(private readonly gitProvidersService: GitProvidersService) {}

  @Post()
  @RequirePermission('gitProviders', 'create')
  create(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateGitProviderDto,
  ) {
    return this.gitProvidersService.create(toCtx(user, session), body);
  }

  @Get()
  @RequirePermission('gitProviders', 'read')
  list(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.gitProvidersService.list(toCtx(user, session));
  }

  @Get(':id')
  @RequirePermission('gitProviders', 'read')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.gitProvidersService.findOne(toCtx(user, session), id);
  }

  @Patch(':id')
  @RequirePermission('gitProviders', 'create')
  update(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateGitProviderDto,
  ) {
    return this.gitProvidersService.update(toCtx(user, session), id, body);
  }

  @Delete(':id')
  @RequirePermission('gitProviders', 'delete')
  remove(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.gitProvidersService.remove(toCtx(user, session), id);
  }
}
