import { finalSnapshotIdentifier } from '../aws/definitions/postgres-definition';
import { AWS_STACK_VMS } from '../aws/definitions/stack-vm-machines';
import type { KeptResource } from '../aws/delete-check';
import { formatUsd } from '../aws/final-snapshot';
import type { CloudKind } from '../cloud-account.schema';
import { byCloud } from '../cloud-provider';
import type { PerCloud } from '../cloud-provider';
import { GOOGLE_STACK_VMS } from '../gcp/definitions/stack-vm-machines';
import { finalBackupName } from '../gcp/final-backup';
import type { StackVmCloud } from './stack-vm';

/**
 * **A Stack VM's final snapshot** (ADR-0070 "Delete", #1367): what a
 * Compose stack's Delete keeps of its data disk unless it asked for its
 * data to go — one snapshot of the disk, named for the day the Delete was
 * asked, `<project>-<environment>-<stack>-final-<date>`, as a cloud
 * database's final snapshot is. On AWS it is an EBS snapshot, that name
 * its `Name` tag; on Google Cloud a Compute Engine snapshot, that name
 * itself, cut to Google's 63 characters keeping its `-final-<date>` tail.
 */
export function stackVmFinalSnapshotName(
  cloud: CloudKind,
  input: {
    readonly projectName: string;
    readonly environmentName: string;
    readonly configName: string;
    readonly date: string;
  },
): string {
  const name = finalSnapshotIdentifier(input);
  return byCloud(cloud, { aws: name, gcp: finalBackupName(name) });
}

/** Each cloud's Stack VM rate table, which prices its snapshots by region. */
const RATES: PerCloud<StackVmCloud> = {
  aws: AWS_STACK_VMS,
  gcp: GOOGLE_STACK_VMS,
};

/**
 * About what a Stack VM's data-disk snapshot of `sizeGb` costs a month in
 * its region, from the cloud's rate table, to the cent; `null` when the
 * table has no price for the region.
 */
export function stackVmSnapshotMonthlyUsd(
  cloud: CloudKind,
  region: string,
  sizeGb: number,
): number | null {
  const rate = byCloud(cloud, RATES).rates[region]?.snapshotUsdPerGbMonth;
  return rate === undefined ? null : Math.round(sizeGb * rate * 100) / 100;
}

/** The kept final snapshot as a Delete's report names it. */
export function keptStackVmSnapshot(
  cloud: CloudKind,
  snapshot: {
    readonly id: string;
    readonly name: string;
    readonly region: string;
    readonly sizeGb: number;
  },
): KeptResource {
  const monthly = stackVmSnapshotMonthlyUsd(
    cloud,
    snapshot.region,
    snapshot.sizeGb,
  );
  const where = byCloud(cloud, { aws: 'AWS', gcp: 'Google Cloud' });
  return {
    type: byCloud(cloud, {
      aws: 'ec2:snapshot',
      gcp: 'compute.googleapis.com/Snapshot',
    }),
    awsId:
      snapshot.id === snapshot.name
        ? snapshot.name
        : `${snapshot.id} (${snapshot.name})`,
    region: snapshot.region,
    size: `${snapshot.sizeGb} GB`,
    cost:
      monthly === null
        ? `kept until you delete it in ${where}`
        : `about ${formatUsd(monthly)} a month until you delete it in ${where}`,
  };
}

/** The tag (AWS) or label (Google Cloud) a final snapshot names its stack by. */
export const FINAL_SNAPSHOT_OF = {
  aws: 'cloudgate:final-snapshot-of',
  gcp: 'cloudgate-final-snapshot-of',
} as const;

/** `analytics data is deleted for good: no final snapshot was taken`. */
export function stackVmDataDeletedLine(name: string): string {
  return `🗑️ [Cloud run] ${name}'s data disk is deleted for good: no final snapshot was taken`;
}
