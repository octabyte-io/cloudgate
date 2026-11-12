import { z } from 'zod';

import type { NativeFieldDiff, NativeRefusal } from './native-shared';
import {
  dockerLockRefusals,
  formatDockerRefusal,
  isDockerFailureAction,
  isDockerOrder,
  isDockerRestartCondition,
} from './docker-locks';
import type {
  DockerFailureAction,
  DockerLockRole,
  DockerOrder,
  DockerRestartCondition,
} from './docker-locks';
import type { ConfigKind } from '../project-config/planner/plan.types';

/**
 * **`native.docker`** (ADR-0044 rules 1, 6, 9 and 14): the home of the
 * seven Swarm settings a Project config entry owns on a Server, read, checked,
 * planned and laid over Cloudgate's defaults in this one module.
 *
 * - **Read.** {@link nativeWireSchema} is the `native` block of each described
 *   entry's strict schema, so an editor's JSON Schema shows it. Only the
 *   container key `native.docker` is snake_case; inside it the keys are
 *   Docker's PascalCase and the values exactly what the Docker Engine API
 *   takes (durations in nanoseconds), so a value from `docker service inspect`
 *   pastes in unchanged. Its keys are **not** closed by the schema: a key
 *   outside the seven reaches {@link nativeDockerRefusals}, which refuses it
 *   by name with its reason, where a strict schema could only say "not a
 *   field Cloudgate knows".
 * - **Check (every plan, every target).** {@link nativeDockerRefusals}: a key
 *   outside the seven, a "never"-list key with its reason, CPU and
 *   memory (`size` is the one way), and every value the Docker lock list
 *   locks (`docker-locks.ts`, the list the console's save and the deploy read
 *   too).
 * - **Absent means default.** The config owns the seven whether or not the
 *   block is written: a key left out is Cloudgate's default for the kind,
 *   never the last value it had. {@link nativeDockerDiffs} compares what the
 *   block lays over the kind's defaults with what the stored columns lay over
 *   them, so a stored value no file shows plans back to the default as a line.
 * - **Apply.** {@link nativeDockerColumns} writes the seven into the existing
 *   per-Service Swarm columns, no second copy; the deploy lays them over
 *   {@link DOCKER_DEFAULTS} field by field (`mechanize.ts`).
 *
 * - **Per kind.** A `cron` and a `bucket` take only some of the seven
 *   ({@link DOCKER_KEYS_CLOSED_ON_KIND}); a key the kind refuses is
 *   refused by path with its reason, never compared and never written.
 *
 * Placement, networks, published ports, the mode and the replica count stay
 * Cloudgate's columns and are never compared: they name a host or differ per
 * Environment.
 */

/** The seven Swarm settings `native.docker` takes, in the order a plan lists them. */
export const NATIVE_DOCKER_KEYS = [
  'Labels',
  'HealthCheck',
  'RestartPolicy',
  'UpdateConfig',
  'RollbackConfig',
  'StopGracePeriod',
  'Ulimits',
] as const;

export type NativeDockerKey = (typeof NATIVE_DOCKER_KEYS)[number];

const isNativeDockerKey = (key: string): key is NativeDockerKey =>
  (NATIVE_DOCKER_KEYS as readonly string[]).includes(key);

/**
 * Docker settings never admitted to `native.docker`, each with the reason a
 * refusal gives: what reaches other tenants, what names a host, and
 * what Cloudgate sets per Environment.
 */
export const NEVER_DOCKER_KEYS: Readonly<Record<string, string>> = {
  Privileged:
    'a privileged container reaches past its Service to the Server and every tenant on it',
  CapAdd:
    'an added capability reaches past its Service to the Server and every tenant on it',
  Mounts:
    "a bind mount names a host path; a Service's mounts are set in Cloudgate",
  Networks:
    "a Service's networks are Cloudgate's: they name the Server's networks and differ per Environment",
  EndpointSpec:
    "published ports are Cloudgate's: set them through the Service's port settings",
  Mode: "the service mode and replica count are Cloudgate's, per Environment",
  Placement: "placement names a host, so it is Cloudgate's, per Environment",
  Resources: 'CPU and memory are set by size, the one way to say them',
};

/** A key that would set CPU or memory, however Docker spells it. */
const CPU_OR_MEMORY = /cpu|memory/i;

const SIZE_REASON =
  'CPU and memory have no native key: size is the one way to set them';

