import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { mapUniqueViolation } from '../common/unique-violation';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { project, projectTag, tag } from '../db/schema';
import type { PermissionCtx } from '../rbac/permission.service';
import { PermissionService } from '../rbac/permission.service';
import type { CreateTagDto, UpdateTagDto } from './dto/tag.dto';

/**
 * A Tag's name is unique in its organization. The index is on
 * `(organization_id, lower(name))`, so `Frontend` beside `frontend` is answered
 * 409 too; it keeps the old constraint's name, which is what is matched.
 */
const UNIQUE_NAME_INDEX = 'unique_org_tag_name';
const NAME_TAKEN = 'A tag with this name already exists in your organization';

@Injectable()
export class TagsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
  ) {}

  /** Create a tag, scoped to the session's active organization. */
  async create(ctx: PermissionCtx, data: CreateTagDto) {
    try {
      const [created] = await this.db
        .insert(tag)
        .values({ ...data, organizationId: ctx.session.activeOrganizationId })
        .returning();
      return created;
    } catch (error) {
      throw mapUniqueViolation(error, UNIQUE_NAME_INDEX, NAME_TAKEN);
    }
  }

  /** Every tag in the active organization, by name. */
  async list(ctx: PermissionCtx) {
    return this.db
      .select()
      .from(tag)
      .where(eq(tag.organizationId, ctx.session.activeOrganizationId))
      .orderBy(asc(tag.name));
  }

  /** One tag — a tag is only visible inside its own organization. */
  async findOne(ctx: PermissionCtx, tagId: string) {
    const [found] = await this.db
      .select()
      .from(tag)
      .where(
        and(
          eq(tag.tagId, tagId),
          eq(tag.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException('Tag not found');
    return found;
  }

  /**
   * Update a tag, org-scoped through findOne. A rename onto another tag's name
   * is the same 409 a create gets — it was a bare 500 before, because
   * only `create` mapped the violation.
   */
  async update(ctx: PermissionCtx, tagId: string, data: UpdateTagDto) {
    const current = await this.findOne(ctx, tagId);
    try {
      const [updated] = await this.db
        .update(tag)
        .set(data)
        .where(eq(tag.tagId, current.tagId))
        .returning();
      return updated;
    } catch (error) {
      throw mapUniqueViolation(error, UNIQUE_NAME_INDEX, NAME_TAKEN);
    }
  }

  /**
   * Assign a tag to a project: the project must resolve in the caller's
   * organization (at the write level, so a caller who may only read
   * it is refused) and the tag must belong to the same organization.
   */
  async assignToProject(ctx: PermissionCtx, projectId: string, tagId: string) {
    await this.checkProjectForUpdate(ctx, projectId);
    const found = await this.findOne(ctx, tagId);
    const [assigned] = await this.db
      .insert(projectTag)
      .values({ projectId, tagId: found.tagId })
      .returning();
    return assigned;
  }

  /** Remove a tag from a project, same access checks as assign. */
  async removeFromProject(
    ctx: PermissionCtx,
    projectId: string,
    tagId: string,
  ) {
    await this.checkProjectForUpdate(ctx, projectId);
    const found = await this.findOne(ctx, tagId);
    await this.db
      .delete(projectTag)
      .where(
        and(
          eq(projectTag.projectId, projectId),
          eq(projectTag.tagId, found.tagId),
        ),
      );
  }

  /** The tags assigned to a project, by name. */
  async listByProject(ctx: PermissionCtx, projectId: string) {
    await this.checkProject(ctx, projectId);
    const rows = await this.db
      .select({ tag })
      .from(projectTag)
      .innerJoin(tag, eq(projectTag.tagId, tag.tagId))
      .where(eq(projectTag.projectId, projectId))
      .orderBy(asc(tag.name));
    return rows.map((row) => row.tag);
  }

  /**
   * {@link checkProject} at the write level.
   *
   * `POST` and `DELETE /tags/:id/projects/:projectId` carry no
   * `@RequirePermission` and no `tag` action of any kind, so before the write
   * level the only gate on either was `checkProject`'s `accessedProjects` check
   * — and `PermissionService.checkProjectAccess`'s `'read'` branch consults no
   * statement, because there is no `project: ['read']`. So a caller who could
   * *see* a Project could relabel it, and there was no role that could not.
   *
   * **`project: ['update']` rather than `tag: ['update']`, which was the other
   * candidate and is recorded as rejected.** A `projectTag` row has no id of
   * its own (see `TagsController.assignToProject`), and the four `tag` actions
   * are about the label's own row — `PATCH /tags/:id` and `DELETE /tags/:id`
   * carry `tag: ['update']` and `tag: ['delete']` respectively. Nothing in the
   * `tag` statement is about *which Projects wear a label*, and the asymmetry
   * of these two routes says which side owns the write: the projectId is
   * access-checked, the tagId is only org-scoped through {@link findOne}.
   * Gating on `tag` would also have meant adding a decorator rather than
   * naming a level — a different change from naming the level — and `tag` is in
   * `enterpriseOnlyResources`, so for owner and admin `checkPermission` skips
   * it entirely and the gate would do nothing at all for them.
   *
   * The order is the point of the method: `'update'` is claimed before the
   * org-scoped lookup, so a caller who may read the Project but not change it
   * is refused without learning whether the id resolves (§2.2).
   */
  private async checkProjectForUpdate(ctx: PermissionCtx, projectId: string) {
    await this.permissions.checkProjectAccess(ctx, 'update', projectId);
    return this.checkProject(ctx, projectId);
  }

  /**
   * Row-level project access plus org scoping.
   *
   * Read-level, and stays so — {@link listByProject} is a read.
   * {@link checkProjectForUpdate} is the write-path entry.
   */
  private async checkProject(ctx: PermissionCtx, projectId: string) {
    await this.permissions.checkProjectAccess(ctx, 'read', projectId);
    const [found] = await this.db
      .select({ projectId: project.projectId })
      .from(project)
      .where(
        and(
          eq(project.projectId, projectId),
          eq(project.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException('Project not found');
  }

  /** Delete a tag, org-scoped through findOne. */
  async remove(ctx: PermissionCtx, tagId: string) {
    const current = await this.findOne(ctx, tagId);
    const [removed] = await this.db
      .delete(tag)
      .where(eq(tag.tagId, current.tagId))
      .returning();
    return removed;
  }
}
