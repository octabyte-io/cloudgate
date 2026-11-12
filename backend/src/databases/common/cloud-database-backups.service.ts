import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { rdsInstanceIdentifier } from '../../cloud-accounts/aws/definitions/postgres-definition';
import { replicationGroupIdentifier } from '../../cloud-accounts/aws/definitions/redis-definition';
import { CloudAccountsService } from '../../cloud-accounts/cloud-accounts.service';
import { onCloud } from '../../cloud-accounts/cloud-provider';
import type {
  AwsCloudAccount,
  GcpCloudAccount,
} from '../../cloud-accounts/cloud-provider';
import { AWS_CLOUD_PORT } from '../../cloud-accounts/cloud.port';
import type {
  AwsAnswer,
  AwsCloudPort,
  CacheBackups,
  DatabaseSnapshot,
  RdsBackups,
} from '../../cloud-accounts/cloud.port';
import { googleRefusalReason } from '../../cloud-accounts/gcp/api-off';
import { serviceName } from '../../cloud-accounts/gcp/definitions/names';
import {
  GOOGLE_CLOUD_PORT,
  NOT_FOUND,
  PERMISSION_DENIED,
} from '../../cloud-accounts/google-cloud.port';
import type {
  CloudSqlBackups,
  GoogleAccessToken,
  GoogleAnswer,
  GoogleCloudPort,
  GoogleDatabaseRef,
  MemorystoreBackups,
} from '../../cloud-accounts/google-cloud.port';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { environment } from '../../environments/environment.schema';
import { project } from '../../projects/project.schema';
import { PermissionService } from '../../rbac/permission.service';
import type { PermissionCtx } from '../../rbac/permission.service';
import { mysql } from '../mysql/mysql.schema';
import { postgres } from '../postgres/postgres.schema';
import { redis } from '../redis/redis.schema';

/** The kinds of database a Cloud account runs. */
export type CloudDatabaseKind = 'postgres' | 'mysql' | 'redis';

/**
 * A cloud database's Backups tab (on Google Cloud too): what its
 * cloud holds, read live, beside the retention Cloudgate keeps for it.
 */
export interface CloudDatabaseBackupsView {
  /**
   * RDS for a postgres or a mysql, ElastiCache for a redis on AWS; Cloud
   * SQL for a postgres, Memorystore for a redis on Google Cloud.
   */
  engine: 'rds' | 'elasticache' | 'cloud-sql' | 'memorystore';
  /** Its name in its cloud: the RDS instance, the replication group, or the Google instance. */
  identifier: string;
  region: string;
  /**
   * Whether its cloud has it yet. Until its first Cloud run makes it, there
   * is nothing to list, and every live field below is empty.
   */
  made: boolean;
  /**
   * Cloudgate's retention, in days (RDS 1–35; ElastiCache 0–35, 0 = off;
   * Cloud SQL 1–365; Memorystore 0–365, 0 = off): edited on this tab
   * through the Service's settings and applied by the next Cloud run.
   */
  retentionDays: number;
  /** The retention its cloud runs with now; `null` until it is made. */
  liveRetentionDays: number | null;
  /**
   * The window a restore reaches: point-in-time restore's on RDS and Cloud
   * SQL; on Memorystore, its oldest and newest backup. `null` on
   * ElastiCache. Either end is `null` until the first backup is taken.
   */
  restorableWindow: { earliest: string | null; latest: string | null } | null;
  /** Its cloud's automatic and kept snapshots or backups, newest first. */
  snapshots: DatabaseSnapshot[];
  /**
   * The instance in its cloud's console, where a restore is made (RDS,
   * Cloud SQL and Memorystore). Cloudgate has no Restore button: a restore
   * makes a new instance.
   */
  consoleUrl: string | null;
}

/** AWS's refusal of a database it does not have (yet). */
const NOT_MADE = new Set([
  'DBInstanceNotFoundFault',
  'DBInstanceNotFound',
  'ReplicationGroupNotFoundFault',
  'ReplicationGroupNotFound',
]);

/** A refusal that says the deploy role may not read: the Cloud account's to fix. */
const DENIED = /AccessDenied|Unauthorized|InvalidClientTokenId|ExpiredToken/;

/** The instance in the RDS console, in its region. */
export function rdsConsoleUrl(region: string, identifier: string): string {
  return `https://${region}.console.aws.amazon.com/rds/home?region=${region}#database:id=${identifier};is-cluster=false`;
}

