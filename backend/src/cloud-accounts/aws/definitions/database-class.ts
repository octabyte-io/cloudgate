import type { PlanRefusal, Size, SizeName } from '../../../project-config';

/**
 * One managed-database machine type with the CPU and memory AWS publishes
 * for it: an RDS instance class (`db.t4g.micro`) or an ElastiCache node type
 * (`cache.t4g.small`).
 */
export interface MachineType {
  readonly name: string;
  readonly vcpu: number;
  /**
   * In MiB, so a size's MB compare without rounding (1 GB = 1024). A node
   * type AWS publishes in hundredths of a GiB (`1.37`) keeps the fraction.
   */
  readonly memoryMb: number;
}

/**
 * A family's machine types, smallest first, and its burstable family's
 * smallest: the type a Service with no `size` is created on.
 */
export interface MachineTable {
  /** The burstable family first, then the general-purpose one. */
  readonly types: readonly MachineType[];
  readonly smallest: MachineType;
}

const GIB = 1024;

const type = (name: string, vcpu: number, memoryGib: number): MachineType => ({
  name,
  vcpu,
  memoryMb: memoryGib * GIB,
});

/**
 * RDS for PostgreSQL's classes Cloudgate chooses from (the AWS databases spec): the
 * burstable `db.t4g` family, then the general-purpose `db.m7g` family up to
 * its `2xlarge`, AWS's published vCPU and memory beside each. No other family
 * is ever chosen: one is reached through `native` (slice 8).
 */
export const RDS_CLASSES: MachineTable = {
  types: [
    type('db.t4g.micro', 2, 1),
    type('db.t4g.small', 2, 2),
    type('db.t4g.medium', 2, 4),
    type('db.t4g.large', 2, 8),
    type('db.t4g.xlarge', 4, 16),
    type('db.t4g.2xlarge', 8, 32),
    type('db.m7g.large', 2, 8),
    type('db.m7g.xlarge', 4, 16),
    type('db.m7g.2xlarge', 8, 32),
  ],
  smallest: type('db.t4g.micro', 2, 1),
};

/**
 * ElastiCache's node types Cloudgate chooses from for a `redis` (the AWS databases
 * spec): the burstable `cache.t4g` family, which stops at `medium`, then the
 * general-purpose `cache.m7g` family up to its `2xlarge`, with AWS's
 * published vCPU and memory. By the one rule {@link machineFor} that puts
 * `xsmall` on `cache.t4g.micro`, `small` on `cache.t4g.small`, `medium` on
 * `cache.t4g.medium`, and `large` to `2xlarge` on the matching `cache.m7g`.
 */
export const ELASTICACHE_NODE_TYPES: MachineTable = {
  types: [
    type('cache.t4g.micro', 2, 0.5),
    type('cache.t4g.small', 2, 1.37),
    type('cache.t4g.medium', 2, 3.09),
    type('cache.m7g.large', 2, 6.38),
    type('cache.m7g.xlarge', 4, 12.7),
    type('cache.m7g.2xlarge', 8, 25.01),
  ],
  smallest: type('cache.t4g.micro', 2, 0.5),
};

/**
 * **The committed class table** (ADR-0044 rule 12): AWS's published
 * vCPU and memory of the RDS classes and ElastiCache node types a
 * `native.aws` `instance_class` or `node_type` may name beyond the ones
 * Cloudgate chooses, so a plan's size line can say what a native class is
 * (`pg-1 medium → db.r7g.xlarge (4 vCPU, 32 GB), set by native`). A class
 * not in it is still open and still runs: its line names it with no CPU and
 * memory, and AWS judges it at the Cloud run. Never chosen from a `size`:
 * {@link RDS_CLASSES} and {@link ELASTICACHE_NODE_TYPES} are.
 */
const SIZE_STEPS = [
  ['large', 2],
  ['xlarge', 4],
  ['2xlarge', 8],
  ['4xlarge', 16],
  ['8xlarge', 32],
  ['12xlarge', 48],
  ['16xlarge', 64],
] as const;

/** A family's `large` to `16xlarge`, at `gibPerVcpu` GiB a vCPU. */
const family = (prefix: string, gibPerVcpu: number): MachineType[] =>
  SIZE_STEPS.map(([step, vcpu]) =>
    type(`${prefix}.${step}`, vcpu, vcpu * gibPerVcpu),
  );

