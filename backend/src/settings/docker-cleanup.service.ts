import { isRetiredServer, notRetired } from '../bought-servers/retired-servers';
import { FrozenOrganizations } from '../cloud/billing/frozen-organizations.service';
import {
  Inject,
  Injectable,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { NotificationDispatcherService } from '../notifications/dispatcher.service';
import { member } from '../organizations/organizations.schema';
import type { PermissionCtx } from '../rbac/permission.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { server } from '../servers/server.schema';
import { CleanupService } from './cleanup.service';
import { LogCleanupService } from './log-cleanup.service';
import { SettingsService } from './settings.service';

/** When the nightly docker-cleanup cron fires: 23:50 every day. */
export const CLEANUP_CRON_JOB = '50 23 * * *';

const LOCAL_JOB_ID = 'docker-cleanup';
const serverJobId = (serverId: string) => `docker-cleanup:${serverId}`;

export interface UpdateDockerCleanupInput {
  enableDockerCleanup: boolean;
  // `string | null`, not `string | undefined`: the DTO hands the platform host
  // through as an explicit `null` now rather than 400ing on it, and the
  // `if (input.serverId)` below already read the two the same way.
  serverId?: string | null;
}

/**
 * The nightly docker-cleanup cron (updateDockerCleanup) and its boot
 * re-registration (initCronJobs): the local web server rides the
 * webServerSettings flag, remote servers their own column. Completed runs
 * notify through the docker-cleanup event — instance-wide for the local host,
 * the owning organization for servers.
 */
@Injectable()
export class DockerCleanupService implements OnApplicationBootstrap {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly scheduling: SchedulingService,
    private readonly cleanup: CleanupService,
    private readonly settings: SettingsService,
    private readonly logCleanup: LogCleanupService,
    private readonly dispatcher: NotificationDispatcherService,
    private readonly frozen: FrozenOrganizations,
  ) {}

  /**
   * Turns the nightly cleanup on or off for the platform host or one Server,
   * asking authority first and checking the Server's organization before any
   * write.
   *
   * The target forks the authority, as it does on every other route that takes
   * a `serverId` (H-63, ADR-0013). A named Server belongs to an organization
   * and is org-scoped below, so the caller's own owner/admin role is the right
   * question and has not moved. **An absent one writes `enableDockerCleanup` on
   * the `web_server_settings` singleton and registers `LOCAL_JOB_ID`**, a
   * nightly `cleanupAll()` on the platform host that prunes every
   * organization's images, containers and build cache at 23:50 — so that branch
   * takes instance authority. Both directions are writes: turning it *off* is
   * how a disk fills, turning it on is how another organization's cache
   * disappears nightly.
   */
  async updateDockerCleanup(
    ctx: PermissionCtx,
    input: UpdateDockerCleanupInput,
  ): Promise<void> {
    if (!input.serverId) {
      await this.settings.requireInstanceAuthority(ctx);
    } else {
      await this.settings.requireOwnerOrAdmin(ctx);
    }

    if (input.serverId) {
      const row = await this.db.query.server.findFirst({
        where: eq(server.serverId, input.serverId),
      });
      if (!row || row.organizationId !== ctx.session.activeOrganizationId) {
        throw new NotFoundException('Server not found');
      }

      if (input.enableDockerCleanup && row.serverStatus === 'inactive') {
        throw new NotFoundException('Server is inactive');
      }

      await this.db
        .update(server)
        .set({ enableDockerCleanup: input.enableDockerCleanup })
        .where(eq(server.serverId, input.serverId));

      if (input.enableDockerCleanup) {
        this.registerServerJob(input.serverId);
      } else {
        this.scheduling.unregister(serverJobId(input.serverId));
      }
      return;
    }

    const settings = await this.settings.updateWebServerSettings({
      enableDockerCleanup: input.enableDockerCleanup,
    });
    if (settings.enableDockerCleanup) {
      this.registerLocalJob();
    } else {
      this.scheduling.unregister(LOCAL_JOB_ID);
    }
  }

  /**
   * The local cron body: prune the web server, notify instance-wide.
   *
   * A run Docker kept busy past the deadline sends nothing: every channel
   * renders this event as "completed successfully", and it did not. The
   * skip is `CleanupService.cleanupAll`'s warn line in the backend's log;
   * the next night tries again.
   */
  async runLocalCleanup(): Promise<void> {
    const { skipped } = await this.cleanup.cleanupAll();
    if (skipped) return;
    await this.dispatcher.dispatch(null, {
      type: 'docker-cleanup',
      message: 'Docker cleanup for Cloudgate',
    });
  }

  /** The per-server cron body: prune over SSH, notify the owning org. */
  async runServerCleanup(serverId: string): Promise<void> {
    const row = await this.db.query.server.findFirst({
      where: eq(server.serverId, serverId),
    });
    // A Deleting or Deleted Bought Server is never cleaned up again: its
    // job goes, as a deleted Server's does (spec #1387).
    if (!row || (await isRetiredServer(this.db, serverId))) {
      this.scheduling.unregister(serverJobId(serverId));
      return;
    }
    // A Frozen Organization's Servers are not cleaned up (ADR-0052):
    // that night is skipped, and the next one asks again.
    if (await this.frozen.isFrozenAt({ organizationId: row.organizationId })) {
      return;
    }
    // As on the platform host: a skipped run is a log line, not a "completed".
    const { skipped } = await this.cleanup.cleanupAll(serverId);
    if (skipped) return;
    await this.dispatcher.dispatch(row.organizationId, {
      type: 'docker-cleanup',
      message: `Docker cleanup for Server ${row.name} (${serverId})`,
    });
  }

  private registerLocalJob(): void {
    this.scheduling.register(LOCAL_JOB_ID, CLEANUP_CRON_JOB, null, () =>
      this.runLocalCleanup(),
    );
  }

  private registerServerJob(serverId: string): void {
    this.scheduling.register(
      serverJobId(serverId),
      CLEANUP_CRON_JOB,
      null,
      () => this.runServerCleanup(serverId),
    );
  }

  /**
   * Boot: re-register the enabled docker-cleanup crons and the access-log
   * cleanup. Backup crons are the backups module's to re-register.
   */
  async initCronJobs(): Promise<void> {
    // Nothing is scheduled until an owner exists, so a fresh install has none.
    const admin = await this.db.query.member.findFirst({
      where: eq(member.role, 'owner'),
    });
    if (!admin) {
      return;
    }

    const settings = await this.settings.getWebServerSettings();

    if (settings.enableDockerCleanup) {
      this.registerLocalJob();
    }

    const servers = await this.db.query.server.findMany({
      where: notRetired(this.db, server.serverId),
    });
    for (const row of servers) {
      if (row.enableDockerCleanup) {
        this.registerServerJob(row.serverId);
      }
    }

    if (settings.logCleanupCron) {
      await this.logCleanup.start(settings.logCleanupCron);
    }
  }

  /** Boot re-registration, tolerant of an un-migrated database. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.initCronJobs();
    } catch (error) {
      console.error('Docker cleanup boot registration failed:', error);
    }
  }
}
