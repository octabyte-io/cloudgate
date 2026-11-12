import type { PlanRefusal } from '../../../project-config';
import {
  POSTGRES_RESERVED_ROLE,
  postgresReservesRole,
} from '../../../project-config/format/config-wire';

/**
 * Words RDS refuses as a PostgreSQL master user or initial database name:
 * its own roles, and PostgreSQL's reserved key words a bare name collides
 * with. Compared lower case, as PostgreSQL folds an unquoted name.
 */
const RDS_RESERVED_NAMES: ReadonlySet<string> = new Set([
  'rdsadmin',
  'rdsrepladmin',
  'rds_superuser',
  'rds_replication',
  'rds_password',
  'rds_iam',
  'pg_signal_backend',
  'all',
  'analyse',
  'analyze',
  'and',
  'any',
  'array',
  'as',
  'asc',
  'authorization',
  'both',
  'case',
  'cast',
  'check',
  'collate',
  'column',
  'constraint',
  'create',
  'current_catalog',
  'current_date',
  'current_role',
  'current_time',
  'current_timestamp',
  'current_user',
  'default',
  'deferrable',
  'desc',
  'distinct',
  'do',
  'else',
  'end',
  'except',
  'false',
  'fetch',
  'for',
  'foreign',
  'from',
  'grant',
  'group',
  'having',
  'in',
  'initially',
  'intersect',
  'into',
  'lateral',
  'leading',
  'limit',
  'localtime',
  'localtimestamp',
  'not',
  'null',
  'offset',
  'on',
  'only',
  'or',
  'order',
  'placing',
  'primary',
  'public',
  'references',
  'returning',
  'select',
  'session_user',
  'some',
  'symmetric',
  'system_user',
  'table',
  'then',
  'to',
  'trailing',
  'true',
  'union',
  'unique',
  'user',
  'using',
  'variadic',
  'when',
  'where',
  'window',
  'with',
]);

/**
 * Whether RDS takes `name` as a PostgreSQL master user or initial database
 * (US18), as the refusal names it, or `null` when it does: 1 to 63
 * letters, digits or underscores, a letter first, and not a word RDS or
 * PostgreSQL reserves, nor for a user a `pg_` name. Checked before the
 * plan is stored, so a create never fails ten minutes in.
 */
export function rdsNameRefusal(
  entryName: string,
  field: 'user' | 'database',
  name: string,
): PlanRefusal | null {
  const at = `${entryName}.${field}`;
  const what = field === 'user' ? 'master user' : 'initial database';
  if (!/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(name)) {
    return {
      at,
      message: `${at}: RDS refuses ${name} as a PostgreSQL ${what}; it takes 1 to 63 letters, digits or underscores, starting with a letter`,
    };
  }
  if (field === 'user' && postgresReservesRole(name)) {
    return {
      at,
      message: `${at}: RDS refuses ${name} as a PostgreSQL ${what}; ${POSTGRES_RESERVED_ROLE}`,
    };
  }
  if (RDS_RESERVED_NAMES.has(name.toLowerCase())) {
    return {
      at,
      message: `${at}: RDS refuses ${name} as a PostgreSQL ${what}; it is a reserved word`,
    };
  }
  return null;
}

/**
 * Words RDS refuses as a MySQL master user or initial database: its
 * own accounts, MySQL's system schemas, and MySQL 8.4's reserved words,
 * which a bare name collides with. Compared lower case.
 */
const RDS_MYSQL_RESERVED_NAMES: ReadonlySet<string> = new Set([
  'rdsadmin',
  'rdsrepladmin',
  'rdsproxyadmin',
  'mysql',
  'sys',
  'information_schema',
  'performance_schema',
  ...`accessible add all alter analyze and as asc asensitive before between
  bigint binary blob both by call cascade case change char character check
  collate column condition constraint continue convert create cross cube
  cume_dist current_date current_time current_timestamp current_user cursor
  database databases day_hour day_microsecond day_minute day_second dec
  decimal declare default delayed delete dense_rank desc describe
  deterministic distinct distinctrow div double drop dual each else elseif
  empty enclosed escaped except exists exit explain false fetch first_value
  float float4 float8 for force foreign from fulltext function generated get
  grant group grouping groups having high_priority hour_microsecond
  hour_minute hour_second if ignore in index infile inner inout insensitive
  insert int int1 int2 int3 int4 int8 integer intersect interval into
  io_after_gtids io_before_gtids is iterate join json_table key keys kill
  lag last_value lateral lead leading leave left like limit linear lines
  load localtime localtimestamp lock long longblob longtext loop
  low_priority manual master_bind master_ssl_verify_server_cert match
  maxvalue mediumblob mediumint mediumtext middleint minute_microsecond
  minute_second mod modifies natural not no_write_to_binlog nth_value ntile
  null numeric of on optimize optimizer_costs option optionally or order out
  outer outfile over parallel partition percent_rank precision primary
  procedure purge qualify range rank read reads read_write real recursive
  references regexp release rename repeat replace require resignal restrict
  return revoke right rlike row rows row_number schema schemas
  second_microsecond select sensitive separator set show signal smallint
  spatial specific sql sqlexception sqlstate sqlwarning sql_big_result
  sql_calc_found_rows sql_small_result ssl starting stored straight_join
  system table tablesample terminated then tinyblob tinyint tinytext to
  trailing trigger true undo union unique unlock unsigned update usage use
  using utc_date utc_time utc_timestamp values varbinary varchar
  varcharacter varying virtual when where while window with write xor
  year_month zerofill`
    .split(/\s+/)
    .filter((word) => word !== ''),
]);

/**
 * RDS for MySQL's longest master user: 16, not MySQL's own 32
 * which a Server keeps. AWS CreateDBInstance's MasterUsername.
 */
const RDS_MYSQL_USER_MAX = 16;

/** MySQL's longest database name, RDS's `db_name` for MySQL included. */
const RDS_MYSQL_DATABASE_MAX = 64;

/**
 * Whether RDS takes `name` as a MySQL master user or initial database
 * as the refusal names it, or `null` when it does: `postgres`'s
 * rule ({@link rdsNameRefusal}) with RDS for MySQL's limits — up to 16
 * characters for a user and 64 for a database, letters, digits or underscores, a
 * letter first, and not a word RDS or MySQL reserves. `root` is a Server's
 * only: there the image keeps it, and on a cloud it is refused.
 */
export function rdsMysqlNameRefusal(
  entryName: string,
  field: 'user' | 'database',
  name: string,
): PlanRefusal | null {
  const at = `${entryName}.${field}`;
  const what = field === 'user' ? 'master user' : 'initial database';
  const max = field === 'user' ? RDS_MYSQL_USER_MAX : RDS_MYSQL_DATABASE_MAX;
  if (!new RegExp(`^[A-Za-z][A-Za-z0-9_]{0,${max - 1}}$`).test(name)) {
    return {
      at,
      message: `${at}: RDS refuses ${name} as a MySQL ${what}; it takes 1 to ${max} letters, digits or underscores, starting with a letter`,
    };
  }
  if (field === 'user' && name.toLowerCase() === 'root') {
    return {
      at,
      message: `${at}: RDS refuses root as a MySQL ${what}; root is a Server's only, so choose another user:`,
    };
  }
  if (RDS_MYSQL_RESERVED_NAMES.has(name.toLowerCase())) {
    return {
      at,
      message: `${at}: RDS refuses ${name} as a MySQL ${what}; it is a reserved word`,
    };
  }
  return null;
}