/** The kinds a `native.docker` block is accepted on. */
const DOCKER_NATIVE_KINDS = [
  'web',
  'web-private',
  'worker',
  'static',
  'postgres',
  'mysql',
  'redis',
  'cron',
  'bucket',
] as const;

/**
 * **The keys a kind with no long-lived Swarm service of its own refuses**
 * (ADR-0044 rules 1, 7 and 11), each with the one-line reason a
 * refusal gives. Every kind not listed takes all seven. One table, read by
 * the plan, the console's Swarm save and the deploy, and the census entry
 * for each kind:
 *
 * - a **`cron`** runs each run as a one-off Swarm job (ADR-0034), so it
 *   takes `Labels`, `StopGracePeriod` and `Ulimits`, which reach the job's
 *   container and nothing Cloudgate depends on; the other four are
 *   Cloudgate's for every run.
 * - a **`bucket`** is Cloudgate's Garage (ADR-0037), so it takes `Labels`
 *   alone: the rest is how Cloudgate keeps one writer on one volume up and
 *   flushed for every Service linking it.
 */
export const DOCKER_KEYS_CLOSED_ON_KIND: Readonly<
  Record<string, Readonly<Partial<Record<NativeDockerKey, string>>>>
> = {
  cron: {
    HealthCheck:
      'a run is judged by its exit code, and a failing health check would kill it mid-command (AWS and Google Cloud runs have none)',
    RestartPolicy:
      'a run is never retried; Cloudgate runs it with Condition none',
    UpdateConfig: 'a run is a one-off job with no copies to update',
    RollbackConfig: 'a run is a one-off job with nothing to roll back',
  },
  bucket: {
    HealthCheck:
      "Garage is Cloudgate's pinned image with no shell, and Cloudgate checks it is ready itself",
    RestartPolicy:
      'every Service linking the bucket needs its Garage up, so Cloudgate keeps the restart policy',
    UpdateConfig:
      "Garage's image is Cloudgate's pin and its one copy updates stop-first, as a database's does",
    RollbackConfig:
      "Garage's image is Cloudgate's pin and its one copy rolls back stop-first, as a database's does",
    StopGracePeriod:
      "Garage gets the database's 30 s to flush its files, and a shorter grace can corrupt the bucket",
    Ulimits:
      "a bucket runs no code of the operator's, and Garage's limits are Cloudgate's along with its pinned image and config (ADR-0037)",
  },
};

/**
 * **What each of the seven keys locks** (ADR-0044 rules 8 and 11):
 * Docker is an allow-list of keys with a short deny-list of values inside
 * them (`docker-locks.ts`), and this is each key's entry in that list, an
 * open key's reason included. A key admitted by a later ticket lands with
 * its entry here (rule 13); the census fails until it does.
 */
export const NATIVE_DOCKER_KEY_LOCKS: Readonly<
  Record<NativeDockerKey, string>
> = {
  Labels:
    'open but for three namespaces: traefik.* routes every domain on the Server, com.docker.* decides which organization owns a container, and io.cloudgate.* is reserved for the marks Cloudgate writes',
  HealthCheck: 'open: a health check judges only its own Service',
  RestartPolicy:
    "open within Docker's documented conditions (none, on-failure, any): it restarts only its own Service",
  UpdateConfig:
    "open within Docker's documented orders and failure actions; a database updates stop-first, since two copies on one volume corrupt data",
  RollbackConfig:
    "open within Docker's documented orders and failure actions; a database rolls back stop-first, since two copies on one volume corrupt data",
  StopGracePeriod: 'open: how long its own Service is given to stop',
  Ulimits: "open: a limit on its own Service's processes",
};

/**
 * **What `native.docker` takes on each kind** (ADR-0044 rule 11): one
 * entry per kind the config describes, the census's record that each was
 * looked at. The keys a kind refuses are {@link DOCKER_KEYS_CLOSED_ON_KIND}'s.
 */
export const DOCKER_KIND_ENTRIES: Readonly<Record<ConfigKind, string>> = {
  web: 'all seven keys, on its Swarm service',
  'web-private': 'all seven keys, on its Swarm service',
  worker: 'all seven keys, on its Swarm service',
  static: 'all seven keys, on the Swarm service that serves it',
  postgres:
    'all seven keys, on its Swarm service, updating and rolling back stop-first',
  mysql:
    'all seven keys, on its Swarm service, updating and rolling back stop-first',
  redis:
    'all seven keys, on its Swarm service, updating and rolling back stop-first',
  cron: 'Labels, StopGracePeriod and Ulimits, which reach each run’s one-off job; the other four are Cloudgate’s for every run',
  bucket:
    'Labels alone, on its Garage service; the rest keeps one writer on one volume for every Service linking it',
  compose:
    'none: its container settings are its compose file’s, and its native block is refused whole (ADR-0069)',
};

