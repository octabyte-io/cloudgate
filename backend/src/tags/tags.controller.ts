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
import { CreateTagDto, ListTagsDto, UpdateTagDto } from './dto/tag.dto';
import { TagsService } from './tags.service';

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

@Controller('tags')
export class TagsController {
  constructor(private readonly tagsService: TagsService) {}

  @Post()
  @RequirePermission('tag', 'create')
  create(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateTagDto,
  ) {
    return this.tagsService.create(toCtx(user, session), body);
  }

  @Get()
  list(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ListTagsDto,
  ) {
    const ctx = toCtx(user, session);
    return query.projectId
      ? this.tagsService.listByProject(ctx, query.projectId)
      : this.tagsService.list(ctx);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.tagsService.findOne(toCtx(user, session), id);
  }

  @Patch(':id')
  @RequirePermission('tag', 'update')
  update(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateTagDto,
  ) {
    return this.tagsService.update(toCtx(user, session), id, body);
  }

  @Delete(':id')
  @RequirePermission('tag', 'delete')
  remove(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.tagsService.remove(toCtx(user, session), id);
  }

  // Assign/remove carry no @RequirePermission — project access is enforced
  // row-level in the service.
  /**
   * No `@HttpCode`, so `201`: the assignment *is* a row — `projectTag` —
   * inserted here and returned, and `DELETE` on the same pair removes it. A join
   * row with no id of its own is still a resource that did not exist before.
   */
  @Post(':id/projects/:projectId')
  assignToProject(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Param('projectId') projectId: string,
  ) {
    return this.tagsService.assignToProject(
      toCtx(user, session),
      projectId,
      id,
    );
  }

  @Delete(':id/projects/:projectId')
  removeFromProject(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Param('projectId') projectId: string,
  ) {
    return this.tagsService.removeFromProject(
      toCtx(user, session),
      projectId,
      id,
    );
  }
}
