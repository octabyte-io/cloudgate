import {
  ELASTICACHE_KNOWN_NODE_TYPES,
  ELASTICACHE_NODE_TYPES,
  RDS_CLASSES,
  RDS_KNOWN_CLASSES,
  formatMachine,
  machineKnown,
} from '../cloud-accounts/aws/definitions/database-class';
import {
  fargatePairProblem,
  formatCpu,
  formatMemory,
} from '../cloud-accounts/aws/definitions/fargate-size';
import type { FargatePair } from '../cloud-accounts/aws/definitions/fargate-size';
import { POSTGRES_INSTANCE_ADDRESS } from '../cloud-accounts/aws/definitions/postgres-definition';
import { REDIS_GROUP_ADDRESS } from '../cloud-accounts/aws/definitions/redis-definition';
import { AWS_CONTAINER_ADDRESS } from './aws-locks';
import type { NativeAwsBlock } from './aws-native';
import type { PathPart } from './provider-schema';
import {
  nativePairRefusal,
  nativeSizeOf,
  pairWording,
  sizeBearingAt,
} from './size-override';
import type { SizeBearingTable } from './size-override';

/**
 * **Exact sizes on AWS** (ADR-0044 rule 12): the size-bearing
 * arguments a `native.aws` block may set, each open on the lock list
 * (`aws-open-settings.ts`), and how a plan names what they set. The rules
 * every cloud shares are `size-override.ts`'s.
 *
 * - `instance_class` on a postgres's or a mysql's RDS instance, and
 *   `node_type` on a redis's replication group, the whole machine, named
 *   with its CPU and memory when the committed class table knows it
 *   (`RDS_KNOWN_CLASSES`, `ELASTICACHE_KNOWN_NODE_TYPES`).
 * - The Fargate task's `cpu` and `memory`, each half of the pair the task
 *   runs at, so one alone overrides that half and the size keeps the other
 *   (`api medium → 2 vCPU (native) / 2 GB`).
 *
 * The container's own `cpu` and `memory` (`container_definitions`) are open
 * too, but they share out the task's pair rather than size it, so they are
 * planned as native lines only and a size line never names them.
 */
export const AWS_SIZE_BEARING: SizeBearingTable = {
  prefix: 'native.aws',
  settings: [
    {
      address: POSTGRES_INSTANCE_ADDRESS,
      path: ['instance_class'],
      part: 'machine',
    },
    { address: REDIS_GROUP_ADDRESS, path: ['node_type'], part: 'machine' },
    { address: AWS_CONTAINER_ADDRESS, path: ['cpu'], part: 'cpu' },
    { address: AWS_CONTAINER_ADDRESS, path: ['memory'], part: 'memory' },
  ],
};

/** Whether `path` of `address` is a size-bearing argument on AWS. */
export function isAwsSizeBearing(
  address: string,
  path: readonly PathPart[],
): boolean {
  return sizeBearingAt(AWS_SIZE_BEARING, address, path) !== undefined;
}

const text = (value: unknown) =>
  typeof value === 'string' && value !== '' ? value : null;

/** The RDS class `block` sets natively, or `null` where it leaves it to `size`. */
export function nativeInstanceClassOf(
  block: NativeAwsBlock | null | undefined,
): string | null {
  return text(
    nativeSizeOf(AWS_SIZE_BEARING, block, POSTGRES_INSTANCE_ADDRESS, 'machine')
      ?.value,
  );
}

/** The ElastiCache node type `block` sets natively, or `null`. */
export function nativeNodeTypeOf(
  block: NativeAwsBlock | null | undefined,
): string | null {
  return text(
    nativeSizeOf(AWS_SIZE_BEARING, block, REDIS_GROUP_ADDRESS, 'machine')
      ?.value,
  );
}

/** `4 vCPU, 32 GB` for an RDS class the committed table knows, else `null`. */
export function rdsMachineText(instanceClass: string): string | null {
  const machine = machineKnown(RDS_CLASSES, RDS_KNOWN_CLASSES, instanceClass);
  return machine ? formatMachine(machine) : null;
}

/** `2 vCPU, 13.07 GB` for a node type the committed table knows, else `null`. */
export function elastiCacheMachineText(nodeType: string): string | null {
  const machine = machineKnown(
    ELASTICACHE_NODE_TYPES,
    ELASTICACHE_KNOWN_NODE_TYPES,
    nodeType,
  );
  return machine ? formatMachine(machine) : null;
}

/**
 * A task's `cpu` as AWS takes it, in CPU units: `"2048"`, `2048` or
 * `"2 vCPU"`. `undefined` for anything else, which AWS judges at deploy.
 */
