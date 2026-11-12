import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { server } from '../db/schema';
import { AuditLogService } from '../enterprise/audit-logs/audit-log.service';
import type { PermissionCtx } from '../rbac/permission.service';
import { DockerResourceService } from './docker-resource.service';
import {
  TRAEFIK_CONTAINER_NAME,
  TraefikFilesService,
} from './traefik-files.service';

/**
 * Request metrics on one machine — the platform host (`serverId` null) or a
 * Server — which is what a Service's Error rate is read from (ADR-0027).
 *
 * **How the state is known, and why it differs by machine.** A Server's is the
 * stored `server.requestMetricsEnabled`, so the Server read and every
 * collection tick are a database read an unreachable Server cannot fail or
 * slow down; it is written at the only two moments Cloudgate writes that
 * Server's traefik.yml (here, and `ServersService.setup`'s read-back). The
 * platform host's is read off its own traefik.yml each time, because that is a
 * local file read with no network in it, and it is therefore right on a fresh
 * install whose `deploy/install.sh` wrote the block before the backend first
 * booted — a stored flag would have had nothing to set it.
 *
 * Authorization is the caller's: `POST /settings/traefik/request-metrics` takes
 * the Traefik restart gate (`traefikTargetAuthority`) before it gets here.
 */
@Injectable()
export class RequestMetricsService {
  private readonly logger = new Logger(RequestMetricsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly traefikFiles: TraefikFilesService,
    private readonly dockerResources: DockerResourceService,
    private readonly auditLogs: AuditLogService,
  ) {}

  /**
   * Whether this machine's Traefik keeps request metrics. What the collection
   * job reads to decide "request metrics not enabled on this Server".
   * A Server id that names no row reads as off.
   */
  async isEnabled(serverId: string | null): Promise<boolean> {
    if (!serverId) return this.traefikFiles.platformCarriesRequestMetrics();
    const [row] = await this.db
      .select({ enabled: server.requestMetricsEnabled })
      .from(server)
      .where(eq(server.serverId, serverId))
      .limit(1);
    return row?.enabled ?? false;
  }

  /**
   * Enable request metrics: write the block into the machine's traefik.yml,
   * record it, and request the Traefik restart that makes static
   * configuration take effect.
   *
   * The write is awaited, so a machine with no traefik.yml answers 404 and
   * nothing is recorded. The restart is fire-and-forget, as
   * `POST /settings/traefik/reload`'s is, so the request returns before Traefik
   * drops the connections it would be answered on.
   *
   * **Audited here, not by the interceptor** (US77): the row is `update
   * server` naming the machine — the Server's id and name, or `local` and
   * `platform host` — with the change and the route in its metadata, which the
   * path `POST /settings/traefik/request-metrics` could not say. Written once
   * the file is, so a 404 records nothing.
   */
  async enable(
    ctx: PermissionCtx,
    serverId: string | null,
    ip?: string,
  ): Promise<{ enabled: true }> {
    await this.traefikFiles.enableRequestMetrics(serverId);
    let serverName = 'platform host';
    if (serverId) {
      const [row] = await this.db
        .update(server)
        .set({ requestMetricsEnabled: true })
        .where(eq(server.serverId, serverId))
        .returning({ name: server.name });
      serverName = row?.name ?? serverId;
    }
    await this.auditLogs.audit(
      {
        userId: ctx.user.id,
        organizationId: ctx.session.activeOrganizationId,
        ip,
      },
      {
        action: 'update',
        resourceType: 'server',
        resourceId: serverId ?? 'local',
        resourceName: serverName,
        metadata: {
          route: 'POST /settings/traefik/request-metrics',
          change: 'Enable request metrics',
        },
      },
    );
    void this.dockerResources
      .reloadDockerResource(TRAEFIK_CONTAINER_NAME, serverId)
      .catch((err) => {
        this.logger.error(
          `Traefik restart after Enable request metrics failed: ${String(err)}`,
        );
      });
    return { enabled: true };
  }
}
