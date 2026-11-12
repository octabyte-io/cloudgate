import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { application, environment, project, security } from '../../db/schema';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import type { PermissionCtx } from '../../rbac/permission.service';
import { PermissionService } from '../../rbac/permission.service';
import { BASIC_AUTH_REFUSAL } from '../../domains/cloud-domain';
import { TraefikAppConfigService } from '../../traefik/app-config.service';
import { rewriteRoutingForDelete } from '../../traefik/routing-delete';
import { withUnreclaimedArtifacts } from '../../common/teardown-steps';
import type { UnreclaimedArtifact } from '../../common/teardown-steps';
import type {
  CreateSecurityDto,
  ListSecurityDto,
  UpdateSecurityDto,
} from './dto/security.dto';
import type { Security } from './security.schema';

/**
 * A basic-auth user as exposed over the API — the password never leaves the
 * server. `password` is an encryptedText column, so a bare select() decrypts
 * it on read; the RegistriesService idiom keeps it off every response.
 */
export type SanitizedSecurity = Omit<Security, 'password'>;

function stripPassword(row: Security): SanitizedSecurity {
  const { password, ...rest } = row;
  void password;
  return rest;
}

@Injectable()
export class SecurityService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly traefikAppConfig: TraefikAppConfigService,
  ) {}

  /**
   * Service create permission plus row-level access to the parent
   * application at the write level — see `PortsService.create` for why that
   * is two questions and not one, and why
   * the level is `'update'`. The (username, applicationId) unique
   * constraint is checked up front for a ConflictException instead of a
   * raw DB error, as domains do.
   */
  async create(
    ctx: PermissionCtx,
    data: CreateSecurityDto,
  ): Promise<SanitizedSecurity> {
    const parent = await this.findParentApplication(ctx, data.applicationId);
    await this.permissions.checkPermission(ctx, { service: ['create'] });
    await this.permissions.checkServiceAccess(
      ctx,
      parent.applicationId,
      'update',
    );
    // A cloud Service's Domains are on an AWS load balancer, which has no
    // basic auth.
    if (parent.cloudAccountId) {
      throw new BadRequestException(BASIC_AUTH_REFUSAL);
    }

    const created = await this.db.transaction(async (tx) => {
      const [taken] = await tx
        .select({ securityId: security.securityId })
        .from(security)
        .where(
          and(
            eq(security.username, data.username),
            eq(security.applicationId, data.applicationId),
          ),
        )
        .limit(1);
      if (taken) {
        throw new ConflictException(
          'A basic-auth user with this username already exists',
        );
      }
      const [created] = await tx.insert(security).values(data).returning();
      return created;
    });

    await this.traefikAppConfig.regenerate(parent);
    return stripPassword(created);
  }

  /**
   * One basic-auth user, access-scoped through the parent application —
   * password stripped, since the list route hands these ids out.
   */
  async findOne(
    ctx: PermissionCtx,
    securityId: string,
  ): Promise<SanitizedSecurity> {
    return stripPassword(await this.findOneWithPassword(ctx, securityId));
  }

  /**
   * The full row including the decrypted password, for internal use. Never
   * returned from a controller. Mirrors
   * RegistriesService.findOneWithCredentials.
   */
  async findOneWithPassword(
    ctx: PermissionCtx,
    securityId: string,
  ): Promise<Security> {
    const row = await this.findRow(securityId);
    await this.findParentApplication(ctx, row.applicationId);
    await this.permissions.checkServiceAccess(ctx, row.applicationId);
    return row;
  }

  /**
   * The parent application's basic-auth users, access-scoped through it the
   * same way findOne is (MountsService.listByService is the precedent), with
   * every password stripped. An application in another organization reads as
   * absent, not forbidden.
   */
  async listByApplication(
    ctx: PermissionCtx,
    query: ListSecurityDto,
  ): Promise<SanitizedSecurity[]> {
    const parent = await this.findParentApplication(ctx, query.applicationId);
    await this.permissions.checkServiceAccess(ctx, parent.applicationId);

    const rows = await this.db
      .select()
      .from(security)
      .where(eq(security.applicationId, parent.applicationId));
    return rows.map(stripPassword);
  }

  /** Persist, then regenerate the app's config. */
  async update(
    ctx: PermissionCtx,
    securityId: string,
    data: UpdateSecurityDto,
  ): Promise<SanitizedSecurity> {
    const current = await this.findRow(securityId);
    const parent = await this.findParentApplication(ctx, current.applicationId);
    await this.permissions.checkPermission(ctx, { service: ['create'] });
    await this.permissions.checkServiceAccess(
      ctx,
      parent.applicationId,
      'update',
    );

    const [updated] = await this.db
      .update(security)
      .set(data)
      .where(eq(security.securityId, current.securityId))
      .returning();

    await this.traefikAppConfig.regenerate(parent);
    return stripPassword(updated);
  }

  /**
   * Drop the row and regenerate, as one change. Gated behind service *create*
   * permission, not delete, like every basic-auth mutation.
   *
   * The rewrite runs inside the delete's transaction, for
   * `DomainsService.remove`'s reason (#1417), and sharper here: a delete that
   * committed while the Server could not be reached left the user's htpasswd
   * entry live in the Server's file, still letting them in, behind a 500. Now
   * a Server that is not reached is a 409 naming it and the row is kept, so
   * the console goes on showing a user that can still sign in. With `force`
   * the row goes and the answer names the file that still holds the entry
   * (`traefik/routing-delete.ts`): that user can sign in until the file is
   * next rewritten, which is what forcing accepts.
   */
  async remove(
    ctx: PermissionCtx,
    securityId: string,
    force = false,
  ): Promise<
    SanitizedSecurity & { unreclaimedArtifacts?: UnreclaimedArtifact[] }
  > {
    const current = await this.findRow(securityId);
    const parent = await this.findParentApplication(ctx, current.applicationId);
    await this.permissions.checkPermission(ctx, { service: ['create'] });
    await this.permissions.checkServiceAccess(
      ctx,
      parent.applicationId,
      'update',
    );

    const { row: removed, left } = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .delete(security)
        .where(eq(security.securityId, current.securityId))
        .returning();
      const left = await rewriteRoutingForDelete(
        tx,
        {
          appName: parent.appName,
          configName: parent.appName,
          serverId: parent.serverId,
          noun: 'basic-auth user',
        },
        force,
        () => this.traefikAppConfig.regenerate(parent, tx),
      );
      return { row, left };
    });
    return withUnreclaimedArtifacts(stripPassword(removed), left);
  }

  /** The full row by id, before any access decision needs its parent. */
  private async findRow(securityId: string) {
    const [row] = await this.db
      .select()
      .from(security)
      .where(eq(security.securityId, securityId))
      .limit(1);
    if (!row) throw new NotFoundException('Security not found');
    return row;
  }

  /**
   * The application the basic-auth user attaches to, org-scoped through
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
