import { POSTGRES_INSTANCE_ADDRESS } from '../cloud-accounts/aws/definitions/postgres-definition';
import { REDIS_GROUP_ADDRESS } from '../cloud-accounts/aws/definitions/redis-definition';
import type { NativeAwsBlock } from './aws-native';
import { consoleRefusalSentence } from './native-shared';

/**
 * **Settings the console owned before native, on AWS** (ADR-0044
 * rule 10): a postgres's or a mysql's storage, its ceiling,
 * Multi-AZ and backup days on RDS, and a redis's replica and snapshot days
 * on ElastiCache. Each is open to `native.aws`, by its provider argument,
 * and the three rules that follow are read from this one table:
 *
 * - **Native wins.** A value `native.aws` sets is laid over the console's,
 *   and its Apply writes it to the console's column too
 *   ({@link consoleColumnsOf}), so the cloud Database page shows what runs.
 * - **The console refuses it** while native sets it
 *   ({@link nativeSettingOf}), naming the path that does.
 * - **Removing it leaves it where it is.** The key taken out, the column
 *   still holds what its last Apply laid, which is the console's again; the
 *   plan says it is handed back (`console (<value>)`), never put back to
 *   Cloudgate's default.
 *
 * **A class or node type is the console's too**: `instance_class`
 * and `node_type` are size-bearing, the console's only for an entry
 * with no `size`. Native wins and the console refuses them as it does the
 * rest, and an Apply writes the native one to the console's column, so it
 * is what runs; but taken out, one falls back to the entry's `size` when it
 * has one (`size-override.ts`), and only with none stays where it is and
 * is the console's again, never the smallest.
 */

/** A console setting of a database on RDS or ElastiCache. */
export type ConsoleSetting =
  | 'storageGb'
  | 'maxStorageGb'
  | 'multiAz'
  | 'backupRetentionDays'
  | 'replica'
  | 'snapshotRetentionDays'
  | 'instanceClass'
  | 'nodeType';

/** One console-owned argument: the setting it is, and how its value is written there. */
interface ConsoleOwned {
  readonly setting: ConsoleSetting;
  /** The column's value for a native one, or `undefined` when none fits. */
  readonly column: (value: unknown) => number | boolean | string | undefined;
}

const count = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) ? value : undefined;
const flag = (value: unknown) =>
  typeof value === 'boolean' ? value : undefined;
/** The console's replica is a second node: two or more clusters say it is on. */
const replicas = (value: unknown) =>
  typeof value === 'number' ? value > 1 : undefined;
/** A class or a node type, as the console's column holds it. */
const machine = (value: unknown) =>
  typeof value === 'string' && value !== '' ? value : undefined;
/** Set natively, the console refuses it, but only `num_cache_clusters` is its replica. */
const none = () => undefined;

/**
 * The console-owned arguments, by the address they are of: each provider
 * argument with the console setting it stands for.
 */
export const AWS_CONSOLE_OWNED: Readonly<
  Record<string, Readonly<Record<string, ConsoleOwned>>>
> = {
  [POSTGRES_INSTANCE_ADDRESS]: {
    allocated_storage: { setting: 'storageGb', column: count },
    max_allocated_storage: { setting: 'maxStorageGb', column: count },
    multi_az: { setting: 'multiAz', column: flag },
    backup_retention_period: { setting: 'backupRetentionDays', column: count },
    instance_class: { setting: 'instanceClass', column: machine },
  },
  [REDIS_GROUP_ADDRESS]: {
    num_cache_clusters: { setting: 'replica', column: replicas },
    automatic_failover_enabled: { setting: 'replica', column: none },
    multi_az_enabled: { setting: 'replica', column: none },
    snapshot_retention_limit: {
      setting: 'snapshotRetentionDays',
      column: count,
    },
    node_type: { setting: 'nodeType', column: machine },
  },
};

/** Whether `key` of `address` is a setting the console owned. */
export function isAwsConsoleOwned(
  address: string,
  key: string | number,
): boolean {
  const owned = AWS_CONSOLE_OWNED[address];
  return (
    owned !== undefined && typeof key === 'string' && Object.hasOwn(owned, key)
  );
}

