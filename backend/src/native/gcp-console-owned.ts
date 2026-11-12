import { CLOUD_SQL_INSTANCE_ADDRESS } from '../cloud-accounts/gcp/definitions/cloud-sql-definition';
import { MEMORYSTORE_INSTANCE_ADDRESS } from '../cloud-accounts/gcp/definitions/memorystore-definition';
import { consoleRefusalSentence } from './native-shared';
import type { NativeGcpBlock } from './gcp-native';
import { valueAt } from './lay';
import { pathText } from './provider-schema';
import type { PathPart } from './provider-schema';

/**
 * **Settings the console owned before native, on Google Cloud** (ADR-0044
 * rule 10): a postgres's backup days on Cloud SQL,
 * and a redis's high availability and backup days on Memorystore, each its
 * cloud Database page's or its Backups tab's. Each is open to
 * `native.gcp`, by its provider argument, and the three rules
 * `aws-console-owned.ts` reads from its table are read from this one:
 *
 * - **Native wins.** A value `native.gcp` sets is laid over the console's,
 *   and its Apply writes it to the console's column too
 *   ({@link cloudSqlNativeColumns}, {@link memorystoreNativeColumns}), so
 *   the page shows what runs and the definition is written with it.
 * - **The console refuses it** while native sets it
 *   ({@link gcpConsoleRefusalOf}), naming the path that does.
 * - **Removing it leaves it where it is.** The column still holds what its
 *   last Apply laid, which is the console's again; the plan says it is
 *   handed back (`console (<value>)`), never put back to Cloudgate's
 *   default.
 *
 * **A tier or node type is never the console's**: Cloud SQL's
 * `settings.tier` and Memorystore's `node_type` are size-bearing,
 * so they are not in the table below: taken out, one falls back to the
 * entry's `size` (`gcp-size.ts`, `size-override.ts`), and no Database
 * page on Google Cloud changes either (the RDS and ElastiCache settings
 * routes refuse a row on Google Cloud). Point-in-time recovery is the
 * config's, never the console's, so it is not here.
 */

/** A console setting of a database on Cloud SQL or Memorystore, by the page's own name. */
export type GcpConsoleSetting = 'backupRetentionDays' | 'highAvailability';

/** One console-owned argument: the setting it is, and how its value is written there. */
interface ConsoleOwned {
  readonly setting: GcpConsoleSetting;
  /** The column's value for a native one, or `undefined` when none fits. */
  readonly column: (value: unknown) => number | boolean | undefined;
}

const SECONDS_A_DAY = 86_400;

const count = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) ? value : undefined;
/** High availability is one replica or more. */
const replicas = (value: unknown) =>
  typeof value === 'number' ? value > 0 : undefined;
/** Memorystore's retention, a duration in seconds (`259200s`), in whole days. */
const days = (value: unknown) => {
  const seconds =
    typeof value === 'string' && /^\d+s$/.test(value)
      ? Number(value.slice(0, -1))
      : undefined;
  return seconds !== undefined && seconds % SECONDS_A_DAY === 0
    ? seconds / SECONDS_A_DAY
    : undefined;
};

/**
 * The console-owned arguments, by the address they are of, each by its
 * dotted path in the provider's spelling.
 */
export const GCP_CONSOLE_OWNED: Readonly<
  Record<string, Readonly<Record<string, ConsoleOwned>>>
> = {
  [CLOUD_SQL_INSTANCE_ADDRESS]: {
    'settings.backup_configuration.backup_retention_settings.retained_backups':
      { setting: 'backupRetentionDays', column: count },
  },
  [MEMORYSTORE_INSTANCE_ADDRESS]: {
    replica_count: { setting: 'highAvailability', column: replicas },
    'automated_backup_config.retention': {
      setting: 'backupRetentionDays',
      column: days,
    },
  },
};

