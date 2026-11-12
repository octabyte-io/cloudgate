import type { CloudNativeBlock } from './lay';
import { pathText } from './provider-schema';
import type { PathPart } from './provider-schema';

/**
 * **A native size-bearing value wins over `size`** (on AWS and on
 * Google Cloud; ADR-0044 rule 12): the part of exact sizes every
 * cloud shares. Each cloud names its size-bearing arguments in one table
 * ({@link SizeBearingTable}: on AWS `instance_class`, `node_type` and the
 * Fargate task's `cpu` and `memory`; on Google Cloud the Cloud SQL `tier`
 * and Cloud Run's limits), and the rules below read it:
 *
 * - **Native wins on its cloud**; `size` still counts on every other
 *   target, since only the Environment's block is laid.
 * - **The size line** names both: `pg-1 medium → db.r7g.xlarge (4 vCPU,
 *   32 GB), set by native` ({@link sizeOverrideLine}), and a pair that is
 *   native in part marks the part: `2 vCPU (native) / 2 GB`
 *   ({@link pairWording}).
 * - **Taking it out** falls back to `size`; with no `size` it leaves the
 *   machine where it is and hands it back to the console, never to the
 *   smallest ({@link sizeSideOf}). Its line says which: `size (<value>)` or
 *   `console (<value>)`.
 * - **The console** may not change one the config sets natively; each
 *   cloud's console refusal reads the same table.
 */

/** What a size-bearing argument says: the whole machine, or one half of a pair. */
export type SizePart = 'machine' | 'cpu' | 'memory';

/** One size-bearing argument of one generated address. */
export interface SizeBearing {
  readonly address: string;
  /** Its path below the address, in the provider's spelling. */
  readonly path: readonly PathPart[];
  readonly part: SizePart;
}

/** A cloud's size-bearing arguments, and how its block is spelled in the file. */
export interface SizeBearingTable {
  /** `native.aws` or `native.gcp`. */
  readonly prefix: string;
  readonly settings: readonly SizeBearing[];
}

const samePath = (a: readonly PathPart[], b: readonly PathPart[]) =>
  a.length === b.length && a.every((part, at) => part === b[at]);

/** The size-bearing argument at `path` of `address`, or `undefined`. */
export function sizeBearingAt(
  table: SizeBearingTable,
  address: string,
  path: readonly PathPart[],
): SizeBearing | undefined {
  return table.settings.find(
    (one) => one.address === address && samePath(one.path, path),
  );
}

/** The value a block sets at a path, or `undefined` where it sets none. */
function setAt(
  block: CloudNativeBlock | null | undefined,
  address: string,
  path: readonly PathPart[],
): unknown {
  let at: unknown = block?.[address];
  for (const part of path) {
    if (typeof at !== 'object' || at === null) return undefined;
    if (Array.isArray(at) && typeof part === 'string' && at.length === 1) {
      at = at[0] as unknown;
    }
    if (!Object.hasOwn(at as object, part)) return undefined;
    at = (at as Record<PathPart, unknown>)[part];
  }
  return at;
}

/** One size-bearing value a block sets, with its path as the file spells it. */
export interface NativeSize {
  readonly part: SizePart;
  readonly address: string;
  readonly value: unknown;
  /** `native.aws."aws_db_instance.database".instance_class`. */
  readonly path: string;
}

/**
 * The size-bearing values `block` sets, one per argument, in the table's
 * order; of one address only when `address` is given.
 */
export function nativeSizesOf(
  table: SizeBearingTable,
  block: CloudNativeBlock | null | undefined,
  address?: string,
): NativeSize[] {
  return table.settings.flatMap((one) => {
    if (address !== undefined && one.address !== address) return [];
    const value = setAt(block, one.address, one.path);
    if (value === undefined || value === null) return [];
    return [
      {
        part: one.part,
        address: one.address,
        value,
        path: `${table.prefix}.${JSON.stringify(one.address)}${pathText(one.path)}`,
      },
    ];
  });
}

/** The value `block` sets for one part of one address, or `undefined`. */
export function nativeSizeOf(
  table: SizeBearingTable,
  block: CloudNativeBlock | null | undefined,
  address: string,
  part: SizePart,
): NativeSize | undefined {
  return nativeSizesOf(table, block, address).find((one) => one.part === part);
}

/**
 * A pair a native block lays that its cloud does not run, refused by the
 * native paths of the halves it sets (`parts`), or `null` with no
 * `problem` or no half set: the one refusal both clouds'
 * pair checks word, `<path> and <path>: refused - <problem>`.
 */
export function nativePairRefusal(
  table: SizeBearingTable,
  name: string,
  block: CloudNativeBlock | null | undefined,
  address: string,
  parts: readonly ('cpu' | 'memory')[],
  problem: string | null,
): { readonly at: string; readonly message: string } | null {
  if (problem === null || parts.length === 0) return null;
  const paths = parts.map(
    (part) => `${name}.${nativeSizeOf(table, block, address, part)?.path}`,
  );
  return {
    at: paths[0],
    message: `${paths.join(' and ')}: refused - ${problem}`,
  };
}

/** Said after a machine the config sets natively. */
export const SET_BY_NATIVE = 'set by native';

/**
 * The size line of a machine the config sets natively:
 * `pg-1 medium → db.r7g.xlarge (4 vCPU, 32 GB), set by native`. `machine`
 * is its CPU and memory when the cloud's committed class table knows it,
 * else `null`, and the line names the class alone; `sizeName` is `null`
 * for an entry with no size or a custom pair.
 */
export function sizeOverrideLine(
  name: string,
  sizeName: string | null,
  native: string,
  machine: string | null,
): string {
  return `${name}${sizeName ? ` ${sizeName}` : ''} → ${native}${machine ? ` (${machine})` : ''}, ${SET_BY_NATIVE}`;
}

/** One half of a pair as a plan line shows it, and whether native set it. */
export interface PairHalf {
  readonly text: string;
  readonly native: boolean;
}

/**
 * A CPU and memory pair as a plan line shows it, each half native sets
 * marked: `2 vCPU (native) / 2 GB`.
 */
export function pairWording(cpu: PairHalf, memory: PairHalf): string {
  const half = (one: PairHalf) => `${one.text}${one.native ? ' (native)' : ''}`;
  return `${half(cpu)} / ${half(memory)}`;
}

/**
 * Where a size-bearing argument goes when no native value sets it (ADR-0044
 * rules 6 and 12): to the entry's `size` when it has one; with
 * none, on a Service already made, to the console, where it stays at the
 * value it has; on a create, to Cloudgate's own value for no size.
 */
export type SizeSide = 'size' | 'console' | 'default';

export function sizeSideOf(sized: boolean, made: boolean): SizeSide {
  if (sized) return 'size';
  return made ? 'console' : 'default';
}
