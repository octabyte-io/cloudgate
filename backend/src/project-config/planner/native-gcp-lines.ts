import {
  STAND_IN_IMAGE_TAG,
  STAND_IN_MARKER,
} from '../../cloud-accounts/aws/definitions/stand-ins';
import { webDefinition } from '../../cloud-accounts/gcp/definitions/cloud-run-definition';
import {
  CLOUD_RUN_COPIES,
  cloudRunSize,
} from '../../cloud-accounts/gcp/definitions/cloud-run-size';
import { gcpNetworkStandIns } from '../../cloud-accounts/gcp/definitions/stand-ins';
import { cloudSqlDefinition } from '../../cloud-accounts/gcp/definitions/cloud-sql-definition';
import { memorystoreDefinition } from '../../cloud-accounts/gcp/definitions/memorystore-definition';
import type { CloudKind } from '../../cloud-accounts/cloud-account.schema';
import type {
  NativeFieldDiff,
  ResourceBlocks,
} from '../../native/native-shared';
import { closesRunApp, nativeGcpDiffs } from '../../native/gcp-lay';
import { isGcpConsoleOwned } from '../../native/gcp-console-owned';
import { isGcpSizeBearing } from '../../native/gcp-size';
import { sizeSideOf } from '../../native/size-override';
import type { NativeGcpBlock } from '../../native/gcp-native';
import { savedSize } from './cloud-postgres';
import { cloudSqlCreate, cloudSqlWanted } from './cloud-sql';
import type { DescribedEntry } from './fields';
import { memorystoreCreate } from './memorystore';
import { comparesNative, laysNativeOn } from './native-laid';
import type { PlanNote, SavedService } from './plan.types';

/**
 * **A cloud Service's `native.gcp` lines** (ADR-0044 rule 6): what
 * the planner adds to a Service's step on Google Cloud, for a kind whose
 * definition lays its block (`laysNativeGcp`). Pure, as the planner is.
 * The twin of `native-aws-lines.ts`.
 *
 * Off Google Cloud, or on a kind that lays nothing yet, a block is only
 * checked: it is not the Environment's block, so it plans no line
 * and is never stored.
 */

/** Whether a Service on `cloud` lays its entry's `native.gcp` (`native-laid.ts`). */
export function laysNativeGcpOn(
  cloud: CloudKind | undefined,
  kind: string,
): boolean {
  return laysNativeOn('gcp', cloud, kind);
}

/**
 * Whether a saved Service's step compares its entry's `native.gcp`
 * (`native-laid.ts`): an Application's on Cloud Run, or a
 * postgres's or a redis's Cloudgate made on Cloud SQL or Memorystore
 * or a mysql's on Cloud SQL; a bucket lays nothing on
 * Google Cloud yet.
 */
export function comparesNativeGcp(found: SavedService, kind: string): boolean {
  return comparesNative('gcp', found, kind);
}

/** The non-empty block a read and a deploy lay, or `undefined`. */
export function laidGcpBlock(
  entry: DescribedEntry,
): NativeGcpBlock | undefined {
  const block = entry.native?.gcp;
  return block && Object.keys(block).length > 0 ? block : undefined;
}

/**
 * The native lines of one Service's step: each leaf its entry's block lays
 * that differs from what `stored` (its last Apply's, `undefined` on a
 * create) laid. A side neither block sets is Cloudgate's own value there,
 * so removing a key shows what it returns to; a database's setting the
 * console owned is handed back to the console at the value it has.
 *
 * A size-bearing argument (`gcp-size.ts`) returns to the entry's
 * `size`, shown `size (<value>)`; with no `size`, on a Service already
 * made, it is the console's and stays where it is; on a create with
 * neither, Cloudgate's own.
 */
export function nativeGcpLines(
  name: string,
  entry: DescribedEntry,
  stored: NativeGcpBlock | undefined,
  found?: SavedService,
): NativeFieldDiff[] {
  const wanted = laidGcpBlock(entry);
  if (!wanted && !stored) return [];
  const side = sizeSideOf(entry.size !== undefined, found !== undefined);
  return nativeGcpDiffs(
    wanted,
    stored,
    ownDefinition(name, entry, found),
    (address, path) =>
      isGcpSizeBearing(address, path)
        ? side === 'console'
        : isGcpConsoleOwned(address, path),
    (address, path) => isGcpSizeBearing(address, path) && side === 'size',
  );
}

/** Whether a field diff is one of a `native.gcp` block's lines. */
const isNativeGcpLine = (diff: {
  readonly field: string;
  readonly native?: true;
}) => diff.native === true && diff.field.startsWith('native.gcp.');

/**
 * A database's move on Cloud SQL or Memorystore with its `native.gcp`
 * as `withNativeAws` is on RDS and ElastiCache: a native line
 * moves it even when nothing else does (`empty` is the move that changes
 * nothing else), so its step reads Google Cloud; and the move carries the
 * block its read lays, the entry's, or `null` when the entry takes its last
 * one out. `move` as it was where the Service compares no block, or neither
 * the entry nor its last Apply has one.
 */
export function withNativeGcp<T extends object>(
  move: T | null,
  empty: T,
  entry: DescribedEntry,
  found: SavedService,
  fields: readonly { readonly field: string; readonly native?: true }[],
): (T & { readonly native?: NativeGcpBlock | null }) | null {
  if (!comparesNativeGcp(found, entry.kind)) return move;
  const wanted = laidGcpBlock(entry);
  if (!wanted && !found.nativeGcp) return move;
  const moved = move ?? (fields.some(isNativeGcpLine) ? empty : null);
  return moved ? { ...moved, native: wanted ?? null } : null;
}