const dotted = (path: readonly PathPart[]) =>
  path.every((part) => typeof part === 'string') ? path.join('.') : null;

/** Whether the leaf at `path` of `address` is a setting the console owned. */
export function isGcpConsoleOwned(
  address: string,
  path: readonly PathPart[],
): boolean {
  const owned = Object.hasOwn(GCP_CONSOLE_OWNED, address)
    ? GCP_CONSOLE_OWNED[address]
    : undefined;
  const key = dotted(path);
  return owned !== undefined && key !== null && Object.hasOwn(owned, key);
}

/** Each console-owned argument a block sets, with its value. */
function ownedIn(
  block: NativeGcpBlock | null | undefined,
): { readonly path: string; readonly one: ConsoleOwned; value: unknown }[] {
  return Object.entries(GCP_CONSOLE_OWNED).flatMap(([address, owned]) => {
    const native =
      block && Object.hasOwn(block, address) ? block[address] : undefined;
    if (!native) return [];
    return Object.entries(owned).flatMap(([key, one]) => {
      const path = key.split('.');
      const value = valueAt(native, path);
      return value === undefined
        ? []
        : [
            {
              path: `native.gcp.${JSON.stringify(address)}${pathText(path)}`,
              one,
              value,
            },
          ];
    });
  });
}

/**
 * The native path that sets a console setting, as the file spells
 * it, or `null` when the block leaves it to the console.
 */
export function gcpNativeSettingOf(
  block: NativeGcpBlock | null | undefined,
  setting: GcpConsoleSetting,
): string | null {
  return (
    ownedIn(block).find(({ one }) => one.setting === setting)?.path ?? null
  );
}

/**
 * Why the cloud Database page or the Backups tab may not change these
 * settings: one clause per setting the config's applied block sets
 * natively, or `null`.
 */
export function gcpConsoleRefusalOf(
  name: string,
  block: NativeGcpBlock | null | undefined,
  settings: readonly GcpConsoleSetting[],
): string | null {
  return consoleRefusalSentence(
    name,
    settings.map((setting) => [setting, gcpNativeSettingOf(block, setting)]),
  );
}

/** The column values a block's console-owned values write, by setting. */
function columnsOf(
  block: NativeGcpBlock | null | undefined,
): Partial<Record<GcpConsoleSetting, number | boolean>> {
  const columns: Partial<Record<GcpConsoleSetting, number | boolean>> = {};
  for (const { one, value } of ownedIn(block)) {
    const column = one.column(value);
    if (column !== undefined) columns[one.setting] = column;
  }
  return columns;
}

/**
 * What an Apply writes to a postgres's row on Cloud SQL: the block
 * its entry applies, `null` for none, and a native backup count to the
 * Backups tab's own column.
 */
export function cloudSqlNativeColumns(
  block: NativeGcpBlock | null | undefined,
): {
  readonly nativeGcp: NativeGcpBlock | null;
  readonly backupRetentionDays?: number;
} {
  const { backupRetentionDays } = columnsOf(block);
  return {
    nativeGcp: block ?? null,
    ...(typeof backupRetentionDays === 'number' ? { backupRetentionDays } : {}),
  };
}

/** What an Apply writes to a redis's row on Memorystore, as {@link cloudSqlNativeColumns}. */
export function memorystoreNativeColumns(
  block: NativeGcpBlock | null | undefined,
): {
  readonly nativeGcp: NativeGcpBlock | null;
  readonly memorystoreHighAvailability?: boolean;
  readonly memorystoreBackupRetentionDays?: number;
} {
  const { highAvailability, backupRetentionDays } = columnsOf(block);
  return {
    nativeGcp: block ?? null,
    ...(typeof highAvailability === 'boolean'
      ? { memorystoreHighAvailability: highAvailability }
      : {}),
    ...(typeof backupRetentionDays === 'number'
      ? { memorystoreBackupRetentionDays: backupRetentionDays }
      : {}),
  };
}
