import type { PlanRefusal, Size, SizeName } from '../../../project-config';

/**
 * A Fargate task's CPU and memory, in the units the task definition takes:
 * CPU units (1024 to a vCPU) and MiB.
 */
export interface FargatePair {
  readonly cpuUnits: number;
  readonly memoryMb: number;
}

export type FargateSizing =
  | {
      readonly ok: true;
      /** The size name the entry used, or `null` for a custom pair or none. */
      readonly sizeName: SizeName | null;
      readonly pair: FargatePair;
    }
  | { readonly ok: false; readonly refusal: PlanRefusal };

/**
 * Every CPU Fargate allows (Linux), with each memory it allows beside it, in
 * MiB ascending. AWS's table, as published for task definitions; a pair
 * outside it is refused by `RegisterTaskDefinition`, so the plan has to land
 * on one of these rather than pass the config's pair through.
 */
const FARGATE_PAIRS: readonly {
  readonly cpuUnits: number;
  readonly memories: readonly number[];
}[] = [
  { cpuUnits: 256, memories: [512, 1024, 2048] },
  { cpuUnits: 512, memories: steps(1024, 4096, 1024) },
  { cpuUnits: 1024, memories: steps(2048, 8192, 1024) },
  { cpuUnits: 2048, memories: steps(4096, 16384, 1024) },
  { cpuUnits: 4096, memories: steps(8192, 30720, 1024) },
  { cpuUnits: 8192, memories: steps(16384, 61440, 4096) },
  { cpuUnits: 16384, memories: steps(32768, 122880, 8192) },
];

function steps(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  for (let memory = min; memory <= max; memory += step) out.push(memory);
  return out;
}

/** The largest pair, for the refusal's wording. */
const LARGEST: FargatePair = { cpuUnits: 16384, memoryMb: 122880 };

/** An entry with no `size` is created at `xsmall`'s pair. */
const NO_SIZE: FargatePair = { cpuUnits: 256, memoryMb: 512 };

/**
 * The Fargate pair a config entry's size runs at (the AWS spec, "Sizes on Fargate").
 *
 * A named size is already an allowed pair, so it maps exactly. A custom pair
 * lands on the smallest allowed pair at least as large in both, the rule
 * `CONTEXT.md` **Size** states for Cloud Run and database machine types. The
 * search walks CPU steps from the smallest and takes the first one that can
 * also hold the memory: each CPU step's least memory is at least the one
 * before it, so the first such step is also the one needing the least memory,
 * and "smallest" never has to trade CPU against memory.
 *
 * A pair above Fargate's largest is refused, naming the entry, rather than
 * capped: running a Service at less than its config states is the silent
 * misreading the size rule exists to prevent. With no size the pair is
 * `xsmall`'s; after creation that choice is Cloudgate's, like an uncovered cap.
 */
export function fargateSize(
  entryName: string,
  size: Size | undefined,
): FargateSizing {
  if (!size) return { ok: true, sizeName: null, pair: NO_SIZE };

  // `cpu` carries at most nine decimals (`sizeWireSchema`), so rounding away
  // the float's tail before the ceiling keeps 0.25 at exactly 256 units.
  const wantUnits = Math.ceil(Math.round(size.cpu * 1024 * 1e6) / 1e6);
  for (const row of FARGATE_PAIRS) {
    if (row.cpuUnits < wantUnits) continue;
    const memoryMb = row.memories.find((memory) => memory >= size.memoryMb);
    if (memoryMb === undefined) continue;
    return {
      ok: true,
      sizeName: size.name ?? null,
      pair: { cpuUnits: row.cpuUnits, memoryMb },
    };
  }

  return {
    ok: false,
    refusal: {
      at: `${entryName}.size`,
      message:
        `${entryName}: size ${size.cpu} CPU / ${formatMemory(size.memoryMb)} ` +
        `is above Fargate's largest pair, ${formatPair(LARGEST)}`,
    },
  };
}

/**
 * Why Fargate runs no task at `pair`, or `null` when its table has it
 * a pair a `native.aws` lays is checked against the same table a
 * size lands on, so one outside it is refused at plan time rather than by
 * `RegisterTaskDefinition` at deploy. Names what the pair's CPU takes, the
 * valid pairs nearest it.
 */
export function fargatePairProblem(pair: FargatePair): string | null {
  const row = FARGATE_PAIRS.find((one) => one.cpuUnits === pair.cpuUnits);
  if (!row) {
    return `Fargate runs no task at ${formatCpu(pair.cpuUnits)}: a task's cpu is one of ${FARGATE_PAIRS.map((one) => `${one.cpuUnits} (${formatCpu(one.cpuUnits)})`).join(', ')}`;
  }
  if (row.memories.includes(pair.memoryMb)) return null;
  return `Fargate runs no task at ${formatPair(pair)}: ${formatCpu(row.cpuUnits)} takes ${memoriesText(row.memories)}`;
}

/** `512 MB, 1 GB or 2 GB`, or `2 GB to 8 GB, in 1 GB steps`. */
function memoriesText(memories: readonly number[]): string {
  if (memories.length <= 3) {
    const texts = memories.map(formatMemory);
    return `${texts.slice(0, -1).join(', ')} or ${texts[texts.length - 1]}`;
  }
  const step = memories[1] - memories[0];
  return `${formatMemory(memories[0])} to ${formatMemory(memories[memories.length - 1])}, in ${formatMemory(step)} steps`;
}

/** A pair as the plan shows it beside the size name: `0.5 vCPU / 1 GB`. */
export function formatPair(pair: FargatePair): string {
  return `${formatCpu(pair.cpuUnits)} / ${formatMemory(pair.memoryMb)}`;
}

/** CPU units as a plan line shows them: `0.5 vCPU`. */
export function formatCpu(cpuUnits: number): string {
  return `${cpuUnits / 1024} vCPU`;
}

/** MiB as a plan line shows them: `1.5 GB`, or `1000 MB` off a half-GB step. */
export function formatMemory(memoryMb: number): string {
  return memoryMb % 512 === 0 ? `${memoryMb / 1024} GB` : `${memoryMb} MB`;
}
