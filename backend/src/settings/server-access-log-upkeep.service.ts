import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { notRetired } from '../bought-servers/retired-servers';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { SchedulingService } from '../scheduling/scheduling.service';
import { server } from '../servers/server.schema';
import { TraefikFilesService } from './traefik-files.service';

/**
 * Hourly, at a minute of its own. Hourly so a busy Server's log is at most one
 * hour of traffic past `ACCESS_LOG_MAX_BYTES` before it is rotated (ADR-0057),
 * where the platform host's nightly `logCleanupCron` allowed a day. Off the
 * hour because every other hourly job and the nightly crons sit on `:00`, and
 * this reaches every Server.
 */
export const SERVER_ACCESS_LOG_UPKEEP_CRON = '23 * * * *';

export const SERVER_ACCESS_LOG_UPKEEP_JOB = 'server-access-log-upkeep';

/** What one tick did on one Server. */
export interface ServerAccessLogUpkeep {
  serverId: string;
  rotated: boolean;
  /** The older files deleted by age. */
  deleted: string[];
}

/**
 * Keeps every Server's Traefik access log bounded on the customer's disk
 * (ADR-0057): rotate past `ACCESS_LOG_MAX_BYTES` keeping `ACCESS_LOG_BACKUPS`
 * older files, and delete those older files once they are
 * `ACCESS_LOG_MAX_AGE_DAYS` past their last change.
 *
 * **No off switch, and not `LogCleanupService`.** Server rotation used to run
 * in that service's cron, which `logCleanupCron` and the Maintenance switch
 * govern — settings the Instance organization owns. On the Hosted instance one
 * switch there would let every customer's disk fill. So this job is armed at
 * boot, has no setting and no route, and `LogCleanupService` now rotates the
 * platform host's log only.
 *
 * **Every Server row, each tick**, but a Deleting or Deleted Bought
 * Server's, which nothing reaches any more (spec #1387). Rotation is gated per Server on its
 * traefik.yml having `accessLog` on (`rotateAccessLogOn`); deletion by age is
 * not gated (`deleteAgedAccessLogsOn`), so a Server that turned logging off is
 * still cleared of its older files until none are left. A Server with logging
 * off and nothing to delete costs two short execs an hour.
 *
 * **One Server at a time, each in its own try**, the shape `LogCleanupService`
 * had: an unreachable Server is logged by name and skipped, and checked again
 * at the next hour.
 *
 * Housekeeping on files this instance's Traefik writes on machines it
 * provisioned — no caller, no `PermissionCtx`, the same sense as
 * `DeploymentLogRetentionService`'s sweep over every `server` row.
 */
@Injectable()
export class ServerAccessLogUpkeepService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ServerAccessLogUpkeepService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly scheduling: SchedulingService,
    private readonly traefikFiles: TraefikFilesService,
  ) {}

  /** Arms the job at boot; a boot that cannot arm housekeeping still starts. */
  onApplicationBootstrap(): void {
    try {
      this.scheduling.register(
        SERVER_ACCESS_LOG_UPKEEP_JOB,
        SERVER_ACCESS_LOG_UPKEEP_CRON,
        'UTC',
        async () => {
          await this.tick();
        },
      );
    } catch (error) {
      this.logger.error('Server access-log upkeep could not be armed', error);
    }
  }

  /**
   * One pass over every Server. Resolves with what was done on each Server
   * that could be reached; an unreachable one is logged and left out.
   */
  async tick(): Promise<ServerAccessLogUpkeep[]> {
    // A Deleting or Deleted Bought Server is not reached (spec #1387).
    const servers = await this.db
      .select({ serverId: server.serverId, name: server.name })
      .from(server)
      .where(notRetired(this.db, server.serverId));
    const done: ServerAccessLogUpkeep[] = [];
    for (const row of servers) {
      try {
        const rotation = await this.traefikFiles.rotateAccessLogOn(
          row.serverId,
        );
        if (rotation.rotated && !rotation.reopened) {
          // Traefik is still appending to the backup until it restarts.
          this.logger.error(
            `Rotated the access log on Server ${row.name} at ${rotation.bytes} bytes but could not signal Traefik; it is still writing to ${rotation.backup}`,
          );
        }
        const deleted = await this.traefikFiles.deleteAgedAccessLogsOn(
          row.serverId,
        );
        done.push({
          serverId: row.serverId,
          rotated: rotation.rotated,
          deleted,
        });
      } catch (error) {
        this.logger.error(
          `Skipped access-log upkeep on Server ${row.name}: ${String(error)}`,
        );
      }
    }
    return done;
  }
}
