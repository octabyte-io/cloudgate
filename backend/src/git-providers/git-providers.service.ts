import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { gitProvider } from '../db/schema';
import type { GitProvider } from '../db/schema';
import type { PermissionCtx } from '../rbac/permission.service';
import type {
  CreateGitProviderDto,
  UpdateGitProviderDto,
} from './dto/git-provider.dto';

@Injectable()
export class GitProvidersService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  /** Creates the base provider row in the session's active organization. */
  async create(
    ctx: PermissionCtx,
    data: CreateGitProviderDto,
  ): Promise<GitProvider> {
    const [created] = await this.db
      .insert(gitProvider)
      .values({ ...data, organizationId: ctx.session.activeOrganizationId })
      .returning();
    return created;
  }

  /** The organization's providers, newest first. */
  async list(ctx: PermissionCtx): Promise<GitProvider[]> {
    return this.db
      .select()
      .from(gitProvider)
      .where(eq(gitProvider.organizationId, ctx.session.activeOrganizationId))
      .orderBy(desc(gitProvider.createdAt));
  }

  /** One provider by id — only visible inside its organization. */
  async findOne(
    ctx: PermissionCtx,
    gitProviderId: string,
  ): Promise<GitProvider> {
    const [found] = await this.db
      .select()
      .from(gitProvider)
      .where(
        and(
          eq(gitProvider.gitProviderId, gitProviderId),
          eq(gitProvider.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException('Git provider not found');
    return found;
  }

  /** Update a provider, org-scoped through findOne. */
  async update(
    ctx: PermissionCtx,
    gitProviderId: string,
    data: UpdateGitProviderDto,
  ): Promise<GitProvider> {
    const current = await this.findOne(ctx, gitProviderId);
    const [updated] = await this.db
      .update(gitProvider)
      .set(data)
      .where(eq(gitProvider.gitProviderId, current.gitProviderId))
      .returning();
    return updated;
  }

  /** Remove a provider, org-scoped through findOne. */
  async remove(
    ctx: PermissionCtx,
    gitProviderId: string,
  ): Promise<GitProvider> {
    const current = await this.findOne(ctx, gitProviderId);
    const [removed] = await this.db
      .delete(gitProvider)
      .where(eq(gitProvider.gitProviderId, current.gitProviderId))
      .returning();
    return removed;
  }
}
