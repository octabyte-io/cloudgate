import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import type { PermissionCtx } from '../rbac/permission.service';
import { boughtServer } from './bought-server.schema';
import { BoughtServersConfig } from './bought-servers.config';
import { HETZNER_MACHINES } from './hetzner/hetzner-cloud.port';
import type { HetznerCloudPort } from './hetzner/hetzner-cloud.port';

/** One **Server backup**, as the Server's settings list it. */
export interface ServerBackupView {
  /** What a later restore names. */
  id: number;
  /** When the provider took it, ISO 8601 in UTC. */
  takenAt: string;
  /** GB it takes; null while it is still being made. */
  sizeGb: number | null;
  /** The provider is still making it, so it cannot be restored yet. */
  beingMade: boolean;
}

/** Said when the provider gave no list: its own code and words are logged, never shown. */
export const BACKUPS_UNREADABLE =
  "This Server's backups can't be read right now";

/**
 * A Bought Server's **Server backups** (ADR-0093): the copies of its disk
 * the provider keeps while its backups are on. Only read here; the provider
 * makes the daily ones by itself.
 *
 * A read, so a frozen Organization still sees them (a `GET` is never
 * frozen). What is answered is Cloudgate's shape, never the provider's: its
 * description and status words stay behind the port (ADR-0071).
 */
@Injectable()
export class BoughtServerBackups {
  private readonly logger = new Logger(BoughtServerBackups.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(HETZNER_MACHINES) private readonly machines: HetznerCloudPort,
    private readonly config: BoughtServersConfig,
  ) {}

  /**
   * Every Server backup, newest first, org-scoped through the Bought
   * Server's own row. With backups off there are none (turning them off
   * deletes every one), so the provider is not asked.
   */
  async list(ctx: PermissionCtx, id: string): Promise<ServerBackupView[]> {
    if (this.config.offer === 'absent') throw new NotFoundException();
    const [row] = await this.db
      .select({
        backups: boughtServer.backups,
        providerServerId: boughtServer.providerServerId,
      })
      .from(boughtServer)
      .where(
        and(
          eq(boughtServer.id, id),
          eq(boughtServer.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException('Server not found');
    if (!row.backups || row.providerServerId === null) return [];

    const answer = await this.machines.listBackups(row.providerServerId);
    if (!answer.ok) {
      this.logger.error(
        `The provider refused the backups of machine ${row.providerServerId}: ${answer.code}: ${answer.message}`,
      );
      throw new ServiceUnavailableException(BACKUPS_UNREADABLE);
    }
    return answer.value
      .map((backup) => ({
        id: backup.id,
        takenAt: new Date(backup.created).toISOString(),
        sizeGb: backup.imageSizeGb,
        beingMade: backup.status === 'creating',
      }))
      .sort((a, b) => b.takenAt.localeCompare(a.takenAt));
  }
}