/**
 * The console columns a block's values write: what its Apply saves
 * beside the block, so the console shows what runs and a key taken out
 * later leaves the value where it is. Only what the block sets.
 */
export function consoleColumnsOf(
  block: NativeAwsBlock | null | undefined,
): Partial<Record<ConsoleSetting, number | boolean | string>> {
  const columns: Partial<Record<ConsoleSetting, number | boolean | string>> =
    {};
  for (const [address, owned] of Object.entries(AWS_CONSOLE_OWNED)) {
    const native = block?.[address];
    if (!native) continue;
    for (const [key, { setting, column }] of Object.entries(owned)) {
      if (!Object.hasOwn(native, key)) continue;
      const value = column(native[key]);
      if (value !== undefined) columns[setting] = value;
    }
  }
  return columns;
}

/**
 * The native path that sets a console setting, as the file spells
 * it, or `null` when the block leaves it to the console.
 */
export function nativeSettingOf(
  block: NativeAwsBlock | null | undefined,
  setting: ConsoleSetting,
): string | null {
  for (const [address, owned] of Object.entries(AWS_CONSOLE_OWNED)) {
    const native = block?.[address];
    if (!native) continue;
    for (const [key, one] of Object.entries(owned)) {
      if (one.setting === setting && Object.hasOwn(native, key)) {
        return `native.aws.${JSON.stringify(address)}.${key}`;
      }
    }
  }
  return null;
}

/**
 * Why the cloud Database page may not change these settings: one
 * sentence per setting the config's applied block sets natively, or `null`.
 */
export function awsConsoleRefusalOf(
  name: string,
  block: NativeAwsBlock | null | undefined,
  settings: readonly ConsoleSetting[],
): string | null {
  return consoleRefusalSentence(
    name,
    settings.map((setting) => [setting, nativeSettingOf(block, setting)]),
  );
}

/**
 * What an Apply writes to a postgres's or a mysql's row on RDS:
 * the block its entry applies, `null` for none, and each console-owned
 * value in it to the console's own column.
 */
export function rdsNativeColumns(block: NativeAwsBlock | null | undefined): {
  readonly nativeAws: NativeAwsBlock | null;
  readonly storageGb?: number;
  readonly maxStorageGb?: number;
  readonly multiAz?: boolean;
  readonly backupRetentionDays?: number;
  readonly instanceClass?: string;
} {
  const columns = consoleColumnsOf(block);
  return {
    nativeAws: block ?? null,
    ...textColumn('instanceClass', columns.instanceClass),
    ...numberColumn('storageGb', columns.storageGb),
    ...numberColumn('maxStorageGb', columns.maxStorageGb),
    ...(typeof columns.multiAz === 'boolean'
      ? { multiAz: columns.multiAz }
      : {}),
    ...numberColumn('backupRetentionDays', columns.backupRetentionDays),
  };
}

/** What an Apply writes to a redis's row on ElastiCache, as {@link rdsNativeColumns}. */
export function elastiCacheNativeColumns(
  block: NativeAwsBlock | null | undefined,
): {
  readonly nativeAws: NativeAwsBlock | null;
  readonly replica?: boolean;
  readonly snapshotRetentionDays?: number;
  readonly nodeType?: string;
} {
  const columns = consoleColumnsOf(block);
  return {
    nativeAws: block ?? null,
    ...textColumn('nodeType', columns.nodeType),
    ...(typeof columns.replica === 'boolean'
      ? { replica: columns.replica }
      : {}),
    ...numberColumn('snapshotRetentionDays', columns.snapshotRetentionDays),
  };
}

function textColumn<K extends string>(
  key: K,
  value: number | boolean | string | undefined,
): Partial<Record<K, string>> {
  return typeof value === 'string'
    ? ({ [key]: value } as Record<K, string>)
    : {};
}

function numberColumn<K extends string>(
  key: K,
  value: number | boolean | string | undefined,
): Partial<Record<K, number>> {
  return typeof value === 'number'
    ? ({ [key]: value } as Record<K, number>)
    : {};
}
