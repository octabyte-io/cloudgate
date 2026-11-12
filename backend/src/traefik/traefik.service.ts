import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { application, environment, project } from '../db/schema';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import type { PermissionCtx } from '../rbac/permission.service';
import { PermissionService } from '../rbac/permission.service';
import type {
  TraefikConfigStatus,
  TraefikConsoleStatus,
} from './config-status.service';
import { TraefikConfigStatusService } from './config-status.service';

/**
 * The read side of H-38: what Traefik last said about an application's
 * configuration, answered to a caller who is entitled to that application.
 *
 * Separate from `TraefikConfigStatusService` on purpose. That one has one
 * collaborator — the exec seam — and is the piece a spec drives directly; this
 * one is the org-scoped lookup, and folding the two together would put a
 * database and a `PermissionService` into the class every regeneration
 * constructs a check with.
 */
@Injectable()
export class TraefikService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly status: TraefikConfigStatusService,
  ) {}

  /**
   * The last verdict, or an `unavailable` one saying no check has run.
   *
   * Never a 404 for "nothing observed yet": the absence of a check is a fact
   * about this instance's uptime, not about the application, and answering with
   * a status that says so is what lets a reader tell "Traefik is happy" from
   * "nobody has looked" — the distinction the whole finding is about.
   */
  async configStatus(
    ctx: PermissionCtx,
    applicationId: string,
  ): Promise<TraefikConfigStatus> {
    const parent = await this.findApplication(ctx, applicationId);
    await this.permissions.checkServiceAccess(ctx, parent.applicationId);

    return (
      this.status.lastStatus(parent.applicationId) ?? {
        applicationId: parent.applicationId,
        appName: parent.appName,
        state: 'unavailable',
        reason:
          'No configuration has been written for this application since this instance started, so Traefik has not been asked',
        checkedAt: new Date().toISOString(),
        rejections: [],
      }
    );
  }

  /**
   * The last verdict on the routers that serve **this console** (H-61).
   *
   * **Instance authority, not `service:read`.** Its neighbour above is one
   * Application's config and takes the same access a Domain read takes. This
   * one is `dynamic/cloudgate.yml` and `dynamic/middlewares.yml` — one file
   * each, instance-wide, and both written behind
   * `SettingsService.requireInstanceAuthority` since H-52. Reading who broke the
   * console's router has to be at most as open as writing it, and an
   * organization owner is not automatically an operator of this host.
   *
   * The same "never a 404 for nothing observed" rule as
   * {@link configStatus}: the absence of a check is a fact about this
   * instance's uptime, and a reader has to be able to tell it from silence that
   * Traefik produced.
   */
  async consoleConfigStatus(ctx: PermissionCtx): Promise<TraefikConsoleStatus> {
    await this.permissions.checkInstanceAuthority(ctx);

    return (
      this.status.consoleStatus() ?? {
        state: 'unavailable',
        reason:
          'Nothing has written a Traefik configuration on this host since this instance started, so Traefik has not been asked about the console’s own routers',
        checkedAt: new Date().toISOString(),
        rejections: [],
      }
    );
  }

  /**
   * The application, org-scoped through environment → project like every other
   * service lookup — `RedirectsService.findParentApplication` is the pattern.
   * An application in another organization reads as absent, not forbidden.
   */
  private async findApplication(ctx: PermissionCtx, applicationId: string) {
    const [found] = await this.db
      .select({
        applicationId: application.applicationId,
        appName: application.appName,
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
