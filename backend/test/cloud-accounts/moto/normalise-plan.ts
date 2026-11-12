import type { TofuShow } from '../../../src/cloud-accounts/cloud.port';

/**
 * A plan as the moto lane stores it: what changes from one run to the
 * next made the same in every run, so a re-saved file differs from the
 * committed one only where tofu, the provider or a definition changed what
 * it prints, and a reviewer can read that diff.
 *
 * - every timestamp reads {@link FIXED_TIME};
 * - the network's default certificate and key, made anew for every run
 *   (`certificate_body`, `private_key`), are one fixed placeholder each;
 * - every id moto made up — hex runs in resource ids and ARNs, UUIDs, IAM's
 *   unique ids, Cloud Map's `ns-`/`srv-` ids — is replaced by a counter of the same length and alphabet,
 *   so an id still has the shape the provider and the plan reader expect,
 *   and two mentions of one id are still one id. They are numbered in an
 *   order no run changes: first the ids the caller names (`known`, the
 *   network's saved ids in a Service's plan), then each resource's own in
 *   the refreshed state by address, then the rest as the file mentions them;
 * - moto's address, which the provider block's `endpoints` carry into the
 *   plan's `configuration`, is {@link MOTO_URL};
 * - what is printed in no fixed order is put in one ({@link canonical}).
 *
 * Nothing else is touched: the values a definition wrote, and the ones moto
 * fixes (the account, the region, AZ names), stay as they were printed.
 */
export function normalisePlan(
  show: TofuShow,
  run: { readonly motoUrl: string; readonly known: readonly string[] },
): TofuShow {
  const ids = new Map<string, string>();
  const counters = new Map<string, number>();
  const stable = (kind: string, id: string, make: (n: number) => string) => {
    const known = ids.get(id);
    if (known) return known;
    const n = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, n);
    const made = make(n);
    ids.set(id, made);
    return made;
  };
  const padded = (n: number, length: number, radix: number) =>
    n.toString(radix).padStart(length, '0');

  const text = (value: string): string =>
    value
      .split(run.motoUrl)
      .join(MOTO_URL)
      .replace(TIMESTAMP, FIXED_TIME)
      .replace(UUID, (id) =>
        stable(
          'uuid',
          id,
          (n) => `00000000-0000-4000-8000-${padded(n, 12, 16)}`,
        ),
      )
      .replace(IAM_UNIQUE_ID, (id, prefix: string) =>
        stable(
          prefix,
          id,
          (n) =>
            `${prefix}${padded(n, id.length - prefix.length, 36).toUpperCase()}`,
        ),
      )
      .replace(CLOUD_MAP_ID, (id, prefix: string) =>
        stable(
          `cloudmap-${prefix}`,
          id,
          (n) => `${prefix}-${padded(n, id.length - prefix.length - 1, 36)}`,
        ),
      )
      .replace(HEX_ID, (id) =>
        stable(`hex${id.length}`, id, (n) => padded(n, id.length, 16)),
      )
      .replace(CALLER_REFERENCE, (id) =>
        stable('caller', id, (n) => `terraform-${padded(n, 26, 10)}`),
      )
      .replace(CLOUDFRONT_ID, (id) =>
        stable(
          `cloudfront${id.length}`,
          id,
          (n) => `E${padded(n, id.length - 1, 36).toUpperCase()}`,
        ),
      )
      .replace(CLOUDFRONT_DOMAIN, (id) =>
        stable(
          `cfdomain${id.length}`,
          id,
          (n) => `d${padded(n, id.length - 1, 36)}`,
        ),
      );

  const walk = (value: unknown, key: string): unknown => {
    if (typeof value === 'string') {
      return DEFAULT_CERTIFICATE_FIELDS.has(key)
        ? value.replace(PEM, pemPlaceholder)
        : text(value);
    }
    if (Array.isArray(value)) return value.map((item) => walk(item, ''));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([k, inner]) => [k, walk(inner, k)]),
      );
    }
    return value;
  };
  // Number the ids in a fixed order before anything else mentions them.
  for (const id of run.known) text(id);
  const state = show as {
    prior_state?: {
      values?: {
        root_module?: { resources?: { address: string; values?: unknown }[] };
      };
    };
  };
  const resources = [
    ...(state.prior_state?.values?.root_module?.resources ?? []),
  ].sort((a, b) => (a.address < b.address ? -1 : 1));
  for (const resource of resources) ordered(resource.values, text);

  return canonical(walk(show, ''), '') as TofuShow;
}

