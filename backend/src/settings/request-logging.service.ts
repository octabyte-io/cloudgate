import {
  BadGatewayException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
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
import type { ToggleRequestsResult } from './traefik-files.service';

/** The route this service audits for, named in each row's metadata. */
const ROUTE = 'POST /settings/traefik/requests';

/**
 * The **Access log** switch on one machine: `POST /settings/traefik/requests`.
 *
 * **On a Server it is one action.** It writes `traefik.yml` and
 * restarts that Server's Traefik in the same request, because `accessLog` is
 * static configuration and a write alone leaves logging reading "on" while
 * nothing is recorded. The console asks first, in the Request logging card's
 * confirmation, which is where the 80/443 drop is said — the switch is the
 * restart, the way Enable request metrics is. The write also keeps only the
 * User-Agent header (`SERVER_ACCESS_LOG_FIELDS`, ADR-0055).
 *
 * **On the platform host it is the two steps it always was**: the write, with
 * `restartRequired: true` in the answer, and `POST /settings/traefik/reload`
 * as the separate, named restart. Its headers and its restart are outside
 * the Requests work.
 *
 * **Audited here, not by the interceptor**, for both machines: an `update
 * server` row naming the machine (the Server's id and name, or `local` and
 * `platform host`) and the change, the way `RequestMetricsService` writes
 * them. The path alone could say neither. Written once the file is, so a 404
 * records nothing.
 *
 * Authorization is the caller's: the route takes the Traefik restart gate
 * (`traefikTargetAuthority`) — owner/admin of the Server's Organization plus
 * `checkServerAccess`, which scopes to the active Organization and so gives
 * the Instance organization no way onto a customer's Server.
 */
@Injectable()
export class RequestLoggingService {
  private readonly logger = new Logger(RequestLoggingService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly traefikFiles: TraefikFilesService,
    private readonly dockerResources: DockerResourceService,
    private readonly auditLogs: AuditLogService,
  ) {}

  /**
   * Turn the Access log on or off. A Server's answer is `restartRequired:
   * false` once its Traefik **has** restarted; the platform host's is `true`,
   * as before.
   *
   * **The Server's restart is awaited.** It was fire-and-forget, as
   * `POST /settings/traefik/reload`'s is, and answered before it had run, so a
   * restart that failed left `traefik.yml` saying "on" and Traefik recording
   * nothing, with a success in the console. The reload's reason for not
   * waiting — Traefik drops the connection the answer would travel on — is
   * the platform host's: a Server's Traefik is not on the console's path. A
   * failed restart answers 502 saying the file was written and Traefik did
   * not restart, so the person can try again; the write and its audit row
   * stand, being true.
   */
  async toggle(
    ctx: PermissionCtx,
    enable: boolean,
    serverId: string | null,
    ip?: string,
  ): Promise<ToggleRequestsResult> {
    const written = await this.traefikFiles.toggleRequests(enable, serverId);
    const serverName = await this.nameOf(serverId);
    await this.audit(ctx, enable, serverId, serverName, ip);
    if (!serverId) return written;

    try {
      await this.dockerResources.reloadDockerResource(
        TRAEFIK_CONTAINER_NAME,
        serverId,
      );
    } catch (err) {
      this.logger.error(
        `Traefik restart after turning request logging ${enable ? 'on' : 'off'} failed: ${String(err)}`,
      );
      throw new BadGatewayException(
        `Request logging is ${enable ? 'on' : 'off'} in traefik.yml on ${serverName}, but Traefik did not restart, so it is still ${enable ? 'not recording' : 'recording'} requests. Try again, or restart Traefik from the Server's Traefik settings.`,
      );
    }
    return { written: written.written, restartRequired: false };
  }

  /** The machine as the audit row and a refusal name it. */
  private async nameOf(serverId: string | null): Promise<string> {
    if (!serverId) return 'platform host';
    const [row] = await this.db
      .select({ name: server.name })
      .from(server)
      .where(eq(server.serverId, serverId))
      .limit(1);
    return row?.name ?? serverId;
  }

  private async audit(
    ctx: PermissionCtx,
    enable: boolean,
    serverId: string | null,
    serverName: string,
    ip?: string,
  ): Promise<void> {
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
          route: ROUTE,
          change: enable
            ? 'Turn on request logging'
            : 'Turn off request logging',
        },
      },
    );
  }
}
