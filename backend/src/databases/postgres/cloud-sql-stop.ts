/**
 * **The stop record of a postgres on Cloud SQL** (spec "Stop
 * and Start"), RDS's rule (`rds-stop.ts`) on Google Cloud. Read by the
 * Database's view, by the plan that marks a step blocked and by the Apply
 * that skips it, so the three never disagree.
 *
 * Google never starts a stopped Cloud SQL instance by itself (its
 * activation policy stays `NEVER` until Start sets it back), so no restart
 * date is recorded: a row reading `stopped` is stopped until it is started.
 */

/** The row's columns the rule reads. */
export interface CloudSqlStopColumns {
  readonly cloudAccountId: string | null;
  readonly applicationStatus: string;
}

/** Cloudgate stopped it, and it stays stopped until it is started. */
export interface CloudSqlStop {
  readonly state: 'stopped';
}

/** The instance's stop, or `null` when it is not stopped. */
export function cloudSqlStopOf(row: CloudSqlStopColumns): CloudSqlStop | null {
  if (!row.cloudAccountId || row.applicationStatus !== 'stopped') return null;
  return { state: 'stopped' };
}

/** What Stop warns, before and after it is pressed. */
export const CLOUD_SQL_STOP_WARNING =
  'Storage, backups and its private address still cost money. It stays stopped until you start it.';

/** The status line of a stopped instance: no date, since none comes. */
export const CLOUD_SQL_STOP_SENTENCE = 'Stopped';
