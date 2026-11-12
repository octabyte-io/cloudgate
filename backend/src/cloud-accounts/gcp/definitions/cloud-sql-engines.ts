import type { PlanRefusal } from '../../../project-config';
import {
  defaultDatabaseIdentifier,
  defaultPostgresUser,
} from '../../../project-config/format/config-wire';
import {
  RDS_MYSQL_DEFAULT,
  rdsMysqlVersion,
} from '../../aws/definitions/mysql-version';
import type { MysqlOffer } from '../../aws/definitions/mysql-version';
import { CLOUD_SQL_SWITCHES } from './cloud-sql-switches';
import {
  RDS_POSTGRES_MAJORS,
  rdsPostgresVersion,
} from '../../aws/definitions/postgres-version';
import type {
  PostgresOffer,
  RdsPostgresVersion,
  RdsPostgresVersionReading,
} from '../../aws/definitions/postgres-version';

/** The config kinds Cloud SQL makes. */
export type CloudSqlEngineName = 'postgres' | 'mysql';

/**
 * What differs between a `postgres` and a `mysql` on Cloud SQL (the Google
 * Cloud kinds spec "`mysql` on Cloud SQL"): the parameters of the one Cloud SQL
 * definition, planner and lookup, as `RDS_ENGINES` is on AWS.
 * Everything else — size to machine, the Enterprise edition, Private Service
 * Connect, backups and point-in-time recovery, deletion protection, Delete's
 * hand-made backup, Stop and Start, an existing instance — is the same code
 * for both.
 */
export interface CloudSqlEngine {
  readonly engine: CloudSqlEngineName;
  /** How a plan line and a refusal name it: `PostgreSQL`, `MySQL`. */
  readonly label: (typeof CLOUD_SQL_SWITCHES)[CloudSqlEngineName]['label'];
  /** The port it answers on, direct TCP through its private link. */
  readonly port: number;
  /**
   * Its `ssl_mode`, always written, never left to Google's default:
   * `postgres` takes encrypted connections only, a `mysql` offers
   * TLS without requiring it, as on RDS.
   */
  readonly sslMode: 'ENCRYPTED_ONLY' | 'ALLOW_UNENCRYPTED_AND_ENCRYPTED';
  /** The prefix of its `database_version`: `POSTGRES_17`, `MYSQL_8_4`. */
  readonly versionPrefix: string;
  /**
   * The major of a `database_version`'s parts after its prefix, as text:
   * Postgres's first (`17` of `17`), MySQL's first two (`8.4` of `8_4` or
   * `8_0_31`).
   */
  readonly majorOf: (parts: readonly string[]) => string;
  /** What a console create leaves its version at: the saved image. */
  readonly defaultImage: string;
  /** Its version rule, over the saved image, by Cloud SQL's offer. */
  readonly version: (
    entryName: string,
    image: string,
  ) => RdsPostgresVersionReading;
  /** The user an entry with no `user` gets: the Server's default. */
  readonly defaultUser: (configName: string) => string;
  /** Its app user's rule on Cloud SQL, or `null` when Cloud SQL takes it. */
  readonly userRefusal: (entryName: string, user: string) => PlanRefusal | null;
  /**
   * Whether the instance's `root` gets a password of its own: a
   * MySQL's `root` exists from create, and is never left without one.
   */
  readonly rootPassword: boolean;
  /**
   * What turning point-in-time recovery on or off costs, after `restarts
   * <name> `: Google restarts Postgres twice for its
   * write-ahead log archiving, MySQL once for its binary log.
   */
  readonly pointInTimeRecoveryRestart: string;
  /** The switch for point-in-time recovery ({@link CLOUD_SQL_SWITCHES}). */
  readonly pointInTimeRecoveryArgument: (typeof CLOUD_SQL_SWITCHES)[CloudSqlEngineName]['pointInTimeRecoveryArgument'];
}

/**
 * Cloud SQL's PostgreSQL by the shared version rule (the AWS databases spec): the majors
 * Cloudgate offers on RDS, each of which Cloud SQL offers too, so a config
 * that runs on AWS runs here.
 */
const CLOUD_SQL_POSTGRES: PostgresOffer = {
  majors: RDS_POSTGRES_MAJORS,
  runner: 'Cloud SQL',
};

