import { literal } from '../cloud-accounts/definitions/tofu-json';
import type { NativeFieldDiff, NativeRefusal } from './native-shared';
import { once, pathText } from './provider-schema';
import type { PathPart, SchemaBlock, SchemaType } from './provider-schema';

/**
 * **Laying a cloud native block over Cloudgate's definition** (ADR-0044
 * rule 3): the merge every cloud's builders share, `native.aws` first
 * (`aws-lay.ts`) and `native.gcp` with it, run before `main.tf.json` is
 * written, never by an OpenTofu override file (ADR-0044, Rejected).
 *
 * One resource's arguments, read against the committed provider schema
 * that the check (`provider-schema.ts`) reads, so the two agree on every
 * shape:
 *
 * - a plain value replaces Cloudgate's;
 * - a block the provider allows once is merged field by field, so
 *   `health_check.path` keeps Cloudgate's `matcher`;
 * - a map attribute is merged key by key;
 * - a real list (an attribute list or set, or a block allowed many times)
 *   replaces Cloudgate's whole: no appending, no pointing at one item.
 *
 * A key the native block leaves out is Cloudgate's, and Cloudgate's own
 * `lifecycle` is never touched: the check refuses every meta-argument.
 *
 * **Escaped as laid.** In OpenTofu's JSON syntax every string is a template,
 * keys of an object value included, so each string a native value holds is
 * laid with `${` and `%{` escaped ({@link escapeTemplates}): a value reaches
 * the cloud as written and is never evaluated as a reference. The check
 * takes values as written; escaping is the lay's.
 *
 * It also reads one native value as **leaves**, the parts a plan shows one
 * line each of: a block's field, a map's key, a list or plain value whole.
 */

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A value with every string in it, and every object key, escaped for a template. */
export function escapeTemplates(value: unknown): unknown {
  if (typeof value === 'string') return literal(value);
  if (Array.isArray(value)) return value.map(escapeTemplates);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        literal(key),
        escapeTemplates(inner),
      ]),
    );
  }
  return value;
}

/** A block allowed once, as one object, whether written as one or as a list of one. */
function single(value: unknown): Record<string, unknown> | undefined {
  if (isObject(value)) return value;
  if (Array.isArray(value) && value.length === 1 && isObject(value[0])) {
    return value[0];
  }
  return undefined;
}

const isMap = (type: SchemaType | undefined) =>
  Array.isArray(type) && type[0] === 'map';

/**
 * One resource's native arguments laid over Cloudgate's `body` by the
 * provider's `block` schema. Pure: `body` is not changed. A block allowed
 * once keeps the form Cloudgate wrote it in (an object, or a list of one).
 */
export function layArguments(
  block: SchemaBlock,
  body: Readonly<Record<string, unknown>>,
  native: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const laid: Record<string, unknown> = { ...body };
  const attributes = block.attributes ?? {};
  const blocks = block.block_types ?? {};
  for (const [key, value] of Object.entries(native)) {
    const attribute = Object.hasOwn(attributes, key)
      ? attributes[key]
      : undefined;
    const nested = Object.hasOwn(blocks, key) ? blocks[key] : undefined;
    const ours = body[key];
    if (attribute && isMap(attribute.type) && isObject(value)) {
      laid[key] = {
        ...(isObject(ours) ? ours : {}),
        ...(escapeTemplates(value) as Record<string, unknown>),
      };
    } else if (nested && once(nested) && single(value)) {
      const merged = layArguments(
        nested.block,
        single(ours) ?? {},
        single(value)!,
      );
      laid[key] = Array.isArray(ours) ? [merged] : merged;
    } else {
      laid[key] = escapeTemplates(value);
    }
  }
  return laid;
}

/**
 * A native object laid over Cloudgate's where no provider schema says its
 * shape, as the one ECS container is (`container_definitions`, ECS's own
 * JSON): an object merged key by key at every depth (a struct such as
 * `healthCheck` field by field, a map such as `dockerLabels` key by key),
 * a list or plain value replacing Cloudgate's whole.
 */
