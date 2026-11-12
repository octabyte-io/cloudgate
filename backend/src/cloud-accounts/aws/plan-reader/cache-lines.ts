import {
  ELASTICACHE_KNOWN_NODE_TYPES,
  ELASTICACHE_NODE_TYPES,
  formatMachine,
  machineKnown,
} from '../definitions/database-class';
import { SET_BY_NATIVE } from '../../../native/size-override';
import type { Outage } from './database-lines';
import type { StepAction, SummaryContext } from './plan-lines';
import type { TofuResourceChange, TofuShowJson } from './tofu-show.types';

type Values = Record<string, unknown>;

function valuesOf(value: unknown): Values {
  return value && typeof value === 'object' ? (value as Values) : {};
}

const days = (count: number) => `${count} ${count === 1 ? 'day' : 'days'}`;

/** `daily, kept 7 days`, or `off` for 0. */
const snapshots = (count: number) =>
  count === 0 ? 'off' : `daily, kept ${days(count)}`;

/** `8.1.0` → `[8, 1, 0]`, for comparing two versions. */
const parts = (version: string) =>
  version.split('.').map((part) => Number(part) || 0);

const major = (version: string) => parts(version)[0];

/**
 * Whether `a` is an older version than `b`, by as many parts as both name:
 * `8.0` is older than `8.1.4`, and `8.1` is not older than `8.1.4`.
 */
export function olderValkey(a: string, b: string): boolean {
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] < right[i];
  }
  return false;
}

/** `7.2.4`: the Valkey AWS reports it runs, else the one asked for. */
function versionOf(values: Values): string | null {
  const actual = values.engine_version_actual;
  if (typeof actual === 'string' && actual !== '') return actual;
  const asked = values.engine_version;
  return typeof asked === 'string' && asked !== '' ? asked : null;
}

/**
 * The plain words for a redis on ElastiCache's planned change (the AWS databases spec
 * "Plan lines for a cloud database"): the size beside the engine
 * and node type AWS will run, with its CPU and memory —
 * `redis small → Valkey on cache.t4g.small (2 vCPU, 1.37 GB)` — on a create
 * how long daily snapshots are kept and the Valkey version, and on a change
 * each value that moves and the outage it brings (`cacheOutages`). Every
 * value is read from the plan, so a line never claims what the definition
 * did not ask for.
 */
export function cacheLines(
  change: TofuResourceChange,
  action: StepAction,
  context: SummaryContext,
): string[] {
  if (change.type !== 'aws_elasticache_replication_group') return [];
  const name = context.serviceName ?? change.name;
  if (action === 'destroy') return [`${name}: destroy`];
  const after = valuesOf(change.change.after);
  if (action === 'change') return changeLines(change, name, context);

  const line = nodeTypeLine(after, name, context);
  const lines = line ? [line] : [];
  if (action !== 'create') return lines;
  const retention = after.snapshot_retention_limit;
  if (typeof retention === 'number') {
    lines.push(`${name} snapshots: ${snapshots(retention)}`);
  }
  if (typeof after.engine_version === 'string') {
    lines.push(`${name} version: Valkey ${after.engine_version}`);
  }
  return lines;
}

/**
 * A change's lines: each value that moves, from what it is to what it will
 * be, then its outages. The replica and snapshot retention carry no mark:
 * ElastiCache adds or drops a replica and changes retention online.
 */
