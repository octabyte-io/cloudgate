import type { CloudDeleteRecord } from '../../applications/application.schema';

/**
 * A cloud database's Delete under way or incomplete (ADR-0038): a
 * cloud Service's {@link CloudDeleteRecord}, and the final snapshot this
 * Delete keeps — named the day it was asked, so a Retry or a run start-up
 * queues again takes the same one — or `null` when it asked for the data to
 * go. The row is dropped with it once the Delete finishes clean, so nothing
 * of the snapshot is stored after its report.
 */
export interface DatabaseCloudDeleteRecord extends CloudDeleteRecord {
  /**
   * The final snapshot's name on AWS; on Google Cloud the final backup's
   * a Cloud SQL backup's description or a Valkey backup's id.
   */
  readonly finalSnapshot: string | null;
  /**
   * A Google database's final backup once Google has taken it: where
   * it is kept and about how much it holds, so a Retry takes no second one
   * and still names it in its report. Gone with the row.
   */
  readonly backupTaken?: { readonly region: string; readonly sizeGb: number };
}