export function layObject(ours: unknown, native: unknown): unknown {
  if (!isObject(native)) return escapeTemplates(native);
  const laid: Record<string, unknown> = isObject(ours) ? { ...ours } : {};
  for (const [key, value] of Object.entries(native)) {
    const escaped = literal(key);
    laid[escaped] = layObject(laid[escaped], value);
  }
  return laid;
}

// ── Leaves, for the plan ──

/** One part of a native value a plan shows a line of. */
export interface NativeLeaf {
  readonly path: readonly PathPart[];
  readonly value: unknown;
}

/**
 * One resource's native arguments as leaves, by the same schema the lay
 * reads: a block allowed once by its fields, a map attribute by its keys,
 * anything else whole. `at` prefixes every path.
 */
export function argumentLeaves(
  block: SchemaBlock,
  value: Readonly<Record<string, unknown>>,
  at: readonly PathPart[] = [],
): NativeLeaf[] {
  const attributes = block.attributes ?? {};
  const blocks = block.block_types ?? {};
  return Object.entries(value).flatMap(([key, inner]): NativeLeaf[] => {
    const path = [...at, key];
    const attribute = Object.hasOwn(attributes, key)
      ? attributes[key]
      : undefined;
    const nested = Object.hasOwn(blocks, key) ? blocks[key] : undefined;
    if (attribute && isMap(attribute.type) && isObject(inner)) {
      return Object.entries(inner).map(([name, item]) => ({
        path: [...path, name],
        value: item,
      }));
    }
    const one = nested && once(nested) ? single(inner) : undefined;
    if (nested && one) return argumentLeaves(nested.block, one, path);
    return [{ path, value: inner }];
  });
}

/** A schema-less native object's leaves ({@link layObject}'s shape). */
export function objectLeaves(
  value: unknown,
  at: readonly PathPart[] = [],
): NativeLeaf[] {
  if (!isObject(value)) return [{ path: at, value }];
  return Object.entries(value).flatMap(([key, inner]) =>
    objectLeaves(inner, [...at, key]),
  );
}

/**
 * The value at `path` in Cloudgate's own definition, or `undefined` where
 * it writes none; through a block written as a list of one.
 */
export function valueAt(value: unknown, path: readonly PathPart[]): unknown {
  let at: unknown = value;
  for (const part of path) {
    if (typeof part === 'string' && Array.isArray(at) && at.length === 1) {
      at = at[0];
    }
    if (typeof part === 'number') {
      if (!Array.isArray(at)) return undefined;
      at = at[part];
    } else {
      if (!isObject(at) || !Object.hasOwn(at, part)) return undefined;
      at = at[part];
    }
  }
  return at;
}

/** A JSON value with its object keys sorted, so equal values compare equal. */
export function canonical(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, inner: unknown) =>
    isObject(inner)
      ? Object.fromEntries(
          Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)),
        )
      : inner,
  );
}

// ── A plan's native lines and a deploy's blame, on every cloud ──

/** A cloud native block: each address's provider arguments. */
export type CloudNativeBlock = Readonly<
  Record<string, Readonly<Record<string, unknown>>>
>;

/**
 * How one cloud reads its block: its spelling in the file, the cloud's name
 * as a refusal says it, and one address as leaves. The one per-cloud value
 * the plan's lines, the replace rule and the deploy's refusal and blame
 * read (ADR-0043's reopen condition: the halves are one implementation
 * over this table, not two).
 */
export interface NativeReading {
  /** `native.aws` or `native.gcp`. */
  readonly prefix: string;
  /** `AWS` or `Google Cloud`: who refused, in a deploy's blame. */
  readonly refusedBy: string;
  readonly leavesOf: (
    address: string,
    native: Readonly<Record<string, unknown>> | undefined,
  ) => NativeLeaf[];
}