function changeLines(
  change: TofuResourceChange,
  name: string,
  context: SummaryContext,
): string[] {
  const before = valuesOf(change.change.before);
  const after = valuesOf(change.change.after);
  const moved = (field: string) => before[field] !== after[field];
  const lines: string[] = [];
  if (moved('node_type')) {
    const line = nodeTypeLine(after, name, context);
    if (line) {
      lines.push(
        typeof before.node_type === 'string'
          ? `${line}, from ${before.node_type}`
          : line,
      );
    }
  }
  const running = versionOf(before);
  const asked = after.engine_version;
  if (
    moved('engine_version') &&
    typeof asked === 'string' &&
    running !== null &&
    major(asked) === major(running)
  ) {
    lines.push(`${name} version: Valkey ${running} → ${asked}`);
  }
  if (moved('num_cache_clusters')) {
    lines.push(
      Number(after.num_cache_clusters) > 1
        ? `${name} replica: off → on, one replica in another zone with automatic failover`
        : `${name} replica: on → off, one node`,
    );
  }
  if (
    moved('snapshot_retention_limit') &&
    typeof before.snapshot_retention_limit === 'number' &&
    typeof after.snapshot_retention_limit === 'number'
  ) {
    lines.push(
      `${name} snapshots: ${snapshots(before.snapshot_retention_limit)} → ${snapshots(after.snapshot_retention_limit)}`,
    );
  }
  for (const outage of cacheOutages(change, 'change', context)) {
    lines.push(outage.line);
  }
  return lines;
}

/**
 * The outages a redis on ElastiCache's change brings (the AWS databases spec
 * US24): a new node type may drop connections while it resizes, a new
 * minor while it upgrades, and a new major is a major upgrade, named from
 * the Valkey AWS reports it runs, which is never undone and is confirmed by
 * name at Apply. A create or a destroy brings none.
 */
export function cacheOutages(
  change: TofuResourceChange,
  action: StepAction,
  context: SummaryContext,
): Outage[] {
  if (change.type !== 'aws_elasticache_replication_group') return [];
  if (action !== 'change') return [];
  const name = context.serviceName ?? change.name;
  const before = valuesOf(change.change.before);
  const after = valuesOf(change.change.after);
  const outages: Outage[] = [];
  if (before.node_type !== after.node_type) {
    outages.push({
      kind: 'restart',
      serviceName: name,
      line: `${name}: may drop connections briefly while it resizes`,
    });
  }
  const running = versionOf(before);
  const asked =
    typeof after.engine_version === 'string' ? after.engine_version : null;
  if (
    asked !== null &&
    running !== null &&
    before.engine_version !== after.engine_version
  ) {
    if (major(asked) > major(running)) {
      outages.push({
        kind: 'major-upgrade',
        serviceName: name,
        line: `${name} major upgrade: Valkey ${running} → ${asked}, may drop connections briefly, cannot be undone`,
      });
    } else if (olderValkey(running, asked)) {
      outages.push({
        kind: 'restart',
        serviceName: name,
        line: `${name}: may drop connections briefly while it upgrades`,
      });
    }
  }
  return outages;
}

/**
 * The Valkey a redis on ElastiCache runs, read from the state a plan
 * refreshed: what AWS reports, or `null` for a replication group not
 * made yet. A downgrade is refused naming it.
 */
export function runningValkeyVersion(show: TofuShowJson): string | null {
  const group = (show.resource_changes ?? []).find(
    (change) =>
      change.type === 'aws_elasticache_replication_group' &&
      change.mode !== 'data',
  );
  if (!group || group.change.before === null) return null;
  return versionOf(valuesOf(group.change.before));
}

/**
 * `redis small → Valkey on cache.t4g.small (2 vCPU, 1.37 GB)`; a node type
 * `native.aws` sets says so: `…, set by native`.
 */
function nodeTypeLine(
  values: Values,
  name: string,
  context: SummaryContext,
): string | null {
  const nodeType = values.node_type;
  if (typeof nodeType !== 'string') return null;
  const machine = machineKnown(
    ELASTICACHE_NODE_TYPES,
    ELASTICACHE_KNOWN_NODE_TYPES,
    nodeType,
  );
  const size = context.sizeName ?? (context.noSize ? 'no size' : null);
  const shown = machine ? `${nodeType} (${formatMachine(machine)})` : nodeType;
  if (context.nativeMachine) {
    return `${name}${size ? ` ${size}` : ''} → Valkey on ${shown}, ${SET_BY_NATIVE}`;
  }
  return `${name}${size ? ` ${size}` : ''} → Valkey on ${shown}${context.noSize ? ' (smallest)' : ''}`;
}