/** A Cloud SQL instance's backups page in the Google Cloud console. */
export function cloudSqlConsoleUrl(projectId: string, name: string): string {
  return `https://console.cloud.google.com/sql/instances/${name}/backups?project=${projectId}`;
}

/** A Memorystore for Valkey instance in the Google Cloud console. */
export function memorystoreConsoleUrl(
  projectId: string,
  region: string,
  name: string,
): string {
  return `https://console.cloud.google.com/memorystore/valkey/locations/${region}/instances/${name}/details?project=${projectId}`;
}

/** A cloud database's name, place and retention, as its table holds them. */
interface Place {
  name: string;
  configName: string | null;
  cloudAccountId: string | null;
  region: string | null;
  retentionDays: number;
  /** Its retention on Google Cloud, where a redis keeps its own. */
  googleRetentionDays: number;
}

/** A cloud database's place once it is known to be in a Cloud account. */
type Placed = Omit<Place, 'configName' | 'cloudAccountId' | 'region'> & {
  cloudAccountId: string;
  region: string;
};

/**
 * What differs between RDS and ElastiCache on the Backups tab, once per
 * engine, so the read itself never asks which it has.
 */
interface Engine {
  readonly engine: 'rds' | 'elasticache';
  readonly notFound: string;
  identifier(serviceId: string): string;
  backups(
    cloud: AwsCloudPort,
    session: Parameters<AwsCloudPort['rdsBackups']>[0],
    ref: { region: string; identifier: string },
  ): Promise<AwsAnswer<RdsBackups | CacheBackups>>;
  /** Point-in-time restore's window before AWS answers: RDS only. */
  readonly emptyWindow: CloudDatabaseBackupsView['restorableWindow'];
  consoleUrl(region: string, identifier: string): string | null;
  place(
    db: DrizzleDB,
    organizationId: string,
    serviceId: string,
  ): Promise<Place[]>;
}

const ENGINES: Record<CloudDatabaseKind, Engine> = {
  postgres: {
    engine: 'rds',
    notFound: 'Postgres not found',
    identifier: rdsInstanceIdentifier,
    backups: (cloud, session, ref) => cloud.rdsBackups(session, ref),
    emptyWindow: { earliest: null, latest: null },
    consoleUrl: rdsConsoleUrl,
    place: (db, organizationId, serviceId) =>
      db
        .select({
          name: postgres.name,
          configName: postgres.configName,
          cloudAccountId: postgres.cloudAccountId,
          region: postgres.region,
          retentionDays: postgres.backupRetentionDays,
          googleRetentionDays: postgres.backupRetentionDays,
        })
        .from(postgres)
        .innerJoin(
          environment,
          eq(environment.environmentId, postgres.environmentId),
        )
        .innerJoin(project, eq(project.projectId, environment.projectId))
        .where(
          and(
            eq(postgres.postgresId, serviceId),
            eq(project.organizationId, organizationId),
          ),
        ),
  },
  // A mysql on RDS's tab is a postgres's, from its own table.
  mysql: {
    engine: 'rds',
    notFound: 'MySQL not found',
    identifier: rdsInstanceIdentifier,
    backups: (cloud, session, ref) => cloud.rdsBackups(session, ref),
    emptyWindow: { earliest: null, latest: null },
    consoleUrl: rdsConsoleUrl,
    place: (db, organizationId, serviceId) =>
      db
        .select({
          name: mysql.name,
          configName: mysql.configName,
          cloudAccountId: mysql.cloudAccountId,
          region: mysql.region,
          retentionDays: mysql.backupRetentionDays,
          googleRetentionDays: mysql.backupRetentionDays,
        })
        .from(mysql)
        .innerJoin(
          environment,
          eq(environment.environmentId, mysql.environmentId),
        )
        .innerJoin(project, eq(project.projectId, environment.projectId))
        .where(
          and(
            eq(mysql.mysqlId, serviceId),
            eq(project.organizationId, organizationId),
          ),
        ),
  },
  redis: {
    engine: 'elasticache',
    notFound: 'Redis not found',
    identifier: replicationGroupIdentifier,
    backups: (cloud, session, ref) => cloud.cacheBackups(session, ref),
    emptyWindow: null,
    consoleUrl: () => null,
    place: (db, organizationId, serviceId) =>
      db
        .select({
          name: redis.name,
          configName: redis.configName,
          cloudAccountId: redis.cloudAccountId,
          region: redis.region,
          retentionDays: redis.snapshotRetentionDays,
          googleRetentionDays: redis.memorystoreBackupRetentionDays,
        })
        .from(redis)
        .innerJoin(
          environment,
          eq(environment.environmentId, redis.environmentId),
        )
        .innerJoin(project, eq(project.projectId, environment.projectId))
        .where(
          and(
            eq(redis.redisId, serviceId),
            eq(project.organizationId, organizationId),
          ),
        ),
  },
};