/** Why `kind` refuses `key`, or `undefined` when it takes it. */
export function closedDockerKeyReason(
  kind: string,
  key: NativeDockerKey,
): string | undefined {
  return DOCKER_KEYS_CLOSED_ON_KIND[kind]?.[key];
}

/** The seven keys a kind takes, in the order a plan lists them. */
export function openDockerKeys(kind: string): readonly NativeDockerKey[] {
  return NATIVE_DOCKER_KEYS.filter(
    (key) => closedDockerKeyReason(kind, key) === undefined,
  );
}

/** Whether a config kind's `native.docker` is planned and applied. */
export function takesNativeDocker(kind: string): boolean {
  return (DOCKER_NATIVE_KINDS as readonly string[]).includes(kind);
}

/**
 * Which Docker lock role, and which defaults, a config kind's spec has: a
 * bucket's Garage is built by the database spec (ADR-0037).
 */
export function dockerRoleOf(kind: string): DockerLockRole {
  return kind === 'postgres' ||
    kind === 'mysql' ||
    kind === 'redis' ||
    kind === 'bucket'
    ? 'database'
    : 'application';
}

// ── Read ──

/** A Docker Engine duration: nanoseconds, as `docker service inspect` shows it. */
const nanoseconds = z.number().int().min(0).meta({
  description: 'A duration in nanoseconds, as the Docker Engine API takes it',
});

const count = z.number().int().min(0);

const healthCheckWire = z.strictObject({
  Test: z.array(z.string()).optional(),
  Interval: nanoseconds.optional(),
  Timeout: nanoseconds.optional(),
  StartPeriod: nanoseconds.optional(),
  Retries: count.optional(),
});

/**
 * Free text in the schema, refused by the check unless it is one of Docker's
 * documented values, so the refusal names the path and the list.
 */
const restartPolicyWire = z.strictObject({
  Condition: z.string().optional(),
  Delay: nanoseconds.optional(),
  MaxAttempts: count.optional(),
  Window: nanoseconds.optional(),
});

/** Every field optional: one written keeps Cloudgate's others. */
const updateConfigWire = z.strictObject({
  Parallelism: count.optional(),
  Delay: nanoseconds.optional(),
  FailureAction: z.string().optional(),
  Monitor: nanoseconds.optional(),
  MaxFailureRatio: z.number().min(0).max(1).optional(),
  Order: z.string().optional(),
});

const ulimitWire = z.strictObject({
  Name: z.string().min(1),
  Soft: z.number().int(),
  Hard: z.number().int(),
});

export const nativeDockerWireSchema = z
  .object({
    Labels: z.record(z.string(), z.string()).optional(),
    HealthCheck: healthCheckWire.optional(),
    RestartPolicy: restartPolicyWire.optional(),
    UpdateConfig: updateConfigWire.optional(),
    RollbackConfig: updateConfigWire.optional(),
    StopGracePeriod: nanoseconds.optional(),
    Ulimits: z.array(ulimitWire).optional(),
  })
  // Any other key is the check's to refuse, by name and with its reason.
  .catchall(z.unknown())
  .meta({
    description:
      "This Service's Swarm settings on a Server, spelled and valued as the Docker Engine API takes them. Laid over Cloudgate's defaults for the kind; a key left out is that default.",
  });

export type NativeDockerBlock = z.infer<typeof nativeDockerWireSchema>;

// ── Check ──

/**
 * Every refusal of one entry's `native.docker`, on every plan and whatever
 * the Environment's Deploy target (ADR-0044 rule 5), so a mistake shows on
 * the first plan rather than the first deploy to a Server. Every refusal is
 * returned, not the first, so one plan names everything to correct.
 *
 *     api.native.docker.Labels."traefik.http.routers.x": refused - <reason>
 */
