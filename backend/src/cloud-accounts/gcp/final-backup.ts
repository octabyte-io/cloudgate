import type { KeptResource } from '../aws/delete-check';
import { formatUsd } from '../aws/final-snapshot';

/**
 * A Google database's final backup (as decided and
 * corrected, with facts established live): the one on-demand backup a Delete of a `postgres` on
 * Cloud SQL or a `redis` on Memorystore for Valkey takes just before its
 * destroy, unless that Delete asked for its data to go, and what it costs
 * while it is kept. On Google the kept copy is a **backup**; on AWS it is a
 * final snapshot (`../aws/final-snapshot.ts`).
 */
export type BackupProduct = 'cloud-sql' | 'memorystore';

/**
 * What a backup costs a month (Cloud Billing Catalog): Cloud SQL's
 * backups about $0.08 a GiB-month in the `us` multi-region, Valkey's about
 * $0.081 a GB-month ($0.00011111 a GB-hour) in the instance's region. An
 * estimate, said as one.
 */
export const BACKUP_USD_PER_GB_MONTH: Readonly<Record<BackupProduct, number>> =
  { 'cloud-sql': 0.08, memorystore: 0.081 };

/** How a size is said and counted: Cloud SQL bills GiB, Valkey GB. */
const UNIT: Readonly<Record<BackupProduct, { name: string; bytes: number }>> = {
  'cloud-sql': { name: 'GiB', bytes: 1024 ** 3 },
  memorystore: { name: 'GB', bytes: 1000 ** 3 },
};

/** The words the confirmation and the report end a kept backup's cost with. */
export const UNTIL_DELETED_IN_GOOGLE_CLOUD =
  'until you delete it in Google Cloud';

/** A Valkey backup id is at most 63 characters (Google's resource id rule). */
const BACKUP_ID_LENGTH = 63;

/**
 * The backup's name, `<project>-<environment>-<service>-final-<date>`: the
 * final snapshot's name rule (`finalSnapshotIdentifier`), which Cloud SQL
 * carries as the backup's description and Valkey as its id. A name too long
 * for a Valkey id loses the end of its leading part, never `-final-<date>`.
 */
export function finalBackupName(snapshotName: string): string {
  if (snapshotName.length <= BACKUP_ID_LENGTH) return snapshotName;
  const at = snapshotName.lastIndexOf('-final-');
  const tail = snapshotName.slice(at);
  return `${snapshotName
    .slice(0, BACKUP_ID_LENGTH - tail.length)
    .replace(/-+$/, '')}${tail}`;
}

/** A size in the unit its product bills, from Google's bytes, to two places. */
export function backupSizeGb(product: BackupProduct, bytes: number): number {
  return Math.round((bytes / UNIT[product].bytes) * 100) / 100;
}

/** About what the backup costs a month, in dollars, to the cent. */
export function backupMonthlyUsd(
  product: BackupProduct,
  sizeGb: number,
): number {
  return Math.round(sizeGb * BACKUP_USD_PER_GB_MONTH[product] * 100) / 100;
}

/** `2 GiB`, `0.5 GB`: a size as its product bills it. */
function formatBackupSize(product: BackupProduct, sizeGb: number): string {
  const shown =
    sizeGb >= 10 ? Math.round(sizeGb) : Math.round(sizeGb * 100) / 100;
  return `${shown} ${UNIT[product].name}`;
}

/**
 * The Delete dialog's sentence: `keeps backup <name>, about $X a
 * month, until you delete it in Google Cloud`.
 */
export function keepsBackupSentence(name: string, monthlyUsd: number): string {
  return `keeps backup ${name}, about ${formatUsd(monthlyUsd)} a month, ${UNTIL_DELETED_IN_GOOGLE_CLOUD}`;
}

/**
 * The report's one *kept* entry for a final backup: its name (a Cloud SQL
 * backup's description, which is how it is found once Google renames it
 * after the instance goes), where it is kept, its size and what it costs a
 * month. Nothing about it is stored once the report is written.
 */
export function keptBackup(input: {
  readonly product: BackupProduct;
  readonly name: string;
  readonly region: string;
  readonly sizeGb: number;
}): KeptResource {
  return {
    type: `${input.product}:backup`,
    awsId: input.name,
    region: input.region,
    size: formatBackupSize(input.product, input.sizeGb),
    cost: `about ${formatUsd(backupMonthlyUsd(input.product, input.sizeGb))} a month ${UNTIL_DELETED_IN_GOOGLE_CLOUD}`,
  };
}

/** The report's line when a Delete asked for the data to go. */
export function backupDataDeletedLine(name: string): string {
  return `No final backup was taken: ${name}'s data is deleted for good.`;
}

/**
 * Where a Cloud SQL backup is kept unless asked otherwise: the multi-region
 * nearest the instance (a live check found `us` for `us-central1`).
 */
export function cloudSqlBackupLocation(region: string): string {
  if (region.startsWith('europe-')) return 'eu';
  if (region.startsWith('asia-') || region.startsWith('australia-')) {
    return 'asia';
  }
  return 'us';
}

/**
 * About how much a backup holds before it is taken: a Cloud SQL instance's
 * disk, which Cloudgate leaves at Google's 10 GB (`disk_size` unset), and a
 * Valkey node's writable memory, the most its backup can hold.
 */
export const CLOUD_SQL_DISK_GIB = 10;