function cpuUnitsOf(value: unknown): number | undefined {
  if (typeof value === 'number' && value > 0) return value;
  if (typeof value !== 'string') return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(vcpu)?\s*$/i.exec(value);
  if (!match) return undefined;
  const count = Number(match[1]);
  return match[2] ? count * 1024 : count;
}

/** A task's `memory` as AWS takes it, in MiB: `"4096"`, `4096` or `"4 GB"`. */
function memoryMbOf(value: unknown): number | undefined {
  if (typeof value === 'number' && value > 0) return value;
  if (typeof value !== 'string') return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(gb)?\s*$/i.exec(value);
  if (!match) return undefined;
  const count = Number(match[1]);
  return match[2] ? count * 1024 : count;
}

/** The halves of a Fargate pair `block` sets natively, each absent where it sets none. */
export function nativeFargateOf(block: NativeAwsBlock | null | undefined): {
  readonly cpuUnits?: number;
  readonly memoryMb?: number;
} {
  const cpu = cpuUnitsOf(
    nativeSizeOf(AWS_SIZE_BEARING, block, AWS_CONTAINER_ADDRESS, 'cpu')?.value,
  );
  const memory = memoryMbOf(
    nativeSizeOf(AWS_SIZE_BEARING, block, AWS_CONTAINER_ADDRESS, 'memory')
      ?.value,
  );
  return {
    ...(cpu === undefined ? {} : { cpuUnits: cpu }),
    ...(memory === undefined ? {} : { memoryMb: memory }),
  };
}

/** The pair a task runs at: native's halves over the size's. */
export function fargatePairWith(
  pair: FargatePair,
  block: NativeAwsBlock | null | undefined,
): FargatePair {
  const native = nativeFargateOf(block);
  return {
    cpuUnits: native.cpuUnits ?? pair.cpuUnits,
    memoryMb: native.memoryMb ?? pair.memoryMb,
  };
}

/**
 * A task pair `block` lays that Fargate does not run, refused at
 * plan time by the native paths that set it, or `null` when native sets
 * neither half or the pair is one Fargate runs. `pair` is what the task
 * runs at without native: the size's, or with no size the caps it has.
 * Without this the pair planned clean, its Apply wrote it to a size-less
 * Service's caps, and only `RegisterTaskDefinition` refused it, at deploy.
 */
export function nativeFargateRefusal(
  name: string,
  pair: FargatePair,
  block: NativeAwsBlock | null | undefined,
): { readonly at: string; readonly message: string } | null {
  const native = nativeFargateOf(block);
  const parts = [
    ...(native.cpuUnits === undefined ? [] : ['cpu' as const]),
    ...(native.memoryMb === undefined ? [] : ['memory' as const]),
  ];
  return nativePairRefusal(
    AWS_SIZE_BEARING,
    name,
    block,
    AWS_CONTAINER_ADDRESS,
    parts,
    parts.length === 0
      ? null
      : fargatePairProblem(fargatePairWith(pair, block)),
  );
}

/**
 * A Service's caps after an Apply of `block`, for an entry with no
 * `size`, whose caps are Cloudgate's and the console's: the pair the task
 * runs at, native's halves over the caps it has (`fargateSize` of them), so
 * taking the native value out later leaves the task where it is rather than
 * shrinking it to the smallest pair. `null` when native sets neither half.
 * In the columns' units: nano-CPUs and bytes.
 */
export function capsWithNativeFargate(
  pair: FargatePair,
  block: NativeAwsBlock | null | undefined,
): { readonly cpuLimit: string; readonly memoryLimit: string } | null {
  const native = nativeFargateOf(block);
  if (native.cpuUnits === undefined && native.memoryMb === undefined) {
    return null;
  }
  const laid = fargatePairWith(pair, block);
  return {
    cpuLimit: String(Math.round((laid.cpuUnits / 1024) * 1e9)),
    memoryLimit: String(laid.memoryMb * 1024 * 1024),
  };
}

/**
 * The pair a task runs at as its size line words it: native's
 * halves over the size's, each native one marked, `2 vCPU (native) / 2 GB`.
 */
export function fargateWording(
  pair: FargatePair,
  block: NativeAwsBlock | null | undefined,
): string {
  const native = nativeFargateOf(block);
  const laid = fargatePairWith(pair, block);
  return pairWording(
    { text: formatCpu(laid.cpuUnits), native: native.cpuUnits !== undefined },
    {
      text: formatMemory(laid.memoryMb),
      native: native.memoryMb !== undefined,
    },
  );
}