export function nativeDockerRefusals(
  configName: string,
  kind: string,
  block: NativeDockerBlock | undefined,
): NativeRefusal[] {
  if (block === undefined) return [];
  const prefix = `${configName}.native.docker`;
  const refusals: NativeRefusal[] = [];
  const closed = new Set<string>();
  for (const key of Object.keys(block)) {
    if (isNativeDockerKey(key)) {
      // One of the seven the kind does not take: refused whole, so
      // a value inside it earns no second refusal below.
      const notOnKind = closedDockerKeyReason(kind, key);
      if (notOnKind === undefined) continue;
      closed.add(key);
      const at = `${prefix}.${key}`;
      refusals.push({ at, message: `${at}: refused - ${notOnKind}` });
      continue;
    }
    const reason =
      NEVER_DOCKER_KEYS[key] ??
      (CPU_OR_MEMORY.test(key)
        ? SIZE_REASON
        : `native.docker takes only ${NATIVE_DOCKER_KEYS.join(', ')}`);
    const at = `${prefix}.${key}`;
    refusals.push({ at, message: `${at}: refused - ${reason}` });
  }

  for (const refusal of dockerLockRefusals(block, dockerRoleOf(kind))) {
    if (closed.has(refusal.path[0] ?? '')) continue;
    const at = `${prefix}.${pathOf(refusal.path)}`;
    refusals.push({ at, message: formatDockerRefusal(refusal, `${prefix}.`) });
  }
  return refusals;
}

// ── Defaults and the merge ──

/** Docker's update or rollback settings, every field optional (a native block's). */
export interface DockerUpdateSettings {
  Parallelism?: number | undefined;
  Delay?: number | undefined;
  FailureAction?: string | undefined;
  Monitor?: number | undefined;
  MaxFailureRatio?: number | undefined;
  Order?: string | undefined;
}

/**
 * The seven as one Service holds them: its stored columns, or what a native
 * block lays. `null` and absent both mean "not set", so the kind's default.
 */
export interface DockerSettings {
  readonly Labels?: Readonly<Record<string, string>> | null;
  readonly HealthCheck?: {
    readonly Test?: readonly string[] | undefined;
    readonly Interval?: number | undefined;
    readonly Timeout?: number | undefined;
    readonly StartPeriod?: number | undefined;
    readonly Retries?: number | undefined;
  } | null;
  readonly RestartPolicy?: {
    readonly Condition?: string | undefined;
    readonly Delay?: number | undefined;
    readonly MaxAttempts?: number | undefined;
    readonly Window?: number | undefined;
  } | null;
  readonly UpdateConfig?: DockerUpdateSettings | null;
  readonly RollbackConfig?: DockerUpdateSettings | null;
  readonly StopGracePeriod?: number | null;
  readonly Ulimits?:
    | readonly {
        readonly Name: string;
        readonly Soft: number;
        readonly Hard: number;
      }[]
    | null;
}

/** An update or rollback default: the two fields the Swarm columns require, and more. */
export interface DockerUpdateDefault {
  readonly Parallelism: number;
  readonly Order: DockerOrder;
  readonly FailureAction?: DockerFailureAction;
}

/** What Cloudgate deploys for one role where its Service sets nothing. */
export interface DockerDefaults {
  readonly UpdateConfig: DockerUpdateDefault;
  readonly RollbackConfig: DockerUpdateDefault;
  /** `null` is the Docker Engine's own (ten seconds). */
  readonly StopGracePeriod: number | null;
}

/**
 * **Cloudgate's defaults for each kind of spec** (`mechanize.ts` and
 * `database-spec.ts` read them, as the plan does): the one table both the
 * deploy and the plan's "→ default" read, so they cannot disagree. Labels,
 * the health check, the restart policy and ulimits have none: the image's
 * `HEALTHCHECK` and Docker's own restart policy stand.
 *
 * - **An Application** updates start-first and, on a failed update, **rolls
 *   back**, rather than Docker's `pause`, which would leave half
 *   the tasks on the new image. Its rollback's failure action is Docker's.
 * - **A database** updates and rolls back **stop-first**: two copies
 *   on one volume are two writers to one data directory. It is given thirty
 *   seconds to stop, so it can flush to disk.
 */
export const DOCKER_DEFAULTS: Readonly<Record<DockerLockRole, DockerDefaults>> =
  {
    application: {
      UpdateConfig: {
        Parallelism: 1,
        Order: 'start-first',
        FailureAction: 'rollback',
      },
      RollbackConfig: { Parallelism: 1, Order: 'start-first' },
      StopGracePeriod: null,
    },
    database: {
      UpdateConfig: {
        Parallelism: 1,
        Order: 'stop-first',
        FailureAction: 'rollback',
      },
      RollbackConfig: { Parallelism: 1, Order: 'stop-first' },
      StopGracePeriod: 30_000_000_000,
    },
  };

