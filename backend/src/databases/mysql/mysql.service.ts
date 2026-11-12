import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { environment } from '../../environments/environment.schema';
import { project } from '../../projects/project.schema';
import type { PermissionCtx } from '../../rbac/permission.service';
import { server } from '../../servers/server.schema';
import { generateDatabasePassword } from '../common/database.constants';
import { RdsDatabaseService } from '../common/rds-database.service';
import type { CreateMysqlDto } from './dto/mysql.dto';
import { mysql } from './mysql.schema';
import type { Mysql } from './mysql.schema';

type MysqlNested = Mysql & {
  environment: typeof environment.$inferSelect & {
    project: typeof project.$inferSelect;
  };
  server: typeof server.$inferSelect | null;
};

/**
 * MySQL: a thin engine spec over the shared database base. On AWS it is an
 * RDS for MySQL instance, with everything a postgres on RDS has —
 * its Existing database, switch, RDS settings, Stop and Start — from the
 * same `RdsDatabaseService`.
 */
@Injectable()
export class MysqlService extends RdsDatabaseService<Mysql, MysqlNested> {
  protected readonly engineLabel = 'MySQL';
  protected readonly appNamePrefix = 'mysql';
  protected readonly serviceType = 'mysql' as const;
  protected readonly rdsKind = 'mysql' as const;
  protected readonly targetPort = 3306;
  protected readonly table = mysql;
  protected readonly columns = {
    id: mysql.mysqlId,
    appName: mysql.appName,
    environmentId: mysql.environmentId,
    serverId: mysql.serverId,
    applicationStatus: mysql.applicationStatus,
    configLinks: mysql.configLinks,
  };

  /** What its Outputs are built from, by the Outputs module's names. */
  protected readonly outputColumns = {
    databaseUser: 'user',
    databasePassword: 'password',
    databaseName: 'database',
  };

  /**
   * The root password is a second server-generated secret when omitted.
   * `caps` and `initial` are a Plan's: a plan-created database's
   * `size` and its Config name; the HTTP body carries neither. So is a
   * cloud place, as a postgres on RDS's: the id its plan read the
   * RDS instance with, its Cloud account and region, and the class
   * Cloudgate chose when it has no size. On RDS the root password is never
   * used: the master user is the config's `user`.
   */
  create(
    ctx: PermissionCtx,
    data: CreateMysqlDto & {
      cpuLimit?: string;
      memoryLimit?: string;
      mysqlId?: string;
      cloudAccountId?: string;
      region?: string;
      instanceClass?: string | null;
    },
    initial?: { configName: string },
  ) {
    return this.createDatabase(
      ctx,
      {
        ...data,
        databaseRootPassword:
          data.databaseRootPassword || generateDatabasePassword(),
      },
      initial,
    );
  }

  protected idOf(row: Mysql): string {
    return row.mysqlId;
  }

  protected queryById(mysqlId: string) {
    return this.db.query.mysql.findFirst({
      where: eq(mysql.mysqlId, mysqlId),
      with: {
        environment: { with: { project: true } },
        server: true,
      },
    });
  }

  /**
   * The image refuses to create a `root` user beside the one it already has, so
   * a `root` `databaseUser` gets the root password and no
   * `MYSQL_USER`/`MYSQL_PASSWORD` pair at all.
   *
   * Pairs rather than a dotenv body, for
   * {@link PostgresService.defaultEnv}' reason: `databaseName` and
   * `databaseUser` have no charset and were being interpolated into quoted
   * dotenv values. Both branches' keys are in `ENGINE_ENV_OWNERS.mysql`, which
   * is the union rather than either branch — the write refuses a name this
   * engine may emit for the row, and which branch a row is on is a column away
   * from changing.
   */
  protected defaultEnv(row: MysqlNested): Record<string, string> {
    if (row.databaseUser === 'root') {
      return {
        MYSQL_DATABASE: row.databaseName,
        MYSQL_ROOT_PASSWORD: row.databaseRootPassword,
      };
    }
    return {
      MYSQL_USER: row.databaseUser,
      MYSQL_DATABASE: row.databaseName,
      MYSQL_PASSWORD: row.databasePassword,
      MYSQL_ROOT_PASSWORD: row.databaseRootPassword,
    };
  }

  protected mountPath(): string {
    return '/var/lib/mysql';
  }
}