/**
 * The native lines of one Service's step: every leaf
 * `wanted` lays whose value differs from what `stored` (the block its last
 * Apply laid) laid, in address order as written, then leaf order. `stored`
 * is `undefined` on a create. A side with no native value is Cloudgate's
 * own, read by `cloudgateAt` from the definition its builder writes with
 * no native block (`null`, shown `default (none)`, where it writes none or
 * is not known), so removing a key plans its return to Cloudgate's value
 * as a line, never silently (ADR-0044 rule 6).
 */
export function nativeLeafDiffs(
  reading: NativeReading,
  wanted: CloudNativeBlock | null | undefined,
  stored: CloudNativeBlock | null | undefined,
  cloudgateAt: (address: string, path: readonly PathPart[]) => unknown,
  consoleOwned: (address: string, path: readonly PathPart[]) => boolean = () =>
    false,
  /**
   * A size-bearing argument of an entry with a `size` (`size-override.ts`):
   * where native sets none, the size's value stands, shown `size (<value>)`, so taking it out reads as a fall back to it.
   */
  sizeBorne: (address: string, path: readonly PathPart[]) => boolean = () =>
    false,
): NativeFieldDiff[] {
  const addresses = [
    ...new Set([...Object.keys(wanted ?? {}), ...Object.keys(stored ?? {})]),
  ];
  const key = (path: readonly PathPart[]) => JSON.stringify(path);
  const diffs: NativeFieldDiff[] = [];
  for (const address of addresses) {
    const want = new Map(
      reading
        .leavesOf(address, wanted?.[address])
        .map((leaf) => [key(leaf.path), leaf]),
    );
    const have = new Map(
      reading
        .leavesOf(address, stored?.[address])
        .map((leaf) => [key(leaf.path), leaf]),
    );
    const paths = new Map<string, readonly PathPart[]>();
    for (const leaves of [want, have]) {
      for (const [id, leaf] of leaves) paths.set(id, leaf.path);
    }
    for (const [id, path] of paths) {
      const fallback = cloudgateAt(address, path) ?? null;
      const to = want.has(id) ? want.get(id)!.value : fallback;
      const from = have.has(id) ? have.get(id)!.value : fallback;
      // A setting the console owned: where native sets none, the
      // console's value stands, and a key taken out is handed back to it,
      // a line even when the value stays where it is.
      const console = consoleOwned(address, path);
      const handedBack = console && have.has(id) && !want.has(id);
      if (!handedBack && canonical(to) === canonical(from)) continue;
      const sized = sizeBorne(address, path);
      diffs.push({
        field: `${reading.prefix}.${JSON.stringify(address)}${pathText(path)}`,
        from,
        to,
        native: true,
        ...(have.has(id)
          ? {}
          : sized
            ? { fromSize: true as const }
            : console
              ? { fromConsole: true as const }
              : { fromDefault: true as const }),
        ...(want.has(id)
          ? {}
          : sized
            ? { toSize: true as const }
            : console
              ? { toConsole: true as const }
              : { toDefault: true as const }),
      });
    }
  }
  return diffs;
}

// ── Replace, on every cloud ──

/** One resource as a cloud plan's reading lists it. */
export interface PlannedResource {
  readonly address: string;
  readonly action: string;
  /** On a replace, the arguments that force it. */
  readonly fields: readonly string[];
}

/**
 * **Losing data is refused by one rule** (ADR-0044 rule 10): each leaf of `block` the cloud plan (`raw`, the read's
 * resource lines) carries out as a replace of an address holding data
 * (`dataHolding`, with what its replace loses), refused by its full path. A
 * replace Cloudgate's own definition forces, on an argument the block does
 * not set, is not native's, so is not refused here. Read from the plan's
 * actions, not a per-setting list: only OpenTofu knows which values
 * replace, so a provider that adds one is covered on the day it ships. A
 * replace whose read names no argument forcing it names every leaf
 * the block sets on that address, since one of them moved it.
 */