/**
 * A setting **over** Cloudgate's defaults, field by field: each field
 * the override sets wins, every other keeps the default's.
 *
 * `undefined` values are ignored rather than merged over. A stored column is
 * JSON and cannot hold one, but a spec assembled in process can, and a key
 * `JSON.stringify` drops on the way to the daemon is the same silent fall
 * back to Docker's default one layer in.
 */
export function over<T extends object>(
  defaults: T,
  override: Partial<T> | null | undefined,
): T {
  if (!override) return { ...defaults };
  const set = Object.entries(override).filter(
    ([, value]) => value !== undefined,
  );
  return { ...defaults, ...(Object.fromEntries(set) as Partial<T>) };
}

// ── Plan ──

/** The fields each block's lines are listed by, in the Engine API's order. */
const BLOCK_FIELDS = {
  HealthCheck: ['Test', 'Interval', 'Timeout', 'StartPeriod', 'Retries'],
  RestartPolicy: ['Condition', 'Delay', 'MaxAttempts', 'Window'],
  UpdateConfig: [
    'Parallelism',
    'Delay',
    'FailureAction',
    'Monitor',
    'MaxFailureRatio',
    'Order',
  ],
  RollbackConfig: [
    'Parallelism',
    'Delay',
    'FailureAction',
    'Monitor',
    'MaxFailureRatio',
    'Order',
  ],
} as const;

/** One leaf of the seven: its path and what sets it there. */
interface Leaf {
  readonly path: readonly string[];
  readonly value: unknown;
}

/**
 * The seven as leaves an operator reads one line each of: a block's field, a
 * label by its key, and the stop grace period and the ulimits whole (a list
 * is replaced whole, never merged, ADR-0044 rule 3). Only what `settings`
 * sets is a leaf.
 */
function leavesOf(settings: DockerSettings | null | undefined): Leaf[] {
  if (!settings) return [];
  const leaves: Leaf[] = [];
  for (const [label, value] of Object.entries(settings.Labels ?? {})) {
    leaves.push({ path: ['Labels', label], value });
  }
  for (const block of [
    'HealthCheck',
    'RestartPolicy',
    'UpdateConfig',
    'RollbackConfig',
  ] as const) {
    const set = settings[block] as Record<string, unknown> | null | undefined;
    for (const field of BLOCK_FIELDS[block]) {
      const value = set?.[field];
      if (value !== undefined && value !== null) {
        leaves.push({ path: [block, field], value });
      }
    }
  }
  if (
    settings.StopGracePeriod !== undefined &&
    settings.StopGracePeriod !== null
  ) {
    leaves.push({ path: ['StopGracePeriod'], value: settings.StopGracePeriod });
  }
  if (settings.Ulimits && settings.Ulimits.length > 0) {
    leaves.push({ path: ['Ulimits'], value: settings.Ulimits });
  }
  return leaves;
}

/** The kind's defaults as leaves, so a side nothing sets reads as one. */
function defaultLeaves(role: DockerLockRole): Leaf[] {
  const defaults = DOCKER_DEFAULTS[role];
  return leavesOf({
    UpdateConfig: defaults.UpdateConfig,
    RollbackConfig: defaults.RollbackConfig,
    StopGracePeriod: defaults.StopGracePeriod,
  });
}

const key = (path: readonly string[]) => JSON.stringify(path);

/** A path in the file's spelling: a label key quoted, since it holds dots. */
function pathOf(path: readonly string[]): string {
  const [head, ...rest] = path;
  if (head === 'Labels' && rest.length > 0) {
    return `Labels.${JSON.stringify(rest.join('.'))}`;
  }
  return path.join('.');
}

/** Leaf order: the seven's, then a block's fields', then label keys as written. */
function byRank(a: readonly string[], b: readonly string[]): number {
  const rank = (path: readonly string[]) => {
    const head = path[0] as NativeDockerKey;
    const fields: readonly string[] =
      head in BLOCK_FIELDS
        ? BLOCK_FIELDS[head as keyof typeof BLOCK_FIELDS]
        : [];
    return [NATIVE_DOCKER_KEYS.indexOf(head), fields.indexOf(path[1] ?? '')];
  };
  const [a0, a1] = rank(a);
  const [b0, b1] = rank(b);
  return a0 - b0 || a1 - b1;
}

