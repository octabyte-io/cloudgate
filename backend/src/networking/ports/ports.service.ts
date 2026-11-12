import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { assertNotAiModelForPort } from '../../ai-models/ai-model-locks';
import { assertApplicationKindAllows } from '../../applications/config-kind-locks';
import { application, environment, port, project } from '../../db/schema';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import type { PermissionCtx } from '../../rbac/permission.service';
import { PermissionService } from '../../rbac/permission.service';
import type {
  CreatePortDto,
  ListPortsDto,
  UpdatePortDto,
} from './dto/port.dto';

@Injectable()
export class PortsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
  ) {}

  /**
   * Service create permission plus row-level access to the parent
   * application. Published ports reach the swarm service at the next deploy
   * (mechanize's EndpointSpec fallback), not on save.
   *
   * The two `permissions` lines are two different questions and both are
   * needed. `checkPermission` asks whether the caller's role may do this at
   * all; `checkServiceAccess` asks whether it may do it to *this* Application,
   * and it also names the level — `'update'` rather than the
   * defaulted `'read'` it used to take. A Port has no statement of its own, so
   * `service` is the resource of record for it and this argument is the only
   * thing that stops a role granted `service: ['read']` from publishing a port
   * on somebody's workload. The three writes here, in `redirects.service.ts`,
   * in `security.service.ts`, in `mounts.service.ts` and in the two patch
   * services all took the same argument for the same reason.
   */
  async create(ctx: PermissionCtx, data: CreatePortDto) {
    const parent = await this.findParentApplication(ctx, data.applicationId);
    await this.permissions.checkPermission(ctx, { service: ['create'] });
    await this.permissions.checkServiceAccess(
      ctx,
      parent.applicationId,
      'update',
    );
    // An AI model is reached through the gateway alone, a
    // web-private at its internal address alone.
    await assertNotAiModelForPort(this.db, parent.applicationId);
    await assertApplicationKindAllows(this.db, parent.applicationId, 'port');

    // Input defaults: tcp, and publish mode 'ingress' (the column default is
    // 'host').
    const [created] = await this.db
      .insert(port)
      .values({
        ...data,
        protocol: data.protocol ?? 'tcp',
        publishMode: data.publishMode ?? 'ingress',
      })
      .returning();
    return created;
  }

  /** One port, access-scoped through the parent application. */
  async findOne(ctx: PermissionCtx, portId: string) {
    const row = await this.findRow(portId);
    await this.findParentApplication(ctx, row.applicationId);
    await this.permissions.checkServiceAccess(ctx, row.applicationId);
    return row;
  }

  /**
   * The parent application's published ports, access-scoped through it the
   * same way findOne is (MountsService.listByService is the precedent).
   * An application in another organization reads as absent, not forbidden.
   */
  async listByApplication(ctx: PermissionCtx, query: ListPortsDto) {
    const parent = await this.findParentApplication(ctx, query.applicationId);
    await this.permissions.checkServiceAccess(ctx, parent.applicationId);

    return this.db
      .select()
      .from(port)
      .where(eq(port.applicationId, parent.applicationId));
  }

  /**
   * Service create permission plus write-level access to the parent
   * application.
   */
  async update(ctx: PermissionCtx, portId: string, data: UpdatePortDto) {
    const current = await this.findRow(portId);
    const parent = await this.findParentApplication(ctx, current.applicationId);
    await this.permissions.checkPermission(ctx, { service: ['create'] });
    await this.permissions.checkServiceAccess(
      ctx,
      parent.applicationId,
      'update',
    );
    await assertNotAiModelForPort(this.db, parent.applicationId);
    await assertApplicationKindAllows(this.db, parent.applicationId, 'port');

    const [updated] = await this.db
      .update(port)
      .set(data)
      .where(eq(port.portId, current.portId))
      .returning();
    return updated;
  }

  /**
   * Service delete permission plus write-level access to the parent
   * application.
   */
  async remove(ctx: PermissionCtx, portId: string) {
    const current = await this.findRow(portId);
    const parent = await this.findParentApplication(ctx, current.applicationId);
    await this.permissions.checkPermission(ctx, { service: ['delete'] });
    await this.permissions.checkServiceAccess(
      ctx,
      parent.applicationId,
      'update',
    );

    const [removed] = await this.db
      .delete(port)
      .where(eq(port.portId, current.portId))
      .returning();
    return removed;
  }

  /** The full row by id, before any access decision needs its parent. */
  private async findRow(portId: string) {
    const [row] = await this.db
      .select()
      .from(port)
      .where(eq(port.portId, portId))
      .limit(1);
    if (!row) throw new NotFoundException('Port not found');
    return row;
  }

  /**
   * The application the port attaches to, org-scoped through
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
