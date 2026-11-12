import type { MachineType } from './database-class';
import type { StackVmCloud, StackVmRates } from '../../definitions/stack-vm';

const GIB = 1024;

const type = (name: string, vcpu: number, memoryGib: number): MachineType => ({
  name,
  vcpu,
  memoryMb: memoryGib * GIB,
});

/** A burstable EC2 family's `micro` to `2xlarge`, as AWS publishes them. */
const burstable = (prefix: string): MachineType[] => [
  type(`${prefix}.micro`, 2, 1),
  type(`${prefix}.small`, 2, 2),
  type(`${prefix}.medium`, 2, 4),
  type(`${prefix}.large`, 2, 8),
  type(`${prefix}.xlarge`, 4, 16),
  type(`${prefix}.2xlarge`, 8, 32),
];

/** A general-purpose family's `large` to `4xlarge`, at `gibPerVcpu` GiB a vCPU. */
const family = (prefix: string, gibPerVcpu: number): MachineType[] =>
  (
    [
      ['large', 2],
      ['xlarge', 4],
      ['2xlarge', 8],
      ['4xlarge', 16],
    ] as const
  ).map(([step, vcpu]) => type(`${prefix}.${step}`, vcpu, vcpu * gibPerVcpu));

/**
 * The EC2 machine types a size puts a Stack VM on (ADR-0070 "Machine"): the
 * burstable `t3` family, `t3.micro` to `t3.2xlarge`, x86 to match the
 * Ubuntu image it boots. `t3.nano`'s half GB leaves Docker no room, so it
 * is never chosen; any other type is reached through `native.aws`.
 */
const T3 = burstable('t3');

/**
 * Every type a plan line names with its CPU and memory, so a type
 * `native.aws` sets reads as `m7i.large (2 vCPU, 8 GB)`. One it does not
 * know is still made: its line names it alone, and AWS judges it.
 */
const KNOWN: readonly MachineType[] = [
  ...T3,
  ...burstable('t3a'),
  ...family('m7i', 4),
  ...family('c7i', 2),
  ...family('r7i', 8),
];

/** t3's hourly prices from `micro` up, and m7i's from `large` up, in one region. */
function rates(
  t3: readonly [number, number, number, number, number, number],
  m7iLarge: number,
  disk: number,
  snapshot: number,
): StackVmRates {
  const steps = ['micro', 'small', 'medium', 'large', 'xlarge', '2xlarge'];
  return {
    machineHourlyUsd: {
      ...Object.fromEntries(steps.map((step, i) => [`t3.${step}`, t3[i]])),
      'm7i.large': m7iLarge,
      'm7i.xlarge': Math.round(m7iLarge * 2 * 1e4) / 1e4,
      'm7i.2xlarge': Math.round(m7iLarge * 4 * 1e4) / 1e4,
    },
    diskUsdPerGbMonth: disk,
    snapshotUsdPerGbMonth: snapshot,
  };
}

/**
 * **The AWS rate table**: EC2 on-demand Linux hourly prices, gp3 per
 * GB-month and EBS snapshots per GB-month, from AWS's published prices for
 * the regions most Cloud Environments use. A region not listed plans with
 * no price, its line pointing at AWS's own pages; a region is one more line.
 */
const AWS_RATES: Readonly<Record<string, StackVmRates>> = {
  'us-east-1': rates(
    [0.0104, 0.0208, 0.0416, 0.0832, 0.1664, 0.3328],
    0.1008,
    0.08,
    0.05,
  ),
  'us-east-2': rates(
    [0.0104, 0.0208, 0.0416, 0.0832, 0.1664, 0.3328],
    0.1008,
    0.08,
    0.05,
  ),
  'us-west-2': rates(
    [0.0104, 0.0208, 0.0416, 0.0832, 0.1664, 0.3328],
    0.1008,
    0.08,
    0.05,
  ),
  'eu-west-1': rates(
    [0.0114, 0.0228, 0.0456, 0.0912, 0.1824, 0.3648],
    0.111,
    0.088,
    0.05,
  ),
  'eu-west-2': rates(
    [0.0118, 0.0236, 0.0472, 0.0944, 0.1888, 0.3776],
    0.1176,
    0.0928,
    0.053,
  ),
  'eu-central-1': rates(
    [0.012, 0.024, 0.048, 0.096, 0.192, 0.384],
    0.1176,
    0.0952,
    0.054,
  ),
  'ap-southeast-1': rates(
    [0.0132, 0.0264, 0.0528, 0.1056, 0.2112, 0.4224],
    0.1218,
    0.096,
    0.05,
  ),
};

/** AWS's Stack VMs, as the planner reads them (`StackVmCloud`). */
export const AWS_STACK_VMS: StackVmCloud = {
  pricing: "AWS's EC2 and EBS pricing",
  machines: { types: T3, smallest: T3[0] },
  known: KNOWN,
  rates: AWS_RATES,
};