/**
 * The native lines of one Service's `change` (or `create`) step: every leaf
 * of the seven whose value the block lays over the kind's defaults differs
 * from what its stored columns lay over them. `stored` is `undefined` on a
 * create, which starts from the defaults. A side with no written value is
 * the kind's default and marked so (`→ default (none)`).
 *
 * Compared after the merge, not as written, so a stored value equal to the
 * default it stands for plans no line; and before any column is written,
 * so a stored value no file shows plans back to the default as a line, never
 * silently (ADR-0044 rule 6).
 */
export function nativeDockerDiffs(
  kind: string,
  block: NativeDockerBlock | undefined,
  stored: DockerSettings | undefined,
): NativeFieldDiff[] {
  const role = dockerRoleOf(kind);
  // Only the keys the kind takes are the config's: a key it refuses
  // is Cloudgate's, so its stored column is never compared or put back.
  const open: readonly string[] = openDockerKeys(kind);
  const byPath = (leaves: Leaf[]) =>
    new Map(
      leaves
        .filter((leaf) => open.includes(leaf.path[0] ?? ''))
        .map((leaf) => [key(leaf.path), leaf]),
    );
  const defaults = byPath(defaultLeaves(role));
  const wanted = byPath(leavesOf(block));
  const have = byPath(leavesOf(stored));

  const paths = new Map<string, readonly string[]>();
  for (const leaves of [defaults, have, wanted]) {
    for (const [id, leaf] of leaves) paths.set(id, leaf.path);
  }

  const diffs: NativeFieldDiff[] = [];
  for (const [id, path] of [...paths].sort(([, a], [, b]) => byRank(a, b))) {
    const to = wanted.get(id) ?? defaults.get(id);
    const from = have.get(id) ?? defaults.get(id);
    const toValue = to?.value ?? null;
    const fromValue = from?.value ?? null;
    if (canonical(toValue) === canonical(fromValue)) continue;
    diffs.push({
      field: `native.docker.${pathOf(path)}`,
      from: fromValue,
      to: toValue,
      native: true,
      ...(have.has(id) ? {} : { fromDefault: true as const }),
      ...(wanted.has(id) ? {} : { toDefault: true as const }),
    });
  }
  return diffs;
}

/**
 * The path under `native.docker` that one of {@link nativeDockerDiffs}'s
 * lines names (`native.docker.Labels."a.b"` is `['Labels', 'a.b']`), or
 * `null` for a line that is not a `native.docker` one. A console Save
 * rewrites the file at this path.
 */
export function nativeDockerPathOf(field: string): string[] | null {
  const prefix = 'native.docker.';
  if (!field.startsWith(prefix)) return null;
  const rest = field.slice(prefix.length);
  if (rest.startsWith('Labels."')) {
    return ['Labels', JSON.parse(rest.slice('Labels.'.length)) as string];
  }
  return rest.split('.');
}

// ── Generate ──

/**
 * The `native.docker` block a Service's stored Swarm settings are written
 * as: each leaf of the seven that differs from the kind's default,
 * and nothing else, so Cloudgate's defaults are never written and a block
 * written from `stored` plans no native line against it
 * ({@link nativeDockerDiffs} compares the same leaves over the same
 * defaults). `undefined` when every stored value is the default.
 *
 * Per key, so the generator can compare Environments key by key and name
 * the one they disagree on. A console Save writes the same block
 * into the entry, so a setting put back to the default leaves the file.
 * Only the keys the kind takes: a cron's or a bucket's stored value
 * of a key it refuses is Cloudgate's, never compared, so never written.
 */
export function nativeDockerBlockOf(
  kind: string,
  stored: DockerSettings | undefined,
): NativeDockerBlock | undefined {
  const open: readonly string[] = openDockerKeys(kind);
  const defaults = new Map(
    defaultLeaves(dockerRoleOf(kind)).map((leaf) => [
      key(leaf.path),
      leaf.value,
    ]),
  );
  const block: Record<string, unknown> = {};
  for (const { path, value } of leavesOf(stored)) {
    if (!open.includes(path[0] ?? '')) continue;
    if (canonical(value) === canonical(defaults.get(key(path)) ?? null)) {
      continue;
    }
    const [head, field] = path;
    if (field === undefined) {
      block[head] = value;
    } else {
      const inner = (block[head] ??= {}) as Record<string, unknown>;
      inner[path.slice(1).join('.')] = value;
    }
  }
  const ordered = NATIVE_DOCKER_KEYS.filter((name) => name in block).map(
    (name) => [name, block[name]] as const,
  );
  return ordered.length === 0 ? undefined : Object.fromEntries(ordered);
}

