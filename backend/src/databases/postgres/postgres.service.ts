import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { environment } from '../../environments/environment.schema';
import { project } from '../../projects/project.schema';
import type { PermissionCtx } from '../../rbac/permission.service';
import { server } from '../../servers/server.schema';
import { RdsDatabaseService } from '../common/rds-database.service';
import type { CreatePostgresDto } from './dto/postgres.dto';
import { postgres } from './postgres.schema';
import type { Postgres } from './postgres.schema';

export { rdsStopView } from '../common/cloud-database-stop';
export type { RdsStopView } from '../common/cloud-database-stop';

/**
 * PostgreSQL 18+ moved the default PGDATA to
 * /var/lib/postgresql/{version}/docker.
 */
export function getPostgresMountPath(dockerImage: string): string {
  const versionMatch = dockerImage.match(/postgres:(\d+)/);
  if (versionMatch?.[1]) {
    const version = Number.parseInt(versionMatch[1], 10);
    if (version >= 18) {
      return `/var/lib/postgresql/${version}/docker`;
    }
  }
  return '/var/lib/postgresql/data';
}

type PostgresNested = Postgres & {
  environment: typeof environment.$inferSelect & {
    project: typeof project.$inferSelect;
  };
  server: typeof server.$inferSelect | null;
};

/**
 * The first managed database engine, a thin spec over the shared database
 * base. What it has on RDS — its Existing database, switch, RDS
 * settings, Stop and Start — is `RdsDatabaseService`'s, shared with a mysql
 * on RDS.
 */
@Injectable()
export class PostgresService extends RdsDatabaseService<
  Postgres,
  PostgresNested
> {
  protected readonly engineLabel = 'Postgres';
  protected readonly appNamePrefix = 'postgres';
  protected readonly serviceType = 'postgres' as const;
  protected readonly rdsKind = 'postgres' as const;
  protected readonly targetPort = 5432;
  protected readonly table = postgres;
  protected readonly columns = {
    id: postgres.postgresId,
    appName: postgres.appName,
    environmentId: postgres.environmentId,
    serverId: postgres.serverId,
    applicationStatus: postgres.applicationStatus,
    configLinks: postgres.configLinks,
  };

  /** What its Outputs are built from, by the Outputs module's names. */
  protected readonly outputColumns = {
    databaseUser: 'user',
    databasePassword: 'password',
    databaseName: 'database',
  };

  /**
   * `caps` and `initial` are a Plan's: a plan-created database's
   * `size` and its Config name; the HTTP body carries neither. So is a cloud
   * place: the id its plan read the RDS instance with, its Cloud
   * account and region, and the class Cloudgate chose when it has no size.
   */
  create(
    ctx: PermissionCtx,
    data: CreatePostgresDto & {
      cpuLimit?: string;
      memoryLimit?: string;
      postgresId?: string;
      cloudAccountId?: string;
      region?: string;
      instanceClass?: string | null;
    },
    initial?: { configName: string },
  ) {
    return this.createDatabase(ctx, { ...data }, initial);
  }

  protected idOf(row: Postgres): string {
    return row.postgresId;
  }

  protected queryById(postgresId: string) {
    return this.db.query.postgres.findFirst({
      where: eq(postgres.postgresId, postgresId),
      with: {
        environment: { with: { project: true } },
        server: true,
      },
    });
  }

  /**
   * The image's own entrypoint reads all three at first boot, and they are what
   * an application in the same network reads to build a connection string.
   *
   * Pairs rather than a dotenv body — `databaseName` carrying a `"`
   * and a newline used to write extra keys into `ContainerSpec.Env`, and
   * `POSTGRES_HOST_AUTH_METHOD=trust` was among the ones it could write.
   * `common/reserved-env.ts`' `withEngineEnv` carries the measurement.
   */
  protected defaultEnv(row: PostgresNested): Record<string, string> {
    return {
      POSTGRES_DB: row.databaseName,
      POSTGRES_USER: row.databaseUser,
      POSTGRES_PASSWORD: row.databasePassword,
    };
  }

  protected mountPath(row: PostgresNested): string {
    return getPostgresMountPath(row.dockerImage);
  }
}