export function replaceRefusals(
  reading: NativeReading,
  dataHolding: Readonly<Record<string, string>>,
  configName: string,
  block: CloudNativeBlock | null | undefined,
  raw: readonly PlannedResource[],
): NativeRefusal[] {
  if (!block) return [];
  return raw.flatMap((line) => {
    const loses = Object.hasOwn(dataHolding, line.address)
      ? dataHolding[line.address]
      : undefined;
    const native = Object.hasOwn(block, line.address)
      ? block[line.address]
      : undefined;
    if (line.action !== 'replace' || !loses || !native) return [];
    return reading
      .leavesOf(line.address, native)
      .filter(
        (leaf) =>
          line.fields.length === 0 ||
          line.fields.includes(String(leaf.path[0])),
      )
      .map((leaf) => {
        const at = `${configName}.${reading.prefix}.${JSON.stringify(line.address)}${pathText(leaf.path)}`;
        return {
          at,
          message: `${at}: refused - OpenTofu would replace ${loses}`,
        };
      });
  });
}

/** A name with its case, dots and underscores taken away, as a cloud and its provider each spell it. */
const squashed = (name: string) => name.replace(/[_.\-\s]/g, '').toLowerCase();

/** Shorter than this, a name (`path`, `enable`) is too common a word to blame. */
const NAMED = 10;

/**
 * Whether `words` name a leaf: one of its paths' tails, from the last part
 * back, in either spelling (`health_check_grace_period_seconds`,
 * `healthCheckGracePeriodSeconds`, `healthCheck.retries`).
 */
function names(words: string, path: readonly PathPart[]): boolean {
  const parts = path.filter((part): part is string => typeof part === 'string');
  return parts.some((_part, start) => {
    const tail = squashed(parts.slice(start).join(''));
    return tail.length >= NAMED && words.includes(tail);
  });
}

/**
 * A stored block that now holds a locked value, or one the provider
 * Cloudgate runs no longer has, fails its Service's Deployment naming each
 * of the checker's `refusals` (ADR-0044 rule 9), on every cloud: a
 * value that predates the lock list never slips through, and is never
 * stripped. `null` when there are none.
 */
export function storedRefusal(
  reading: NativeReading,
  refusals: readonly { readonly message: string }[],
): string | null {
  if (refusals.length === 0) return null;
  return `This Service's stored ${reading.prefix} is refused, so nothing was changed: ${refusals.map((one) => one.message).join('; ')}. Correct the Project config and apply its plan`;
}

/**
 * A value only the cloud can judge fails that Service's Deployment
 * **naming the native path** (ADR-0044 rule 5), on every cloud: when
 * the refusal names a leaf the stored block sets ({@link blamedPaths}),
 * the message names each such path before the cloud's own sentence. Any
 * other refusal is returned as it was.
 */
export function blamedMessage(
  reading: NativeReading,
  message: string,
  stored: CloudNativeBlock | null | undefined,
): string {
  const blamed = blamedPaths(reading, message, stored);
  if (blamed.length === 0) return message;
  return `${reading.refusedBy} refused this Service's ${blamed.join(', ')}: ${message}`;
}

/**
 * The paths of a stored block, in the file's spelling, that a cloud's
 * refusal names (ADR-0044 rule 5): what a value only the cloud can
 * judge fails its Deployment naming. Empty when it names none.
 */
export function blamedPaths(
  reading: NativeReading,
  message: string,
  stored: CloudNativeBlock | null | undefined,
): string[] {
  if (!stored) return [];
  const words = squashed(message);
  return Object.entries(stored).flatMap(([address, native]) =>
    reading
      .leavesOf(address, native)
      .filter((leaf) => names(words, leaf.path))
      .map(
        (leaf) =>
          `${reading.prefix}.${JSON.stringify(address)}${pathText(leaf.path)}`,
      ),
  );
}
