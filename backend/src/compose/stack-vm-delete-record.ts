import type { CloudDeleteRecord } from '../applications/application.schema';

/**
 * A Compose stack on a Stack VM's Delete under way or incomplete
 * (ADR-0038, #1367): a cloud Service's {@link CloudDeleteRecord}, and the
 * final snapshot of its data disk this Delete keeps — named the day it was
 * asked, so a Retry keeps the same one — or `null` when it asked for its
 * data to go. The row is dropped with it once the Delete finishes clean.
 */
export interface StackVmCloudDeleteRecord extends CloudDeleteRecord {
  /** The final snapshot's name: its `Name` tag on AWS, itself on Google Cloud. */
  readonly finalSnapshot: string | null;
  /**
   * The final snapshot once the cloud has started it: the EBS snapshot's
   * id or the Google snapshot's name, and the size of the disk it holds.
   * Kept at once, so a Retry takes no second one.
   */
  readonly snapshotTaken?: { readonly id: string; readonly sizeGb: number };
}