/** A JSON value with its object keys sorted, so equal values compare equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : inner,
  );
}

// ── Apply ──

/** An update or rollback as the Swarm columns hold it. */
export interface DockerUpdateColumn {
  Parallelism: number;
  Delay?: number | undefined;
  FailureAction?: DockerFailureAction | undefined;
  Monitor?: number | undefined;
  MaxFailureRatio?: number | undefined;
  Order: DockerOrder;
}

/** The seven Swarm columns an Application and every database table share. */
export interface NativeDockerColumns {
  labelsSwarm: Record<string, string> | null;
  healthCheckSwarm: {
    Test?: string[];
    Interval?: number;
    Timeout?: number;
    StartPeriod?: number;
    Retries?: number;
  } | null;
  restartPolicySwarm: {
    Condition?: DockerRestartCondition;
    Delay?: number;
    MaxAttempts?: number;
    Window?: number;
  } | null;
  updateConfigSwarm: DockerUpdateColumn | null;
  rollbackConfigSwarm: DockerUpdateColumn | null;
  stopGracePeriodSwarm: number | null;
  ulimitsSwarm: { Name: string; Soft: number; Hard: number }[] | null;
}

/** A checked value narrowed to Docker's list; the plan refused any other. */
function listed<T extends string>(
  value: string | undefined,
  guard: (value: string) => value is T,
  path: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (!guard(value)) {
    throw new Error(
      `native.docker.${path} ${JSON.stringify(value)} was not checked by its plan; plan again`,
    );
  }
  return value;
}

function updateColumn(
  defaults: DockerUpdateDefault,
  written: DockerUpdateSettings | undefined,
  block: 'UpdateConfig' | 'RollbackConfig',
): DockerUpdateColumn | null {
  if (!written) return null;
  // The columns require a parallelism and an order, so the kind's fill in
  // what the block leaves out; the deploy would lay the same over them.
  return over<DockerUpdateColumn>(
    { ...defaults },
    {
      ...written,
      FailureAction: listed(
        written.FailureAction,
        isDockerFailureAction,
        `${block}.FailureAction`,
      ),
      Order: listed(written.Order, isDockerOrder, `${block}.Order`),
    },
  );
}

/**
 * What Apply writes for an entry's `native.docker`: the seven Swarm
 * columns, each the block's value or `null` where it writes none, so a key
 * taken out puts its column back to the kind's default. An update or a
 * rollback the block sets is stored with the kind's other fields filled in,
 * since its column requires them.
 */
export function nativeDockerColumns(
  kind: string,
  block: NativeDockerBlock | undefined,
): NativeDockerColumns {
  const defaults = DOCKER_DEFAULTS[dockerRoleOf(kind)];
  const restart = block?.RestartPolicy;
  return {
    labelsSwarm: block?.Labels ? { ...block.Labels } : null,
    healthCheckSwarm: block?.HealthCheck ? { ...block.HealthCheck } : null,
    restartPolicySwarm: restart
      ? over(
          {},
          {
            ...restart,
            Condition: listed(
              restart.Condition,
              isDockerRestartCondition,
              'RestartPolicy.Condition',
            ),
          },
        )
      : null,
    updateConfigSwarm: updateColumn(
      defaults.UpdateConfig,
      block?.UpdateConfig,
      'UpdateConfig',
    ),
    rollbackConfigSwarm: updateColumn(
      defaults.RollbackConfig,
      block?.RollbackConfig,
      'RollbackConfig',
    ),
    stopGracePeriodSwarm: block?.StopGracePeriod ?? null,
    ulimitsSwarm: block?.Ulimits ? block.Ulimits.map((u) => ({ ...u })) : null,
  };
}

/** The Swarm column each of the seven is stored in. */
const COLUMN_OF: Readonly<Record<NativeDockerKey, keyof NativeDockerColumns>> =
  {
    Labels: 'labelsSwarm',
    HealthCheck: 'healthCheckSwarm',
    RestartPolicy: 'restartPolicySwarm',
    UpdateConfig: 'updateConfigSwarm',
    RollbackConfig: 'rollbackConfigSwarm',
    StopGracePeriod: 'stopGracePeriodSwarm',
    Ulimits: 'ulimitsSwarm',
  };

