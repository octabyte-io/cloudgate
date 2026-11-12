import type { PlanRefusal, Size, SizeName } from '../../../project-config';
import type { CloudRunPair } from './cloud-run-definition';

export type CloudRunSizing =
  | {
      readonly ok: true;
      /** The size name the entry used, or `null` for a custom pair or none. */
      readonly sizeName: SizeName | null;
      readonly pair: CloudRunPair;
      /**
       * What the size asked for, in the words the plan uses, when the pair
       * had to round it up: only the half that was raised, or both.
       */
      readonly roundedUpFrom?: string;
    }
  | { readonly ok: false; readonly refusal: PlanRefusal };

/**
 * Every CPU count Cloud Run allows, with the memory each holds, in MB:
 * Google's table for services. A count's minimum is what it must be given
 * at least; 1 and 2 CPU take Cloud Run's own floor.
 */
const CLOUD_RUN_COUNTS: readonly {
  readonly cpu: number;
  readonly minMb: number;
  readonly maxMb: number;
}[] = [
  { cpu: 1, minMb: 512, maxMb: 4 * 1024 },
  { cpu: 2, minMb: 512, maxMb: 8 * 1024 },
  { cpu: 4, minMb: 2 * 1024, maxMb: 16 * 1024 },
  { cpu: 6, minMb: 4 * 1024, maxMb: 24 * 1024 },
  { cpu: 8, minMb: 4 * 1024, maxMb: 32 * 1024 },
];

const LARGEST: CloudRunPair = { cpu: 8, memoryMb: 32 * 1024 };

/** An entry with no `size` is created at Cloud Run's own default. */
const NO_SIZE: CloudRunPair = { cpu: 1, memoryMb: 512 };

/**
 * The copy range a plan creates a Cloud Run service with (S10), Cloudgate's
 * per Service afterwards, never the config's.
 */
export const CLOUD_RUN_COPIES = { min: 0, max: 10 } as const;

/**
 * The Cloud Run pair a config entry's size runs at (the Google Cloud spec, "Sizes"; S3),
 * the twin of `fargateSize`.
 *
 * CPU goes up to the smallest count Cloud Run allows that is at least the
 * CPU asked for **and** whose memory maximum holds the memory asked for, so
 * a service never runs under one CPU; then memory goes up to that count's
 * minimum if it is below it. Above 8 CPU / 32 GB is refused, naming the
 * entry and the limit, rather than capped. With no size, Cloud Run's own
 * 1 CPU / 512 MB, Cloudgate's afterwards like an uncovered cap.
 */
export function cloudRunSize(
  entryName: string,
  size: Size | undefined,
): CloudRunSizing {
  if (!size) return { ok: true, sizeName: null, pair: NO_SIZE };
  const row = CLOUD_RUN_COUNTS.find(
    (count) => count.cpu >= size.cpu && count.maxMb >= size.memoryMb,
  );
  if (!row) {
    return {
      ok: false,
      refusal: {
        at: `${entryName}.size`,
        message: `${entryName}: size ${size.cpu} CPU / ${formatMemory(size.memoryMb)} is above Cloud Run's largest, ${formatCloudRunPair(LARGEST)}`,
      },
    };
  }
  const pair = { cpu: row.cpu, memoryMb: Math.max(size.memoryMb, row.minMb) };
  const raised = [
    pair.cpu > size.cpu ? `${size.cpu} CPU` : null,
    pair.memoryMb > size.memoryMb ? formatMemory(size.memoryMb) : null,
  ].filter((part): part is string => part !== null);
  return {
    ok: true,
    sizeName: size.name ?? null,
    pair,
    ...(raised.length > 0 ? { roundedUpFrom: raised.join(' / ') } : {}),
  };
}

/**
 * Why Cloud Run runs no container at `pair`, or `null` when Google's table
 * for services has it or only Google can judge it: a pair a
 * `native.gcp` lays is checked against the same table a size lands on, so
 * one outside it is refused at plan time rather than by Cloud Run at
 * deploy. A whole CPU count is 1, 2, 4, 6 or 8, each holding at most its
 * maximum, and 4 or more at least its minimum (1 and 2 CPU's 512 MB here
 * is Cloudgate's floor, not Google's). Under one CPU is Google's to judge:
 * it depends on CPU allocation, which this table does not hold.
 */
export function cloudRunPairProblem(pair: CloudRunPair): string | null {
  if (pair.cpu < 1) return null;
  const row = CLOUD_RUN_COUNTS.find((count) => count.cpu === pair.cpu);
  if (!row) {
    return `Cloud Run runs no container at ${pair.cpu} CPU: from one CPU up its count is one of ${CLOUD_RUN_COUNTS.map((count) => count.cpu).join(', ')}`;
  }
  const floor = row.cpu >= 4 ? row.minMb : 0;
  if (pair.memoryMb <= row.maxMb && pair.memoryMb >= floor) return null;
  return `Cloud Run runs no container at ${formatCloudRunPair(pair)}: ${row.cpu} CPU takes ${
    floor > 0
      ? `${formatMemory(floor)} to ${formatMemory(row.maxMb)}`
      : `at most ${formatMemory(row.maxMb)}`
  }`;
}

/** A pair as the plan shows it: `1 CPU / 512 MB`, `2 CPU / 3 GB`. */
export function formatCloudRunPair(pair: CloudRunPair): string {
  return `${pair.cpu} CPU / ${formatMemory(pair.memoryMb)}`;
}

/** A worker pool's instance count as the plan and the Deployment log say it: `1 instance`, `3 instances`. */
export function formatInstanceCount(count: number): string {
  return `${count} instance${count === 1 ? '' : 's'}`;
}

function formatMemory(memoryMb: number): string {
  return memoryMb % 1024 === 0 ? `${memoryMb / 1024} GB` : `${memoryMb} MB`;
}
