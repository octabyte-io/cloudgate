import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { AuthSession } from '../../../auth/auth.config';
import type { ValidatedRequest } from '../../../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../../../auth/decorators/current-user.decorator';
import { RequirePermission } from '../../../rbac/decorators/require-permission.decorator';
import type { PermissionCtx } from '../../../rbac/permission.service';
import {
  CreateBitbucketDto,
  FindBitbucketBranchesDto,
  UpdateBitbucketDto,
} from './dto/bitbucket.dto';
import { BitbucketService } from './bitbucket.service';

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

// Permission mapping: read on queries, create on create/update (deletion
// happens via the base git-provider row).
@Controller('bitbucket')
export class BitbucketController {
  constructor(private readonly bitbucketService: BitbucketService) {}

  @Post()
  @RequirePermission('gitProviders', 'create')
  create(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateBitbucketDto,
  ) {
    return this.bitbucketService.create(toCtx(user, session), body);
  }

  @Get()
  @RequirePermission('gitProviders', 'read')
  list(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.bitbucketService.list(toCtx(user, session));
  }

  // The repositories the connection can reach.
  @Get(':id/repositories')
  @RequirePermission('gitProviders', 'read')
  listRepositories(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.bitbucketService.listRepositoriesFor(toCtx(user, session), id);
  }

  // The branches of one of those repositories.
  @Get(':id/branches')
  @RequirePermission('gitProviders', 'read')
  listBranches(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Query() query: FindBitbucketBranchesDto,
  ) {
    return this.bitbucketService.listBranchesFor(
      toCtx(user, session),
      id,
      query,
    );
  }

  @Get(':id')
  @RequirePermission('gitProviders', 'read')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.bitbucketService.findOne(toCtx(user, session), id);
  }

  @Patch(':id')
  @RequirePermission('gitProviders', 'create')
  update(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateBitbucketDto,
  ) {
    return this.bitbucketService.update(toCtx(user, session), id, body);
  }
}
