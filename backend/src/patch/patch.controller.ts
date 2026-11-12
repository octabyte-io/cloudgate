import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
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
import { PatchRepoService } from './patch-repo.service';
import { PatchService } from './patch.service';
import {
  CleanPatchReposDto,
  CreatePatchDto,
  EnsureRepoDto,
  ListPatchesDto,
  MarkFileForDeletionDto,
  ReadRepoDirectoriesDto,
  ReadRepoFileDto,
  SaveFileAsPatchDto,
  TogglePatchDto,
  UpdatePatchDto,
} from './dto/patch.dto';

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

// Service-scoped permissions — read on queries, create on mutations
// (update/toggle included), delete on delete; the repo-clean endpoint is
// owners and admins only (enforced in PatchRepoService).
@Controller('patches')
export class PatchController {
  constructor(
    private readonly patchService: PatchService,
    private readonly patchRepos: PatchRepoService,
  ) {}

  @Post()
  @RequirePermission('service', 'create')
  create(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreatePatchDto,
  ) {
    return this.patchService.create(toCtx(user, session), body);
  }

  @Get()
  @RequirePermission('service', 'read')
  byEntityId(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ListPatchesDto,
  ) {
    return this.patchService.byEntityId(toCtx(user, session), query);
  }

  @Post('save-file')
  @HttpCode(200)
  @RequirePermission('service', 'create')
  saveFileAsPatch(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: SaveFileAsPatchDto,
  ) {
    return this.patchService.saveFileAsPatch(toCtx(user, session), body);
  }

  @Post('mark-for-deletion')
  @HttpCode(200)
  @RequirePermission('service', 'create')
  markFileForDeletion(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: MarkFileForDeletionDto,
  ) {
    return this.patchService.markFileForDeletion(toCtx(user, session), body);
  }

  @Post('repo/ensure')
  @HttpCode(200)
  @RequirePermission('service', 'create')
  ensureRepo(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: EnsureRepoDto,
  ) {
    return this.patchRepos.ensureRepo(toCtx(user, session), body);
  }

  @Get('repo/directories')
  @RequirePermission('service', 'read')
  readRepoDirectories(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ReadRepoDirectoriesDto,
  ) {
    return this.patchRepos.readRepoDirectory(toCtx(user, session), query);
  }

  @Get('repo/file')
  @RequirePermission('service', 'read')
  readRepoFile(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ReadRepoFileDto,
  ) {
    return this.patchRepos.readRepoFile(toCtx(user, session), query);
  }

  @Post('repo/clean')
  @HttpCode(200)
  cleanRepos(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CleanPatchReposDto,
  ) {
    return this.patchRepos.cleanRepos(toCtx(user, session), body);
  }

  @Get(':patchId')
  @RequirePermission('service', 'read')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('patchId') patchId: string,
  ) {
    return this.patchService.findOne(toCtx(user, session), patchId);
  }

  @Patch(':patchId')
  @RequirePermission('service', 'create')
  update(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('patchId') patchId: string,
    @Body() body: UpdatePatchDto,
  ) {
    return this.patchService.update(toCtx(user, session), patchId, body);
  }

  @Post(':patchId/toggle')
  @HttpCode(200)
  @RequirePermission('service', 'create')
  toggleEnabled(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('patchId') patchId: string,
    @Body() body: TogglePatchDto,
  ) {
    return this.patchService.toggleEnabled(
      toCtx(user, session),
      patchId,
      body.enabled,
    );
  }

  @Delete(':patchId')
  @RequirePermission('service', 'delete')
  remove(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('patchId') patchId: string,
  ) {
    return this.patchService.remove(toCtx(user, session), patchId);
  }
}
