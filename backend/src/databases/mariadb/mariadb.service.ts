import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { environment } from '../../environments/environment.schema';
import { project } from '../../projects/project.schema';
import type { PermissionCtx } from '../../rbac/permission.service';
import { server } from '../../servers/server.schema';
import { BaseDatabaseService } from '../common/database-service';
import { generateDatabasePassword } from '../common/database.constants';
import type { CreateMariadbDto } from './dto/mariadb.dto';
import { mariadb } from './mariadb.schema';
import type { Mariadb } from './mariadb.schema';

type MariadbNested = Mariadb & {
  environment: typeof environment.$inferSelect & {
    project: typeof project.$inferSelect;
  };
  server: typeof server.$inferSelect | null;
};

/** MariaDB: a thin engine spec over the shared database base. */
@Injectable()
export class MariadbService extends BaseDatabaseService<
  Mariadb,
  MariadbNested
> {
  protected readonly engineLabel = 'MariaDB';
  protected readonly appNamePrefix = 'mariadb';
  protected readonly serviceType = 'mariadb' as const;
  protected readonly targetPort = 3306;
  protected readonly table = mariadb;
  protected readonly columns = {
    id: mariadb.mariadbId,
    appName: mariadb.appName,
    environmentId: mariadb.environmentId,
    serverId: mariadb.serverId,
    applicationStatus: mariadb.applicationStatus,
  };

  /** The root password is a second server-generated secret when omitted. */
  create(ctx: PermissionCtx, data: CreateMariadbDto) {
    return this.createDatabase(ctx, {
      ...data,
      databaseRootPassword:
        data.databaseRootPassword || generateDatabasePassword(),
    });
  }

  protected idOf(row: Mariadb): string {
    return row.mariadbId;
  }

  protected queryById(mariadbId: string) {
    return this.db.query.mariadb.findFirst({
      where: eq(mariadb.mariadbId, mariadbId),
      with: {
        environment: { with: { project: true } },
        server: true,
      },
    });
  }

  /**
   * The image's own entrypoint reads all four at first boot, and they are what
   * an application in the same network reads to build a connection string.
   *
   * Pairs rather than a dotenv body, for
   * {@link PostgresService.defaultEnv}' reason.
   */
  protected defaultEnv(row: MariadbNested): Record<string, string> {
    return {
      MARIADB_DATABASE: row.databaseName,
      MARIADB_USER: row.databaseUser,
      MARIADB_PASSWORD: row.databasePassword,
      MARIADB_ROOT_PASSWORD: row.databaseRootPassword,
    };
  }

  protected mountPath(): string {
    return '/var/lib/mysql';
  }
}