/**
 * What differs between Cloud SQL and Memorystore on the Backups tab
 * once per engine, as {@link Engine} is on AWS: a postgres and a
 * mysql on Cloud SQL alike. A kind with none is refused by name.
 */
interface GoogleEngine {
  readonly engine: 'cloud-sql' | 'memorystore';
  backups(
    google: GoogleCloudPort,
    token: GoogleAccessToken,
    ref: GoogleDatabaseRef,
  ): Promise<GoogleAnswer<CloudSqlBackups | MemorystoreBackups>>;
  window(
    held: CloudSqlBackups | MemorystoreBackups,
  ): NonNullable<CloudDatabaseBackupsView['restorableWindow']>;
  consoleUrl(ref: GoogleDatabaseRef): string;
}

/** Cloud SQL's tab, a postgres's and a mysql's alike. */
const CLOUD_SQL_ENGINE: GoogleEngine = {
  engine: 'cloud-sql',
  backups: (google, token, ref) => google.cloudSqlBackups(token, ref),
  window: (held) =>
    'latestRestorableTime' in held
      ? {
          earliest: held.earliestRestorableTime,
          latest: held.latestRestorableTime,
        }
      : { earliest: null, latest: null },
  consoleUrl: (ref) => cloudSqlConsoleUrl(ref.projectId, ref.name),
};

const GOOGLE_ENGINES: Readonly<
  Partial<Record<CloudDatabaseKind, GoogleEngine>>
> = {
  postgres: CLOUD_SQL_ENGINE,
  mysql: CLOUD_SQL_ENGINE,
  // Memorystore restores a backup, never a moment: its window is the
  // oldest and the newest backup it holds.
  redis: {
    engine: 'memorystore',
    backups: (google, token, ref) => google.memorystoreBackups(token, ref),
    window: (held) => {
      const taken = held.backups
        .map((backup) => backup.createdAt)
        .filter((at): at is string => at !== null)
        .sort();
      return { earliest: taken[0] ?? null, latest: taken.at(-1) ?? null };
    },
    consoleUrl: (ref) =>
      memorystoreConsoleUrl(ref.projectId, ref.region, ref.name),
  },
};

/**
 * **The Backups tab of a cloud database**: a postgres on
 * RDS or a redis on ElastiCache keeps its backups the provider's own way,
 * so the tab reads them from AWS each time through the cloud port, with the
 * Cloud account's deploy role — never a plan, and nothing kept. On Google
 * Cloud it copies AWS through the cloud seam: a
 * postgres on Cloud SQL or a redis on Memorystore is read through the
 * Google client port with the deploy service account. Dump backups to a
 * Destination are Server-only (`server-only-dumps.ts`).
 *
 * Gated as a backup's read is (`backup: read`, on the route) and on the
 * Service (`service: read`). The cloud's refusal is a 400 naming the Cloud
 * account and the cloud's words; a sign-in that is refused, or a read its
 * role denies, is recorded on the Cloud account. The cloud not
 * answering is a 502.
 */