/** A burstable family's `micro` to `2xlarge`. */
const burstable = (prefix: string): MachineType[] => [
  type(`${prefix}.micro`, 2, 1),
  type(`${prefix}.small`, 2, 2),
  type(`${prefix}.medium`, 2, 4),
  type(`${prefix}.large`, 2, 8),
  type(`${prefix}.xlarge`, 4, 16),
  type(`${prefix}.2xlarge`, 8, 32),
];

/** The RDS classes the size line knows: 4 GiB a vCPU on `m`, 8 on `r`. */
export const RDS_KNOWN_CLASSES: readonly MachineType[] = [
  ...burstable('db.t3'),
  ...burstable('db.t4g'),
  ...['db.m5', 'db.m6g', 'db.m6i', 'db.m7g', 'db.m7i', 'db.m8g'].flatMap(
    (prefix) => family(prefix, 4),
  ),
  ...['db.r5', 'db.r6g', 'db.r6i', 'db.r7g', 'db.r7i', 'db.r8g'].flatMap(
    (prefix) => family(prefix, 8),
  ),
];

/** The ElastiCache node types the size line knows, as AWS publishes them. */
export const ELASTICACHE_KNOWN_NODE_TYPES: readonly MachineType[] = [
  ...ELASTICACHE_NODE_TYPES.types,
  type('cache.t3.micro', 2, 0.5),
  type('cache.t3.small', 2, 1.37),
  type('cache.t3.medium', 2, 3.09),
  ...['cache.r6g', 'cache.r7g'].flatMap((prefix) => [
    type(`${prefix}.large`, 2, 13.07),
    type(`${prefix}.xlarge`, 4, 26.32),
    type(`${prefix}.2xlarge`, 8, 52.82),
  ]),
];

/**
 * The machine type of a name a plan line shows: one Cloudgate
 * chooses, else one the committed class table knows, else `null`.
 */
export function machineKnown(
  table: MachineTable,
  known: readonly MachineType[],
  name: string,
): MachineType | null {
  return (
    machineNamed(table, name) ?? known.find((one) => one.name === name) ?? null
  );
}

export type MachineSizing =
  | {
      readonly ok: true;
      /** The size name the entry used, or `null` for a custom pair or none. */
      readonly sizeName: SizeName | null;
      readonly machine: MachineType;
      /** No `size`: the family's smallest, which the plan says. */
      readonly smallest: boolean;
    }
  | { readonly ok: false; readonly refusal: PlanRefusal };

/**
 * The machine type a database's size runs on (`CONTEXT.md` **Size**),
 * one rule for RDS and ElastiCache: the first type in the table, burstable
 * family first, at least as large as the size in **both** CPU and memory, so
 * a Service never gets less than it asked for and never a larger family when
 * a burstable one fits. On RDS that puts `xsmall` and `small` both on
 * `db.t4g.micro`.
 *
 * A size larger than every type refuses the plan, naming the entry and the
 * largest type, rather than running it on less. With no size the type is the
 * family's smallest; after creation that choice is Cloudgate's.
 */
export function machineFor(
  table: MachineTable,
  entryName: string,
  size: Size | undefined,
): MachineSizing {
  if (!size) {
    return {
      ok: true,
      sizeName: null,
      machine: table.smallest,
      smallest: true,
    };
  }
  const machine = table.types.find(
    (one) => one.vcpu >= size.cpu && one.memoryMb >= size.memoryMb,
  );
  if (machine) {
    return {
      ok: true,
      sizeName: size.name ?? null,
      machine,
      smallest: false,
    };
  }
  const largest = table.types[table.types.length - 1];
  return {
    ok: false,
    refusal: {
      at: `${entryName}.size`,
      message: `${entryName}: size ${size.cpu} CPU / ${formatMemory(size.memoryMb)} is above the largest machine type Cloudgate chooses, ${largest.name} (${formatMachine(largest)})`,
    },
  };
}

/** The machine type of a name, from the table, or `null` for one not in it. */
export function machineNamed(
  table: MachineTable,
  name: string,
): MachineType | null {
  return table.types.find((one) => one.name === name) ?? null;
}

/** `2 vCPU, 1 GB` or `2 vCPU, 1.37 GB`, as a plan line shows a machine type. */
export function formatMachine(machine: MachineType): string {
  return `${machine.vcpu} vCPU, ${formatMemory(machine.memoryMb)}`;
}

function formatMemory(memoryMb: number): string {
  if (memoryMb % GIB === 0) return `${memoryMb / GIB} GB`;
  // A node type's hundredths of a GiB, as AWS publishes them.
  if (memoryMb > GIB) return `${Math.round((memoryMb / GIB) * 100) / 100} GB`;
  return `${memoryMb} MB`;
}
