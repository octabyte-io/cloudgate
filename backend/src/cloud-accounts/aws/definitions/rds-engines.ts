import type { PlanRefusal } from '../../../project-config';
import {
  defaultDatabaseIdentifier,
  defaultPostgresUser,
} from '../../../project-config/format/config-wire';
import { RDS_MYSQL_DEFAULT, rdsMysqlVersion } from './mysql-version';
import { rdsPostgresVersion } from './postgres-version';
import type { RdsPostgresVersionReading } from './postgres-version';
import { rdsMysqlNameRefusal, rdsNameRefusal } from './rds-names';

/** The config kinds RDS makes, which are also its `engine`s. */
export type RdsEngineName = 'postgres' | 'mysql';

/**
 * What differs between a `postgres` and a `mysql` on RDS (the AWS kinds spec
 * "`mysql` on RDS"): the parameters of the one RDS definition and planner.
 * Everything else — size to class, storage, Multi-AZ, backups, deletion
 * protection, the final snapshot, Stop's seven days, an Existing database —
 * is the same code for both.
 */
export interface RdsEngine {
  readonly engine: RdsEngineName;
  /** How a plan line and a refusal name it: `PostgreSQL`, `MySQL`. */
  readonly label: string;
  /** The one port its security group opens, from the Environment network only. */
  readonly port: number;
  /** What a console create leaves its version at: the saved image. */
  readonly defaultImage: string;
  /** Its version rule, over the saved image (`postgres:17`, `mysql:8.4`). */
  readonly version: (
    entryName: string,
    image: string,
  ) => RdsPostgresVersionReading;
  /** Its master user's and initial database's rule. */
  readonly nameRefusal: (
    entryName: string,
    field: 'user' | 'database',
    name: string,
  ) => PlanRefusal | null;
  /** The master user an entry with no `user` gets: the Server's default. */
  readonly defaultUser: (configName: string) => string;
  /**
   * The major of a version it runs or is asked for, comparable as a
   * number: `17` of `17.4`, `8.4` of `8.4.6`. `null` for none.
   */
  readonly majorOf: (version: string | null) => number | null;
}

export const RDS_ENGINES: Readonly<Record<RdsEngineName, RdsEngine>> = {
  postgres: {
    engine: 'postgres',
    label: 'PostgreSQL',
    port: 5432,
    defaultImage: 'postgres:18',
    version: (entryName, image) => rdsPostgresVersion(entryName, image),
    nameRefusal: rdsNameRefusal,
    defaultUser: defaultPostgresUser,
    majorOf: (version) => numberOf(version, /(\d+)/),
  },
  mysql: {
    engine: 'mysql',
    label: 'MySQL',
    port: 3306,
    defaultImage: `mysql:${RDS_MYSQL_DEFAULT}`,
    version: rdsMysqlVersion,
    nameRefusal: rdsMysqlNameRefusal,
    // MySQL takes the plain identifier, as on a Server.
    defaultUser: defaultDatabaseIdentifier,
    majorOf: (version) => numberOf(version, /(\d+\.\d+)/),
  },
};

/** The engine an RDS instance's `engine` names, or `null` for one RDS makes no kind of. */
export function rdsEngineNamed(engine: unknown): RdsEngine | null {
  return engine === 'postgres' || engine === 'mysql'
    ? RDS_ENGINES[engine]
    : null;
}

/** The major in `version` (`17.4`, `postgres:17`, `8.4.6`, `mysql:8.4`), by `pattern`. */
function numberOf(version: string | null, pattern: RegExp): number | null {
  if (!version) return null;
  const match = pattern.exec(version.split(':').at(-1) ?? '');
  return match ? Number(match[1]) : null;
}
