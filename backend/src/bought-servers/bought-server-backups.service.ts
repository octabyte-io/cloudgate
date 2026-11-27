import {
  ConflictException,
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
import { NOT_CHANGEABLE_CODE } from './bought-server-changes.service';
import { boughtServer } from './bought-server.schema';
import { BoughtServersConfig } from './bought-servers.config';
import { HETZNER_MACHINES } from './hetzner/hetzner-cloud.port';
import type {
  HetznerBackup,
  HetznerCloudPort,
} from './hetzner/hetzner-cloud.port';

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

/** Said when the provider would not take a backup: its own code and words are logged, never shown. */
export const BACKUP_NOT_TAKEN =
  "This Server can't be backed up right now. Try again later";

export const BACKUPS_OFF_CODE = 'BACKUPS_OFF';

/**
 * A Bought Server's **Server backups** (ADR-0093): the copies of its disk
 * the provider keeps while its backups are on. The provider makes the daily
 * ones by itself; **Back up now** asks it for one more.
 *
 * The list is a read, so a frozen Organization still sees it (a `GET` is
 * never frozen); Back up now is a write, which `FrozenGuard` refuses while
 * it is frozen. What is answered is Cloudgate's shape, never the provider's:
 * its description and status words stay behind the port (ADR-0071).
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
    const row = await this.ownRow(ctx, id);
    if (!row.backups || row.providerServerId === null) return [];

    const answer = await this.machines.listBackups(row.providerServerId);
    if (!answer.ok) {
      this.logger.error(
        `The provider refused the backups of machine ${row.providerServerId}: ${answer.code}: ${answer.message}`,
      );
      throw new ServiceUnavailableException(BACKUPS_UNREADABLE);
    }
    return answer.value
      .map(viewOf)
      .sort((a, b) => b.takenAt.localeCompare(a.takenAt));
  }

  /**
   * **Back up now**: one more Server backup at once, still being made when
   * this answers. A backup, not a snapshot, so it takes one of the same 7
   * slots and costs nothing: once all 7 are full the provider pushes out the
   * oldest, which the console's confirmation names. No limit, and a deletion
   * date does not refuse it, since it costs nothing (ADR-0093). Refused
   * unless the Server is Ready and its backups are on.
   */
  async create(ctx: PermissionCtx, id: string): Promise<ServerBackupView> {
    const row = await this.ownRow(ctx, id);
    if (
      row.stage !== 'ready' ||
      row.serverId === null ||
      row.providerServerId === null
    ) {
      throw new ConflictException({
        code: NOT_CHANGEABLE_CODE,
        message: "This Server can't be backed up until it is Ready",
      });
    }
    if (!row.backups) {
      throw new ConflictException({
        code: BACKUPS_OFF_CODE,
        message: 'Turn backups on to back up this Server',
      });
    }

    const answer = await this.machines.createBackup(
      row.providerServerId,
      'Back up now',
    );
    if (!answer.ok) {
      this.logger.error(
        `The provider refused a backup of machine ${row.providerServerId}: ${answer.code}: ${answer.message}`,
      );
      throw new ServiceUnavailableException(BACKUP_NOT_TAKEN);
    }
    return viewOf(answer.value.backup);
  }

  /** The Bought Server's own row, org-scoped; a bare 404 where the feature is absent. */
  private async ownRow(ctx: PermissionCtx, id: string) {
    if (this.config.offer === 'absent') throw new NotFoundException();
    const [row] = await this.db
      .select({
        stage: boughtServer.stage,
        serverId: boughtServer.serverId,
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
    return row;
  }
}

/** Cloudgate's shape of a backup: the provider's description and words stay behind. */
function viewOf(backup: HetznerBackup): ServerBackupView {
  return {
    id: backup.id,
    takenAt: new Date(backup.created).toISOString(),
    sizeGb: backup.imageSizeGb,
    beingMade: backup.status === 'creating',
  };
}