@Injectable()
export class CloudDatabaseBackupsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(AWS_CLOUD_PORT) private readonly cloud: AwsCloudPort,
    @Inject(GOOGLE_CLOUD_PORT) private readonly google: GoogleCloudPort,
    private readonly permissions: PermissionService,
    private readonly cloudAccounts: CloudAccountsService,
  ) {}

  async read(
    ctx: PermissionCtx,
    kind: CloudDatabaseKind,
    serviceId: string,
  ): Promise<CloudDatabaseBackupsView> {
    await this.permissions.checkServiceAccess(ctx, serviceId, 'read');
    const engine = ENGINES[kind];
    const found = await this.place(
      ctx.session.activeOrganizationId,
      engine,
      serviceId,
    );
    const { name, cloudAccountId, region } = found;
    if (!cloudAccountId || !region) {
      throw new BadRequestException(
        `${name} runs on a Server; its backups are dumps to a Destination`,
      );
    }
    const cloudAccountRow = await this.cloudAccounts.findForUse(cloudAccountId);
    if (!cloudAccountRow) {
      throw new BadRequestException(
        `The Cloud account ${name} runs in is gone, so its backups cannot be read`,
      );
    }
    const placed: Placed = { ...found, cloudAccountId, region };
    return onCloud<Promise<CloudDatabaseBackupsView>>(cloudAccountRow, {
      aws: (account) => this.readAws(engine, placed, serviceId, account),
      gcp: (account) =>
        this.readGoogle(GOOGLE_ENGINES[kind], placed, serviceId, account),
    });
  }

  /** RDS's or ElastiCache's backups, through the deploy role. */
  private async readAws(
    engine: Engine,
    found: Placed,
    serviceId: string,
    account: AwsCloudAccount,
  ): Promise<CloudDatabaseBackupsView> {
    const { name, cloudAccountId, region } = found;
    const session = await this.cloudAccounts.deployRoleSession(account);
    if (!session.ok) throw new BadRequestException(session.refusal);

    const identifier = engine.identifier(serviceId);
    const answer = await engine
      .backups(this.cloud, session.session, { region, identifier })
      .catch((error: unknown) => {
        throw new BadGatewayException(
          `AWS could not be reached for Cloud account ${account.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

    const view: CloudDatabaseBackupsView = {
      engine: engine.engine,
      identifier,
      region,
      made: false,
      retentionDays: found.retentionDays,
      liveRetentionDays: null,
      restorableWindow: engine.emptyWindow,
      snapshots: [],
      consoleUrl: engine.consoleUrl(region, identifier),
    };
    if (!answer.ok) {
      // Before its first Cloud run makes it, AWS has nothing: an empty tab.
      if (NOT_MADE.has(answer.code)) return view;
      const words = `${answer.code}: ${answer.message}`;
      if (DENIED.test(answer.code)) {
        await this.cloudAccounts.recordUseFailure(cloudAccountId, words);
      }
      throw new BadRequestException(
        `Cloud account ${account.name} could not read the backups of ${name}: AWS answered ${words}`,
      );
    }
    const held = answer.value;
    return {
      ...view,
      made: true,
      liveRetentionDays: held.retentionDays,
      restorableWindow:
        'latestRestorableTime' in held
          ? {
              earliest: held.earliestRestorableTime,
              latest: held.latestRestorableTime,
            }
          : null,
      snapshots: held.snapshots,
    };
  }

  /**
   * Cloud SQL's or Memorystore's backups, through the deploy service
   * account: the same tab as AWS's, read the same way.
   */
  private async readGoogle(
    engine: GoogleEngine | undefined,
    found: Placed,
    serviceId: string,
    account: GcpCloudAccount,
  ): Promise<CloudDatabaseBackupsView> {
    const { name, cloudAccountId, region } = found;
    if (!engine) {
      throw new BadRequestException(
        `Cloud account ${account.name} is a Google Cloud project, and the backups of ${name} are not available on Google Cloud yet`,
      );
    }
    const session = await this.cloudAccounts.googleRunSession(account);
    if (!session.ok) throw new BadRequestException(session.refusal);

    const ref: GoogleDatabaseRef = {
      projectId: account.cloudId,
      region,
      name: serviceName(serviceId),
    };
    const answer = await engine
      .backups(this.google, session.token, ref)
      .catch((error: unknown) => {
        throw new BadGatewayException(
          `Google Cloud could not be reached for Cloud account ${account.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

    const view: CloudDatabaseBackupsView = {
      engine: engine.engine,
      identifier: ref.name,
      region,
      made: false,
      retentionDays: found.googleRetentionDays,
      liveRetentionDays: null,
      restorableWindow: { earliest: null, latest: null },
      snapshots: [],
      consoleUrl: engine.consoleUrl(ref),
    };
    if (!answer.ok) {
      // Before its first Cloud run makes it, Google has nothing: an empty tab.
      if (answer.code === NOT_FOUND) return view;
      const words = `${answer.code}: ${googleRefusalReason(answer.message, account.cloudId)}`;
      if (answer.code === PERMISSION_DENIED) {
        await this.cloudAccounts.recordUseFailure(cloudAccountId, words);
      }
      throw new BadRequestException(
        `Cloud account ${account.name} could not read the backups of ${name}: Google Cloud answered ${words}`,
      );
    }
    const held = answer.value;
    return {
      ...view,
      made: true,
      liveRetentionDays: held.retentionDays,
      restorableWindow: engine.window(held),
      snapshots: held.backups,
    };
  }

  /** The database's name, place and retention, scoped to the Organization. */
  private async place(
    organizationId: string,
    engine: Engine,
    serviceId: string,
  ): Promise<Omit<Place, 'configName'>> {
    const [found] = await engine.place(this.db, organizationId, serviceId);
    if (!found) throw new NotFoundException(engine.notFound);
    return { ...found, name: found.configName ?? found.name };
  }
}
