import { byCloud, cloudOrLegacy } from '../../cloud-accounts/cloud-provider';
import type { CloudKind } from '../../cloud-accounts/cloud-account.schema';
import {
  CLOUD_SQL_STOP_SENTENCE,
  CLOUD_SQL_STOP_WARNING,
  cloudSqlStopOf,
} from '../postgres/cloud-sql-stop';
import type { CloudSqlStop } from '../postgres/cloud-sql-stop';
import {
  rdsStopOf,
  rdsStopSentence,
  rdsStopWarning,
} from '../postgres/rds-stop';
import type { RdsStop, RdsStopColumns } from '../postgres/rds-stop';

/**
 * **A cloud database's stop, by its cloud** (ADR-0043): RDS's
 * rule (`rds-stop.ts`, a restart date AWS keeps) or Cloud SQL's
 * (`cloud-sql-stop.ts`, none). The one place the Database's view, the plan
 * that marks a change blocked and the Apply that skips it choose which.
 * A row whose Cloud account is gone, or on a Server, reads as AWS's, as
 * every cloud default does (`cloudOrLegacy`); off a Cloud account neither
 * rule finds a stop.
 */

/**
 * An RDS instance's stop as the API answers it: the status line the
 * Database page shows, and Stop's warning while AWS has not started it
 * again. `null` when it is not stopped, and off RDS.
 */
export type RdsStopView =
  | (RdsStop & { readonly sentence: string; readonly warning: string | null })
  | null;

/**
 * A Cloud SQL instance's stop as the API answers it: "Stopped", with
 * no date, and Stop's warning. `null` when it is not stopped.
 */
export type CloudSqlStopView =
  | (CloudSqlStop & { readonly sentence: string; readonly warning: string })
  | null;

/**
 * What a database's read and its Stop and Start answer beside its row: a
 * postgres or a mysql on RDS's `rdsStop`, a postgres on Cloud SQL's
 * `cloudSqlStop`. Each is absent off its cloud, so the console tells which
 * Stop it offers by which one it is given.
 */
export type CloudStopView =
  | { readonly rdsStop: RdsStopView }
  | { readonly cloudSqlStop: CloudSqlStopView };

/** Whether the row is stopped as of `now`, by its cloud's rule. */
export function stoppedInItsCloud(
  row: RdsStopColumns,
  cloud: CloudKind | null,
  now: Date,
): boolean {
  return byCloud(cloudOrLegacy(cloud), {
    aws: () => rdsStopOf(row, now)?.state === 'stopped',
    gcp: () => cloudSqlStopOf(row) !== null,
  })();
}

/** The row's stop as of `now`, as the API answers it on its cloud. */
export function cloudStopView(
  row: RdsStopColumns,
  cloud: CloudKind | null,
  now: Date,
): CloudStopView {
  return byCloud(cloudOrLegacy(cloud), {
    aws: (): CloudStopView => ({ rdsStop: rdsStopView(row, now) }),
    gcp: (): CloudStopView => ({ cloudSqlStop: cloudSqlStopView(row) }),
  })();
}

/** An RDS row's stop as of `now`, as the API answers it. */
export function rdsStopView(row: RdsStopColumns, now: Date): RdsStopView {
  const stop = rdsStopOf(row, now);
  if (!stop) return null;
  return {
    ...stop,
    sentence: rdsStopSentence(stop),
    warning: stop.state === 'stopped' ? rdsStopWarning(stop.restartsAt) : null,
  };
}

/** A Cloud SQL row's stop, as the API answers it. */
function cloudSqlStopView(row: RdsStopColumns): CloudSqlStopView {
  const stop = cloudSqlStopOf(row);
  if (!stop) return null;
  return {
    ...stop,
    sentence: CLOUD_SQL_STOP_SENTENCE,
    warning: CLOUD_SQL_STOP_WARNING,
  };
}
