import type { KeptResource } from './delete-check';

/**
 * A cloud database's final snapshot (the AWS databases spec "Delete"): what a
 * Delete of a postgres on RDS or a redis on ElastiCache keeps unless that
 * Delete asked for its data to go, and what it costs while it is kept.
 */
export type SnapshotService = 'rds' | 'elasticache';

/**
 * What a snapshot costs a month, by what it is billed on: RDS's backup
 * storage per GB, ElastiCache's per GiB (us-east-1's published prices; the
 * figure is an estimate, said as one).
 */
export const SNAPSHOT_USD_PER_GB_MONTH: Readonly<
  Record<SnapshotService, number>
> = { rds: 0.095, elasticache: 0.085 };

/** How a size is said: RDS bills GB, ElastiCache GiB. */
const UNIT: Readonly<Record<SnapshotService, string>> = {
  rds: 'GB',
  elasticache: 'GiB',
};

/** The words the confirmation and the report end a kept snapshot's cost with. */
export const UNTIL_DELETED_IN_AWS = 'until you delete it in AWS';

/** About what the snapshot costs a month, in dollars, to the cent. */
export function snapshotMonthlyUsd(
  service: SnapshotService,
  sizeGb: number,
): number {
  return Math.round(sizeGb * SNAPSHOT_USD_PER_GB_MONTH[service] * 100) / 100;
}

/** `$1.90`, never below a cent: a snapshot that costs anything says so. */
export function formatUsd(usd: number): string {
  return `$${(usd > 0 && usd < 0.01 ? 0.01 : usd).toFixed(2)}`;
}

/** `20 GB`, `0.5 GiB`: a size as its service bills it. */
export function formatSnapshotSize(
  service: SnapshotService,
  sizeGb: number,
): string {
  const shown =
    sizeGb >= 10 ? Math.round(sizeGb) : Math.round(sizeGb * 100) / 100;
  return `${shown} ${UNIT[service]}`;
}

/**
 * The report's one *kept* entry for a final snapshot: its name, region,
 * size and what it costs a month until it is deleted in AWS. Nothing about
 * it is stored once the report is written.
 */
export function keptSnapshot(input: {
  readonly service: SnapshotService;
  readonly name: string;
  readonly region: string;
  readonly sizeGb: number;
}): KeptResource {
  return {
    type: input.service === 'rds' ? 'rds:snapshot' : 'elasticache:snapshot',
    awsId: input.name,
    region: input.region,
    size: formatSnapshotSize(input.service, input.sizeGb),
    cost: `about ${formatUsd(snapshotMonthlyUsd(input.service, input.sizeGb))} a month ${UNTIL_DELETED_IN_AWS}`,
  };
}

/** The report's line when a Delete asked for the data to go. */
export function dataDeletedLine(name: string): string {
  return `No final snapshot was taken: ${name}'s data is deleted for good.`;
}

/** Whether an ARN is this final snapshot's, which a tag search finds by its copied tags. */
export function isSnapshotArn(arn: string, name: string): boolean {
  return arn.endsWith(`:snapshot:${name}`);
}

/**
 * Whether an ARN is one of this instance's automated backup snapshots,
 * `rds:<identifier>-YYYY-MM-DD-HH-MM`, which also carry its copied tags.
 * RDS deletes them with the instance (`delete_automated_backups`), but the
 * tag index lists them for a while after. Another instance's never
 * match: the date must follow the identifier directly.
 */
export function isAutomatedSnapshotArn(
  arn: string,
  instanceIdentifier: string,
): boolean {
  const marker = `:snapshot:rds:${instanceIdentifier}-`;
  const at = arn.indexOf(marker);
  return at !== -1 && /^\d{4}(-\d{2}){4}$/.test(arn.slice(at + marker.length));
}
