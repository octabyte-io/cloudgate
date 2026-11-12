import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { application, environment, project, redirect } from '../../db/schema';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import type { PermissionCtx } from '../../rbac/permission.service';
import { PermissionService } from '../../rbac/permission.service';
import { REDIRECTS_REFUSAL } from '../../domains/cloud-domain';
import { TraefikAppConfigService } from '../../traefik/app-config.service';
import { rewriteRoutingForDelete } from '../../traefik/routing-delete';
import { withUnreclaimedArtifacts } from '../../common/teardown-steps';
import type {
  CreateRedirectDto,
  ListRedirectsDto,
  UpdateRedirectDto,
} from './dto/redirect.dto';

@Injectable()
export class RedirectsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly traefikAppConfig: TraefikAppConfigService,
  ) {}

  /**
   * Service create permission plus row-level access to the parent
   * application at the write level — see `PortsService.create` for why that
   * is two questions and not one, and why
   * the level is `'update'`.
   */
  async create(ctx: PermissionCtx, data: CreateRedirectDto) {
    const parent = await this.findParentApplication(ctx, data.applicationId);
    await this.permissions.checkPermission(ctx, { service: ['create'] });
    await this.permissions.checkServiceAccess(
      ctx,
      parent.applicationId,
      'update',
    );
    this.refuseInCloud(parent);

    const [created] = await this.db.insert(redirect).values(data).returning();

    await this.traefikAppConfig.regenerate(parent);
    return created;
  }

  /** One redirect, access-scoped through the parent application. */
  async findOne(ctx: PermissionCtx, redirectId: string) {
    const row = await this.findRow(redirectId);
    await this.findParentApplication(ctx, row.applicationId);
    await this.permissions.checkServiceAccess(ctx, row.applicationId);
    return row;
  }

  /**
   * The parent application's redirects, access-scoped through it the same way
   * findOne is (MountsService.listByService is the precedent). An application
   * in another organization reads as absent, not forbidden.
   */
  async listByApplication(ctx: PermissionCtx, query: ListRedirectsDto) {
    const parent = await this.findParentApplication(ctx, query.applicationId);
    await this.permissions.checkServiceAccess(ctx, parent.applicationId);

    return this.db
      .select()
      .from(redirect)
      .where(eq(redirect.applicationId, parent.applicationId));
  }

  /** Persist, then regenerate the app's config. */
  async update(
    ctx: PermissionCtx,
    redirectId: string,
    data: UpdateRedirectDto,
  ) {
    const current = await this.findRow(redirectId);
    const parent = await this.findParentApplication(ctx, current.applicationId);
    await this.permissions.checkPermission(ctx, { service: ['create'] });
    await this.permissions.checkServiceAccess(
      ctx,
      parent.applicationId,
      'update',
    );
    this.refuseInCloud(parent);

    const [updated] = await this.db
      .update(redirect)
      .set(data)
      .where(eq(redirect.redirectId, current.redirectId))
      .returning();

    await this.traefikAppConfig.regenerate(parent);
    return updated;
  }

  /**
   * Drop the row and regenerate, as one change. Allowed for a Service in a
   * Cloud account, so a row stored before {@link refuseInCloud} can be taken
   * out; its regeneration writes nothing (`TraefikAppConfigService.regenerate`).
   *
   * The rewrite runs inside the delete's transaction, for
   * `DomainsService.remove`'s reason (#1417), and a Server that cannot be
   * reached is answered the same way: a 409 naming it, with the redirect kept,
   * or with `force` the redirect gone and its middleware named as left in the
   * Server's file (`traefik/routing-delete.ts`).
   */
  async remove(ctx: PermissionCtx, redirectId: string, force = false) {
    const current = await this.findRow(redirectId);
    const parent = await this.findParentApplication(ctx, current.applicationId);
    await this.permissions.checkPermission(ctx, { service: ['delete'] });
    await this.permissions.checkServiceAccess(
      ctx,
      parent.applicationId,
      'update',
    );

    return this.db.transaction(async (tx) => {
      const [removed] = await tx
        .delete(redirect)
        .where(eq(redirect.redirectId, current.redirectId))
        .returning();
      const left = await rewriteRoutingForDelete(
        tx,
        {
          appName: parent.appName,
          configName: parent.appName,
          serverId: parent.serverId,
          noun: 'redirect',
        },
        force,
        () => this.traefikAppConfig.regenerate(parent, tx),
      );
      return withUnreclaimedArtifacts(removed, left);
    });
  }

  /**
   * A redirect is a Traefik middleware, and a Service in a Cloud account has
   * no Traefik: its Domains are its cloud's load balancer's. Asked after the
   * gates, as `SecurityService` asks its basic-auth twin.
   */
  private refuseInCloud(parent: { cloudAccountId: string | null }): void {
    if (parent.cloudAccountId) {
      throw new BadRequestException(REDIRECTS_REFUSAL);
    }
  }

  /** The full row by id, before any access decision needs its parent. */
  private async findRow(redirectId: string) {
    const [row] = await this.db
      .select()
      .from(redirect)
      .where(eq(redirect.redirectId, redirectId))
      .limit(1);
    if (!row) throw new NotFoundException('Redirect not found');
    return row;
  }

  /**
   * The application the redirect attaches to, org-scoped through
   * environment → project like every service lookup.
   */
  private async findParentApplication(
    ctx: PermissionCtx,
    applicationId: string,
  ) {
    const [found] = await this.db
      .select({
        applicationId: application.applicationId,
        appName: application.appName,
        serverId: application.serverId,
        cloudAccountId: application.cloudAccountId,
      })
      .from(application)
      .innerJoin(
        environment,
        eq(application.environmentId, environment.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(
        and(
          eq(application.applicationId, applicationId),
          eq(project.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException('Application not found');
    return found;
  }
}
