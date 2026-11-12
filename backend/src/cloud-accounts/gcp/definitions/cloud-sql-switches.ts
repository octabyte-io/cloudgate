import type { CloudSqlEngineName } from './cloud-sql-engines';

/**
 * Each Cloud SQL engine's name and its point-in-time recovery switch, the
 * two facts the native lock table reads. They live apart from
 * {@link CLOUD_SQL_ENGINES} because that table's version rules reach the
 * config format, which loads the native lock table: importing it from
 * there is a cycle that leaves `nativeGcpWireSchema` undefined.
 */
export const CLOUD_SQL_SWITCHES: Readonly<
  Record<
    CloudSqlEngineName,
    {
      /** How a plan line and a refusal name it. */
      readonly label: string;
      /**
       * The `settings.backup_configuration` argument that turns
       * point-in-time recovery on: `point_in_time_recovery_enabled` for
       * Postgres, and for MySQL its binary log, `binary_log_enabled`. The
       * pinned provider refuses the first on a MySQL instance, naming the
       * second (seen in an offline plan).
       */
      readonly pointInTimeRecoveryArgument:
        'point_in_time_recovery_enabled' | 'binary_log_enabled';
    }
  >
> = {
  postgres: {
    label: 'PostgreSQL',
    pointInTimeRecoveryArgument: 'point_in_time_recovery_enabled',
  },
  mysql: { label: 'MySQL', pointInTimeRecoveryArgument: 'binary_log_enabled' },
};