/**
 * What closing a `web`'s `run.app` address notes:
 * the line when the entry's block closes it and the one applied did not,
 * and a warning when the Service has no Domain, which would leave it
 * reached by nothing outside its Environment. `stored` is `undefined` on a
 * create, which has no Domain yet.
 */
export function runAppNotes(
  name: string,
  entry: DescribedEntry,
  stored: NativeGcpBlock | undefined,
  hasDomain: boolean,
): PlanNote[] {
  if (!closesRunApp(laidGcpBlock(entry)) || closesRunApp(stored)) return [];
  return [
    {
      kind: 'run-app-closes',
      configName: name,
      message: `${name}: run.app address closes: only Domains and this Environment reach it`,
    },
    ...(hasDomain
      ? []
      : [
          {
            kind: 'run-app-closes-no-domain' as const,
            configName: name,
            message: `${name}: has no Domain, so once its run.app address closes nothing outside this Environment reaches it; add a Domain, or leave ingress as Cloudgate writes it`,
          },
        ]),
  ];
}

/**
 * Cloudgate's own `resource` object for the entry, with no native block,
 * written from stand-ins for everything only its cloud knows (the network,
 * the account, the image): the values a native key returns to are its
 * kind's, never these. A Service made with no `size` is written at the
 * caps it has, as its deploy writes it, so a native limit taken
 * out is the pair it runs at. `undefined` when the entry cannot be written
 * (its size refused, which the plan refuses itself).
 */
function ownDefinition(
  name: string,
  entry: DescribedEntry,
  found: SavedService | undefined,
): ResourceBlocks | undefined {
  if (
    entry.kind === 'postgres' ||
    entry.kind === 'mysql' ||
    entry.kind === 'redis'
  ) {
    return databaseDefinition(name, entry, found);
  }
  if (entry.kind !== 'web') return undefined;
  const size =
    entry.size ??
    (found?.serviceType === 'application'
      ? savedSize(found.settings.cpuLimit, found.settings.memoryLimit)
      : undefined);
  const sizing = cloudRunSize(name, size);
  if (!sizing.ok) return undefined;
  const generated = webDefinition({
    configName: name,
    entry,
    service: { serviceId: STAND_IN_MARKER, copies: CLOUD_RUN_COPIES },
    cloudAccountId: STAND_IN_MARKER,
    projectId: STAND_IN_MARKER,
    region: 'us-central1',
    environmentId: STAND_IN_MARKER,
    stateId: STAND_IN_MARKER,
    network: gcpNetworkStandIns(),
    pair: sizing.pair,
    imageTag: STAND_IN_IMAGE_TAG,
    variables: {},
  });
  if (!generated.ok) return undefined;
  return generated.definition.resource as ResourceBlocks;
}

/** Where a database's stand-in definition sits: values no native key returns to. */
const DATABASE_PLACE = {
  serviceId: STAND_IN_MARKER,
  cloudAccountId: STAND_IN_MARKER,
  projectId: STAND_IN_MARKER,
  region: 'us-central1',
  environmentId: STAND_IN_MARKER,
  stateId: STAND_IN_MARKER,
  network: gcpNetworkStandIns(),
};

/**
 * Cloudgate's own `resource` object for a postgres's or a mysql's
 * Cloud SQL definition or a redis's Memorystore one, with no native
 * block: the machine
 * and version the entry plans, point-in-time recovery on, and the console's
 * settings as the saved Service holds them now (a new one's are
 * Cloudgate's defaults), so a console-owned key taken out returns to the
 * console's value, never to a default. With no size, a made one is written
 * on the machine it runs on, so a native tier or node type taken
 * out stays there. `undefined` when the entry's create would be refused,
 * which the plan refuses itself.
 */
function databaseDefinition(
  name: string,
  entry: Extract<DescribedEntry, { kind: 'postgres' | 'mysql' | 'redis' }>,
  found: SavedService | undefined,
): ResourceBlocks | undefined {
  if (entry.kind === 'redis') {
    const created = memorystoreCreate(name, entry);
    if (!created.ok) return undefined;
    const saved =
      found?.serviceType === 'redis' ? found.memorystore : undefined;
    return memorystoreDefinition({
      ...DATABASE_PLACE,
      nodeType:
        (entry.size === undefined ? saved?.nodeType : undefined) ??
        created.memorystore.size.nodeType,
      engineVersion: created.memorystore.version.engineVersion,
      highAvailability: saved?.highAvailability ?? false,
      backupRetentionDays:
        saved?.backupRetentionDays ?? created.memorystore.backupRetentionDays,
    }).resource as ResourceBlocks;
  }
  // Cloudgate's own wanted values: no entry, so none of its native block.
  const created = cloudSqlCreate(name, entry, cloudSqlWanted());
  if (!created.ok) return undefined;
  const saved =
    found?.serviceType === entry.kind &&
    (found.serviceType === 'postgres' || found.serviceType === 'mysql')
      ? found.cloudSql
      : undefined;
  return cloudSqlDefinition({
    ...DATABASE_PLACE,
    engine: entry.kind,
    tier:
      (entry.size === undefined ? saved?.tier : undefined) ??
      created.cloudSql.size.tier,
    databaseVersion: created.cloudSql.version.databaseVersion,
    login: {
      ...created.cloudSql.login,
      password: STAND_IN_MARKER,
      rootPassword: STAND_IN_MARKER,
    },
    backupRetentionDays: saved
      ? saved.applied
        ? saved.backupRetentionDays
        : null
      : created.cloudSql.backupRetentionDays,
    pointInTimeRecovery: true,
  }).definition.resource as ResourceBlocks;
}