/**
 * The orders tofu and the provider print differently from run to run, made
 * one: the lists under {@link UNORDERED} (sets, the `references` of an
 * expression, the plan's `relevant_attributes`) sorted, and the keys inside a JSON string such as a task's
 * `container_definitions` sorted. Run after the ids are renumbered, so the
 * sort is on the stable ids.
 */
function canonical(value: unknown, key: string): unknown {
  if (typeof value === 'string') return sortedJson(value);
  if (Array.isArray(value)) {
    const items = value.map((item) => canonical(item, ''));
    if (!UNORDERED.has(key)) return items;
    return items
      .map((item) => [JSON.stringify(item), item] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, item]) => item);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, inner]) => [k, canonical(inner, k)]),
    );
  }
  return value;
}

/**
 * Every string in a value, keys in sorted order and the lists under
 * {@link UNORDERED} left out, so the visit is the same in every run.
 */
function ordered(value: unknown, visit: (text: string) => unknown, key = '') {
  if (typeof value === 'string') visit(value);
  else if (Array.isArray(value)) {
    if (!UNORDERED.has(key)) for (const item of value) ordered(item, visit);
  } else if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    for (const k of Object.keys(object).sort()) ordered(object[k], visit, k);
  }
}

/** A string holding a JSON object or array, its keys sorted; any other string as it is. */
function sortedJson(text: string): string {
  if (!/^\s*[[{]/.test(text)) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const sortKeys = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sortKeys)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(sortKeys(parsed));
}

/** Lists whose order means nothing, by their key. */
const UNORDERED = new Set([
  'references',
  'relevant_attributes',
  'depends_on',
  'subnets',
  'security_groups',
  // A DB or cache subnet group's subnets, a set.
  'subnet_ids',
  // The load balancer's subnets, a set the provider prints in either order.
  'subnet_mapping',
]);

/** Where a stored plan says moto was, whatever port it had. */
export const MOTO_URL = 'http://moto:5000';

/** What every timestamp in a stored plan reads. */
export const FIXED_TIME = '2026-01-01T00:00:00Z';

/** Where the network's default certificate and key are printed (`aws_acm_certificate.default`). */
const DEFAULT_CERTIFICATE_FIELDS = new Set(['certificate_body', 'private_key']);

function pemPlaceholder(_: string, label: string): string {
  return [
    `-----BEGIN ${label}-----`,
    'cmUtc2F2ZWQgYnkgdGhlIG1vdG8gbGFuZTsgbWFkZSBhbmV3IGVhY2ggcnVu',
    `-----END ${label}-----`,
    '',
  ].join('\n');
}

const PEM = /-----BEGIN ([A-Z ]+)-----\r?\n[\s\S]*?-----END \1-----(?:\r?\n)?/g;

const TIMESTAMP =
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;

const UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;

/** IAM's role and policy ids (`AROA…`, `ANPA…`): 21 characters, upper case. */
const IAM_UNIQUE_ID = /\b(AROA|ANPA|AIDA|AGPA)[A-Z0-9]{17}\b/g;

/**
 * A run of 8 or more lower-case hex digits holding at least one digit and
 * one letter: moto's resource ids (`vpc-…`, `sg-…`) and the random parts of
 * its ARNs and names. A run of digits alone (an account, a port) or letters
 * alone (a word) is never one.
 */
/**
 * A Cloud Map namespace's or service's id: `ns-` or `srv-` and a
 * lower-case base-36 run, which {@link HEX_ID} does not take, so a
 * `web-private`'s plans printed a new one every run. Replaced before
 * {@link HEX_ID}, which would take a run that happened to be all hex.
 */
const CLOUD_MAP_ID = /(?<![0-9A-Za-z-])(ns|srv)-[0-9a-z]{8,32}(?![0-9A-Za-z])/g;

const HEX_ID =
  /(?<![0-9a-z])(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{8,}(?![0-9a-z])/g;

/**
 * moto's CloudFront ids and ETags: 13 upper-case letters and digits,
 * at least one of each. Not 14: a Route 53 hosted zone id AWS fixes
 * (`Z21DNDUVLTQW6Q`, `Z2FDTNDATAQYW2`) is, and stays as printed.
 */
const CLOUDFRONT_ID =
  /(?<![0-9A-Za-z])(?=[0-9A-Z]*[0-9])(?=[0-9A-Z]*[A-Z])[0-9A-Z]{13}(?![0-9A-Za-z])/g;

/** A distribution's own `<random>.cloudfront.net` name. */
const CLOUDFRONT_DOMAIN = /\b[0-9a-z]{13,14}(?=\.cloudfront\.net\b)/g;

/** The provider's `caller_reference` for a distribution it made: `terraform-` and a timestamp. */
const CALLER_REFERENCE = /\bterraform-\d{26}\b/g;