/**
 * What Apply writes for a kind: {@link nativeDockerColumns}, only
 * the columns of the keys the kind takes. A column of a key it refuses is
 * Cloudgate's, so it is left as it is, never reset.
 */
export function openDockerColumns(
  kind: string,
  block: NativeDockerBlock | undefined,
): Partial<NativeDockerColumns> {
  const columns = nativeDockerColumns(kind, block);
  return Object.fromEntries(
    openDockerKeys(kind).map((key) => [
      COLUMN_OF[key],
      columns[COLUMN_OF[key]],
    ]),
  );
}

/**
 * Refuses Swarm settings that hold a key the kind does not take,
 * naming each key, its value and the reason, and stripping nothing (ADR-0044
 * rule 9): the console's save of a Cron service's Swarm settings, and a
 * run's job from a stored row that predates the rule. `null` and absent are
 * "not set", which every kind takes.
 */
export function closedDockerColumnRefusals(
  kind: string,
  columns: Partial<Record<keyof NativeDockerColumns, unknown>>,
): string[] {
  return NATIVE_DOCKER_KEYS.flatMap((key) => {
    const reason = closedDockerKeyReason(kind, key);
    const value = columns[COLUMN_OF[key]];
    return reason === undefined || value === null || value === undefined
      ? []
      : [`${key} ${JSON.stringify(value)}: refused - ${reason}`];
  });
}

/** The seven stored columns as {@link DockerSettings}, `undefined` when none is set. */
export function storedDockerSettings(columns: {
  [K in keyof NativeDockerColumns]: unknown;
}): DockerSettings | undefined {
  const settings: DockerSettings = {
    Labels: columns.labelsSwarm as DockerSettings['Labels'],
    HealthCheck: columns.healthCheckSwarm as DockerSettings['HealthCheck'],
    RestartPolicy:
      columns.restartPolicySwarm as DockerSettings['RestartPolicy'],
    UpdateConfig: columns.updateConfigSwarm as DockerSettings['UpdateConfig'],
    RollbackConfig:
      columns.rollbackConfigSwarm as DockerSettings['RollbackConfig'],
    StopGracePeriod:
      columns.stopGracePeriodSwarm as DockerSettings['StopGracePeriod'],
    Ulimits: columns.ulimitsSwarm as DockerSettings['Ulimits'],
  };
  // Absent rather than all-null, so a Service with none set fingerprints as
  // it did before the plan compared them.
  const set = Object.entries(settings).filter(
    ([, value]) => value !== null && value !== undefined,
  );
  return set.length === 0 ? undefined : Object.fromEntries(set);
}

// ── Deploy ──

/** Which native key a Docker refusal of a service spec is about, by its words. */
const DOCKER_ERROR_KEYS: ReadonlyArray<{
  pattern: RegExp;
  column: keyof NativeDockerColumns;
  key: NativeDockerKey;
}> = [
  { pattern: /ulimit/i, column: 'ulimitsSwarm', key: 'Ulimits' },
  { pattern: /health/i, column: 'healthCheckSwarm', key: 'HealthCheck' },
  { pattern: /restart/i, column: 'restartPolicySwarm', key: 'RestartPolicy' },
  {
    pattern: /rollback/i,
    column: 'rollbackConfigSwarm',
    key: 'RollbackConfig',
  },
  {
    pattern: /update ?config/i,
    column: 'updateConfigSwarm',
    key: 'UpdateConfig',
  },
  {
    pattern: /stop ?grace/i,
    column: 'stopGracePeriodSwarm',
    key: 'StopGracePeriod',
  },
  { pattern: /label/i, column: 'labelsSwarm', key: 'Labels' },
];

/**
 * A value only Docker can judge (an unknown ulimit name, a malformed health
 * check) fails that Service's Deployment **naming the native path**:
 * when the Engine refuses a spec in words that name one of the seven and the
 * Service sets it, the error says `native.docker.<key>` before Docker's own
 * sentence. Any other refusal is Docker's sentence as it was.
 */
export function blameNativeDocker(
  error: unknown,
  service: Partial<Record<keyof NativeDockerColumns, unknown>>,
): unknown {
  const message = error instanceof Error ? error.message : String(error);
  const blamed = DOCKER_ERROR_KEYS.find(
    ({ pattern, column }) =>
      pattern.test(message) &&
      service[column] !== null &&
      service[column] !== undefined,
  );
  if (!blamed) return error;
  return new Error(
    `Docker refused this Service's native.docker.${blamed.key}: ${message}`,
    { cause: error },
  );
}
