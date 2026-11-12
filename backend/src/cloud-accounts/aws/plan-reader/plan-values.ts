/**
 * Comparing and rendering the values inside a `tofu show -json` change, for
 * the plan reader only. A *path* is the attribute names from the resource's
 * top level down through nested objects, joined with `.`; lists and sets are
 * compared whole, because OpenTofu's own indexes into a set mean nothing to a
 * person and a security group's `ingress` reads better as one value.
 */

export type Path = readonly string[];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `null`, `{}` and `[]` are one value. The moto trial's `resource_drift` marked
 * every untouched resource with `tags: null → {}`, and a config that sets no
 * tags plans `null` where AWS reads back `{}`; neither is anything a person did.
 * `""` too: a replace plans `null` for every optional string the config does
 * not set, where the state holds the `""` AWS read back (the moto lane's
 * replaced SSM parameter: `description`, `allowed_pattern`).
 */
function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  return isPlainObject(value) && Object.keys(value).length === 0;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (isEmpty(a) && isEmpty(b)) return true;
  return stableJson(a) === stableJson(b);
}

/** JSON with object keys sorted, so equal values print equal. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    isPlainObject(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
}

export function valueAt(value: unknown, path: Path): unknown {
  let at = value;
  for (const key of path) {
    if (Array.isArray(at)) at = at[Number(key)];
    else if (isPlainObject(at)) at = at[key];
    else return undefined;
  }
  return at;
}

/**
 * Whether an OpenTofu mask (`after_unknown`, `*_sensitive`) marks anything at
 * or under `path`: `true` on the way down covers everything below it, and an
 * object or list holding a `true` anywhere covers the whole value at `path`,
 * since lists are shown whole.
 */
export function maskCovers(mask: unknown, path: Path): boolean {
  let at = mask;
  for (const key of path) {
    if (at === true) return true;
    if (!isPlainObject(at)) return false;
    at = at[key];
  }
  return holdsTrue(at);
}

function holdsTrue(mask: unknown): boolean {
  if (mask === true) return true;
  if (Array.isArray(mask)) return mask.some(holdsTrue);
  if (isPlainObject(mask)) return Object.values(mask).some(holdsTrue);
  return false;
}

/**
 * Every path whose value differs between `before` and `after`, or that
 * `unknown` marks as not known until apply. Descends only where both sides
 * (and the unknown mask, when it is an object) are objects.
 */
export function changedPaths(
  before: unknown,
  after: unknown,
  unknown: unknown = undefined,
  path: Path = [],
): Path[] {
  if (unknown === true) return [path];
  const descend =
    (isPlainObject(before) || before == null) &&
    (isPlainObject(after) || after == null) &&
    (isPlainObject(before) || isPlainObject(after)) &&
    !(path.length > 0 && (before == null || after == null));
  if (!descend) {
    if (holdsTrue(unknown)) return [path];
    return sameValue(before, after) ? [] : [path];
  }
  const b: Record<string, unknown> = isPlainObject(before) ? before : {};
  const a: Record<string, unknown> = isPlainObject(after) ? after : {};
  const u = isPlainObject(unknown) ? unknown : {};
  const keys = new Set([
    ...Object.keys(b),
    ...Object.keys(a),
    ...Object.keys(u),
  ]);
  return [...keys]
    .sort()
    .flatMap((key) => changedPaths(b[key], a[key], u[key], [...path, key]));
}

/**
 * {@link changedPaths}, descending into lists as well, element by element,
 * where both sides are lists of the same length: `origin.0.origin_access_control_id`
 * rather than the whole `origin`. A list that grew or shrank is still one path.
 */
export function changedLeafPaths(
  before: unknown,
  after: unknown,
  unknown: unknown = undefined,
  path: Path = [],
): Path[] {
  if (
    Array.isArray(before) &&
    Array.isArray(after) &&
    before.length === after.length
  ) {
    const u = Array.isArray(unknown) ? unknown : [];
    return before.flatMap((item, index) =>
      changedLeafPaths(item, after[index], u[index], [...path, String(index)]),
    );
  }
  if (unknown === true) return [path];
  if (!isPlainObject(before) || !isPlainObject(after)) {
    return changedPaths(before, after, unknown, path);
  }
  const u = isPlainObject(unknown) ? unknown : {};
  const keys = new Set([
    ...Object.keys(before),
    ...Object.keys(after),
    ...Object.keys(u),
  ]);
  return [...keys]
    .sort()
    .flatMap((key) =>
      changedLeafPaths(before[key], after[key], u[key], [...path, key]),
    );
}

export function pathText(path: Path): string {
  return path.join('.');
}

/** Whether `a` is `b`, or one lies inside the other. */
export function overlaps(a: Path, b: Path): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}

export const SENSITIVE = '(sensitive)';
export const KNOWN_AFTER_APPLY = '(known after apply)';
export const STAND_IN_TEXT = 'made by this plan (Environment network)';
const NONE = '(none)';
const MAX_VALUE_LENGTH = 300;

/**
 * One value as a person reads it. A string is shown bare, anything else as
 * JSON with its keys sorted; a stand-in id anywhere inside it reads as made
 * by this plan. Long values are cut, since a whole JSON document in a drift
 * line hides the field that moved rather than showing it.
 */
export function renderValue(
  value: unknown,
  standIns: ReadonlySet<string>,
): string {
  if (isEmpty(value) || value === '') return NONE;
  let text = typeof value === 'string' ? value : stableJson(value);
  for (const standIn of standIns)
    text = text.split(standIn).join(STAND_IN_TEXT);
  return text.length > MAX_VALUE_LENGTH
    ? `${text.slice(0, MAX_VALUE_LENGTH)}…`
    : text;
}

/** Every top-level field whose value holds a stand-in id. */
export function fieldsHolding(
  value: unknown,
  standIns: ReadonlySet<string>,
): string[] {
  if (!isPlainObject(value) || standIns.size === 0) return [];
  return Object.keys(value).filter((key) => {
    const text = JSON.stringify(value[key]) ?? '';
    for (const standIn of standIns) if (text.includes(standIn)) return true;
    return false;
  });
}
