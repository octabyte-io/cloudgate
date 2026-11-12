/**
 * What a tool result may carry: a **declared projection** of its service
 * method's return value, never the value itself (ADR-0024).
 *
 * A projection is data, not a function, so it can be read three ways: applied
 * to a result by the dispatcher, checked at boot by `assertProjection` (the
 * tool registry refuses to start on a violation), and snapshotted as an
 * allow-list by `test/coding-standards/tool-projections.spec.ts`, which makes
 * every new field a reviewed edit.
 *
 * Three kinds of output key, and nothing else:
 *
 * - **fields**, copied from the raw row under their own name or renamed;
 * - **presence flags**, `has<Something>`, a boolean that a secret-bearing
 *   value exists — never a key list, never a count (ADR-0019);
 * - **children**, a nested projection of one raw property. A nested
 *   Environment or Project is only ever `{ id, name }`.
 */

/** A copied field: the raw key, or `[outputKey, rawKey]` to rename it. */
export type FieldSpec<Raw> =
  (keyof Raw & string) | readonly [output: string, from: keyof Raw & string];

export interface ObjectProjection {
  readonly kind: 'object';
  readonly fields: ReadonlyArray<{
    readonly out: string;
    readonly from: string;
  }>;
  readonly presence: ReadonlyArray<{
    readonly out: string;
    readonly from: string;
  }>;
  readonly children: ReadonlyArray<{
    readonly out: string;
    readonly from: string;
    readonly node: Projection;
  }>;
}

export interface ListProjection {
  readonly kind: 'list';
  readonly item: ObjectProjection;
}

export type Projection = ObjectProjection | ListProjection;

/**
 * A child's source when it is built from the same raw row rather than from one
 * of its properties — a flat `projectId`/`projectName` pair nested as
 * `project: { id, name }`.
 */
export const SELF = '$self';

/** One row's projection. */
export function row<Raw>(spec: {
  fields: ReadonlyArray<FieldSpec<Raw>>;
  presence?: Readonly<Record<`has${string}`, keyof Raw & string>>;
  children?: Readonly<
    Record<string, readonly [(keyof Raw & string) | typeof SELF, Projection]>
  >;
}): ObjectProjection {
  return {
    kind: 'object',
    fields: spec.fields.map((field) =>
      typeof field === 'string'
        ? { out: field, from: field }
        : { out: field[0], from: field[1] },
    ),
    presence: Object.entries(spec.presence ?? {}).map(([out, from]) => ({
      out,
      from,
    })),
    children: Object.entries(spec.children ?? {}).map(
      ([out, [from, node]]) => ({ out, from, node }),
    ),
  };
}

/** A list of rows, each projected by `item`. */
export function listOf(item: ObjectProjection): ListProjection {
  return { kind: 'list', item };
}

/** Whether a secret-bearing value is there at all: non-empty text, a non-empty object. */
function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/** Applies a projection. A value it does not name cannot come out of it. */
export function project(node: Projection, raw: unknown): unknown {
  if (node.kind === 'list') {
    return Array.isArray(raw)
      ? raw.map((item) => project(node.item, item))
      : [];
  }
  if (raw === null || raw === undefined) return null;
  const source = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const { out: key, from } of node.fields) out[key] = source[from] ?? null;
  for (const { out: key, from } of node.presence) {
    out[key] = isPresent(source[from]);
  }
  for (const { out: key, from, node: child } of node.children) {
    out[key] = project(child, from === SELF ? source : source[from]);
  }
  return out;
}

/**
 * Every output path a projection can produce — `services[].serviceId` for a
 * field of a listed child — sorted. The census freezes this per tool.
 */
export function allowList(node: Projection, prefix = ''): string[] {
  if (node.kind === 'list') return allowList(node.item, `${prefix}[]`);
  const at = (key: string) => (prefix ? `${prefix}.${key}` : key);
  return [
    ...node.fields.map(({ out }) => at(out)),
    ...node.presence.map(({ out }) => at(out)),
    ...node.children.flatMap(({ out, node: child }) =>
      allowList(child, at(out)),
    ),
  ].sort();
}

/**
 * Output paths that share an encrypted column's *name* and never its value,
 * keyed `<tool> <path>`, each with why. The secret-name rule below is by name
 * alone, across the whole schema, so a public value whose right name happens to
 * be some other table's secret column would otherwise be refused at boot.
 * Exact paths only: the same name anywhere else is still refused. Frozen by
 * `test/coding-standards/tool-projections.spec.ts`.
 */
export const PUBLIC_NAMESAKES: Readonly<Record<string, string>> = {
  'get_service aiModel.endpoint':
    "an AI model's URL on the gateway, built from the platform host URL and its Application id, never read from a column; it shares its name with a custom Notification channel's encrypted endpoint and nothing else",
};

/** Nested references that may only ever be `{ id, name }`. */
const REFERENCE_KEYS = new Set(['project', 'environment']);

/**
 * The boot check. Throws, naming the tool, when a projection:
 *
 * - copies a field, or nests a child, under or from the name of an
 *   encrypted-at-rest column (`secretNames`, derived from the schema by
 *   `SecretMask`), so a secret can only ever appear as a presence flag —
 *   unless the exact path is one of the `PUBLIC_NAMESAKES`;
 * - names a presence flag anything but `has<Something>`;
 * - nests a Project or Environment as anything but `{ id, name }`;
 * - produces one output key twice.
 */
export function assertProjection(
  tool: string,
  node: Projection,
  secretNames: ReadonlySet<string>,
  prefix = '',
): void {
  const fail = (why: string) => {
    throw new Error(`MCP tool ${tool}: projection ${why}`);
  };
  const item = node.kind === 'list' ? node.item : node;
  const base = node.kind === 'list' ? `${prefix}[]` : prefix;
  const at = (key: string) => (base ? `${base}.${key}` : key);
  const outputs = [
    ...item.fields.map(({ out }) => out),
    ...item.presence.map(({ out }) => out),
    ...item.children.map(({ out }) => out),
  ];
  const duplicate = outputs.find((key, i) => outputs.indexOf(key) !== i);
  if (duplicate) fail(`produces "${duplicate}" twice`);
  for (const { out, from } of [...item.fields, ...item.children]) {
    if (`${tool} ${at(out)}` in PUBLIC_NAMESAKES) continue;
    if (secretNames.has(out) || secretNames.has(from)) {
      fail(
        `carries "${from}" as "${out}", the name of an encrypted column; a secret appears only as a has* presence flag`,
      );
    }
  }
  for (const { out } of item.presence) {
    if (!/^has[A-Z]/.test(out))
      fail(`names presence flag "${out}" without has*`);
  }
  for (const { out, node: child } of item.children) {
    if (REFERENCE_KEYS.has(out)) {
      const shape =
        child.kind === 'object'
          ? [...allowList(child)].sort().join(',')
          : 'a list';
      if (shape !== 'id,name') {
        fail(`nests ${out} as ${shape}; a nested ${out} is only { id, name }`);
      }
    }
    assertProjection(tool, child, secretNames, at(out));
  }
}
