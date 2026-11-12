import type { MachineType } from '../../aws/definitions/database-class';
import type { StackVmCloud, StackVmRates } from '../../definitions/stack-vm';

const GB = 1024;

const type = (name: string, vcpu: number, memoryGb: number): MachineType => ({
  name,
  vcpu,
  memoryMb: memoryGb * GB,
});

/**
 * The Compute Engine machine types a size puts a Stack VM on (ADR-0070
 * "Machine"): the general-purpose `e2` family, `e2-micro` to
 * `e2-standard-8`, x86 to match the Ubuntu image it boots. `e2-micro`,
 * `e2-small` and `e2-medium` share their two vCPUs, as AWS's `t3` does;
 * any other type is reached through `native.gcp`.
 */
const E2: readonly MachineType[] = [
  type('e2-micro', 2, 1),
  type('e2-small', 2, 2),
  type('e2-medium', 2, 4),
  type('e2-standard-2', 2, 8),
  type('e2-standard-4', 4, 16),
  type('e2-standard-8', 8, 32),
];

/** `n2-standard-2` to `n2-standard-8`, at 4 GB a vCPU. */
const N2: readonly MachineType[] = [2, 4, 8].map((vcpu) =>
  type(`n2-standard-${vcpu}`, vcpu, vcpu * 4),
);

/**
 * Every type a plan line names with its CPU and memory, so a type
 * `native.gcp` sets reads as `n2-standard-2 (2 vCPU, 8 GB)`. One it does
 * not know is still made: its line names it alone, and Google judges it.
 */
const KNOWN: readonly MachineType[] = [
  ...E2,
  type('e2-standard-16', 16, 64),
  ...N2,
];

const hourly = (usd: number) => Math.round(usd * 1e6) / 1e6;

/**
 * One region's rates from its `e2-standard-2` and `n2-standard-2` hourly
 * prices: Google prices each family per vCPU and per GB, so the shared-core
 * types are its published fractions of `e2-standard-2` (an eighth, a
 * quarter and a half) and each larger standard type doubles the one before.
 */
function rates(
  e2Standard2: number,
  n2Standard2: number,
  disk: number,
  snapshot: number,
): StackVmRates {
  return {
    machineHourlyUsd: {
      'e2-micro': hourly(e2Standard2 / 8),
      'e2-small': hourly(e2Standard2 / 4),
      'e2-medium': hourly(e2Standard2 / 2),
      'e2-standard-2': e2Standard2,
      'e2-standard-4': hourly(e2Standard2 * 2),
      'e2-standard-8': hourly(e2Standard2 * 4),
      'e2-standard-16': hourly(e2Standard2 * 8),
      'n2-standard-2': n2Standard2,
      'n2-standard-4': hourly(n2Standard2 * 2),
      'n2-standard-8': hourly(n2Standard2 * 4),
    },
    diskUsdPerGbMonth: disk,
    snapshotUsdPerGbMonth: snapshot,
  };
}

/**
 * **The Google Cloud rate table**: Compute Engine on-demand Linux hourly
 * prices, balanced persistent disk per GB-month and standard snapshots per
 * GB-month, from Google's published prices for the regions most Cloud
 * Environments use. A region not listed plans with no price, its line
 * pointing at Google's own pages; a region is one more line.
 */
const GOOGLE_RATES: Readonly<Record<string, StackVmRates>> = {
  'us-central1': rates(0.067006, 0.097118, 0.1, 0.05),
  'us-east1': rates(0.067006, 0.097118, 0.1, 0.05),
  'us-west1': rates(0.067006, 0.097118, 0.1, 0.05),
  'europe-west1': rates(0.073707, 0.10683, 0.11, 0.05),
  'europe-west2': rates(0.086334, 0.125124, 0.12, 0.05),
  'europe-west3': rates(0.086334, 0.125124, 0.12, 0.05),
  'asia-southeast1': rates(0.082606, 0.119718, 0.11, 0.05),
};

/** Google Cloud's Stack VMs, as the planner reads them (`StackVmCloud`). */
export const GOOGLE_STACK_VMS: StackVmCloud = {
  pricing: "Google Cloud's Compute Engine pricing",
  machines: { types: E2, smallest: E2[0] },
  known: KNOWN,
  rates: GOOGLE_RATES,
};