/**
 * Cloud SQL's MySQL by the same rule: the majors Cloudgate
 * offers on RDS, 8.4 alone, so a config that runs on AWS runs here. Google
 * offers 8.4 and 9.7, 8.0 too until its extended support from 1 January
 * 2027, and no pinned minor of 8.4 (`MYSQL_8_4` alone).
 */
const CLOUD_SQL_MYSQL: MysqlOffer = {
  majors: ['8.4'],
  runner: 'Cloud SQL',
  refuses80:
    'MySQL 8.0 enters paid extended support on Cloud SQL on 1 January 2027, and Cloudgate refuses it on RDS too, so it never chooses it for you',
  refuses9: (major) =>
    `MySQL ${major} is not offered on Cloud SQL by Cloudgate, which offers there the MySQL majors it offers on RDS, 8.4 alone`,
  pinsMinor: false,
};

/**
 * A `mysql` on Cloud SQL's app user: `root` is refused, as on any
 * cloud, since Cloudgate gives Cloud SQL's own `root` a password of its
 * own. A name over MySQL's 32 characters, written or the default, is
 * already refused as the config is read, on every target, and
 * Cloud SQL keeps MySQL's limit, so nothing more is checked here.
 */
function mysqlUserRefusal(entryName: string, user: string): PlanRefusal | null {
  if (user.toLowerCase() !== 'root') return null;
  const at = `${entryName}.user`;
  return {
    at,
    message: `${at}: Cloud SQL refuses root as a MySQL app user; root is a Server's only, and Cloudgate gives Cloud SQL's own root a password of its own, so choose another user:`,
  };
}

/** `POSTGRES_17`, `MYSQL_8_4`: a version reading as Cloud SQL names it. */
export function cloudSqlDatabaseVersion(
  engine: CloudSqlEngine,
  version: Pick<RdsPostgresVersion, 'major'>,
): string {
  return `${engine.versionPrefix}${String(version.major).replace('.', '_')}`;
}

/**
 * The major a `database_version` Google reports runs, comparable as a
 * number: `17` of `POSTGRES_17`, `8.4` of `MYSQL_8_4` or `MYSQL_8_0_31`.
 * `null` for another engine's, or none.
 */
export function cloudSqlMajorOf(
  engine: CloudSqlEngine,
  databaseVersion: string,
): number | null {
  if (!databaseVersion.startsWith(engine.versionPrefix)) return null;
  const parts = databaseVersion.slice(engine.versionPrefix.length).split('_');
  const major = engine.majorOf(parts);
  const number = Number(major);
  return Number.isFinite(number) && major !== '' ? number : null;
}

export const CLOUD_SQL_ENGINES: Readonly<
  Record<CloudSqlEngineName, CloudSqlEngine>
> = {
  postgres: {
    engine: 'postgres',
    label: CLOUD_SQL_SWITCHES.postgres.label,
    port: 5432,
    sslMode: 'ENCRYPTED_ONLY',
    versionPrefix: 'POSTGRES_',
    majorOf: (parts) => parts[0],
    defaultImage: 'postgres:18',
    version: (entryName, image) =>
      rdsPostgresVersion(entryName, image, CLOUD_SQL_POSTGRES),
    defaultUser: defaultPostgresUser,
    userRefusal: () => null,
    rootPassword: false,
    pointInTimeRecoveryRestart: 'twice: about 15 s offline',
    pointInTimeRecoveryArgument:
      CLOUD_SQL_SWITCHES.postgres.pointInTimeRecoveryArgument,
  },
  mysql: {
    engine: 'mysql',
    label: CLOUD_SQL_SWITCHES.mysql.label,
    port: 3306,
    sslMode: 'ALLOW_UNENCRYPTED_AND_ENCRYPTED',
    versionPrefix: 'MYSQL_',
    majorOf: (parts) => `${parts[0]}.${parts[1] ?? ''}`,
    defaultImage: `mysql:${RDS_MYSQL_DEFAULT}`,
    version: (entryName, image) =>
      rdsMysqlVersion(entryName, image, CLOUD_SQL_MYSQL),
    // MySQL takes the plain identifier, as on a Server and RDS.
    defaultUser: defaultDatabaseIdentifier,
    userRefusal: mysqlUserRefusal,
    rootPassword: true,
    pointInTimeRecoveryRestart: 'once: about 20 s offline',
    pointInTimeRecoveryArgument:
      CLOUD_SQL_SWITCHES.mysql.pointInTimeRecoveryArgument,
  },
};
