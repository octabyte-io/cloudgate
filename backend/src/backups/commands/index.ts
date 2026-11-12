import { libsqlBackupCommands } from './libsql';
import { mariadbBackupCommands } from './mariadb';
import { mongoBackupCommands } from './mongo';
import { mysqlBackupCommands } from './mysql';
import { postgresBackupCommands } from './postgres';
import type { BackupCommandBuilder, BackupDatabaseType } from './types';

export * from './types';
export * from './utils';

/** One builder per engine, keyed by the backup row's databaseType. */
export const BACKUP_COMMANDS: Record<BackupDatabaseType, BackupCommandBuilder> =
  {
    postgres: postgresBackupCommands,
    mysql: mysqlBackupCommands,
    mariadb: mariadbBackupCommands,
    mongo: mongoBackupCommands,
    libsql: libsqlBackupCommands,
  };

/**
 * Retention's `rclone lsf --include` pattern: every extension a database dump
 * is written under, so `keepLatestNBackups` finds each engine's files.
 *
 * Derived from the builders rather than written out, so an engine whose
 * extension changes cannot silently fall out of pruning. `sql.gz` stays in for
 * a second reason as well: it is the name LibSQL tarballs were written under
 * once, and a bucket can still hold them.
 */
export const BACKUP_FILES_INCLUDE = `*.{${[
  ...new Set([
    ...Object.values(BACKUP_COMMANDS).map((builder) => builder.extension),
    'sql.gz',
  ]),
].join(',')}}`;
