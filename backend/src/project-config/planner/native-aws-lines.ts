import {
  RDS_POSTGRES_DEFAULTS,
  rdsDatabaseDefinition,
} from '../../cloud-accounts/aws/definitions/postgres-definition';
import {
  ELASTICACHE_REDIS_DEFAULTS,
  redisDefinition,
} from '../../cloud-accounts/aws/definitions/redis-definition';
import {
  networkStandIns,
  STAND_IN_IMAGE_TAG,
  STAND_IN_MARKER,
} from '../../cloud-accounts/aws/definitions/stand-ins';
import { bucketDefinition } from '../../cloud-accounts/aws/definitions/bucket-definition';
import { staticDefinition } from '../../cloud-accounts/aws/definitions/static-definition';
import { ecsDefinitionOf } from '../../cloud-accounts/aws/definitions/web-definition';
import type { CloudKind } from '../../cloud-accounts/cloud-account.schema';
import { nativeAwsDiffs } from '../../native/aws-lay';
import type {
  NativeFieldDiff,
  ResourceBlocks,
} from '../../native/native-shared';
import { isAwsConsoleOwned } from '../../native/aws-console-owned';
import { isAwsSizeBearing } from '../../native/aws-size';
import { sizeSideOf } from '../../native/size-override';
import type { AwsMadeFacts } from '../../native/aws-locks';
import type { NativeAwsBlock } from '../../native/aws-native';
import { cloudRdsCreate, rdsClassOf, savedSize } from './cloud-postgres';
import { cloudRedisCreate, elastiCacheNodeTypeOf } from './cloud-redis';
import type { DescribedEntry } from './fields';
import { comparesNative, laysNativeOn } from './native-laid';
import type { SavedService } from './plan.types';

/**
 * **A cloud Service's `native.aws` lines** (ADR-0044 rule 6): what
 * the planner adds to a Service's step on AWS, for a kind whose definition
 * lays its block (`laysNativeAws`). Pure, as the planner is.
 *
 * Off AWS, or on a kind that lays nothing yet, a block is only checked
 * it is not the Environment's block, so it plans no line and is
 * never stored (answered "checked only").
 */

/** Whether a Service on `cloud` lays its entry's `native.aws` (`native-laid.ts`). */
export function laysNativeAwsOn(
  cloud: CloudKind | undefined,
  kind: string,
): boolean {
  return laysNativeOn('aws', cloud, kind);
}

/**
 * Whether a saved Service's step compares its entry's `native.aws`
 * (`native-laid.ts`): an Application's in a Cloud account, a
 * bucket's Cloudgate made there, or a postgres's, a mysql's or a
 * redis's Cloudgate made on RDS or ElastiCache.
 */
export function comparesNativeAws(found: SavedService, kind: string): boolean {
  return comparesNative('aws', found, kind);
}

/**
 * What a `bucket`'s or a `static` site's step on AWS carries for its read
 * to lay: its entry's block, `null` for none. A `web`'s is its
 * `cloud.native` instead.
 */
export function stepNativeAws(entry: DescribedEntry): {
  readonly nativeAws: NativeAwsBlock | null;
} {
  return { nativeAws: laidAwsBlock(entry) ?? null };
}

/** The non-empty block a read and a deploy lay, or `undefined`. */
export function laidAwsBlock(
  entry: DescribedEntry,
): NativeAwsBlock | undefined {
  const block = entry.native?.aws;
  return block && Object.keys(block).length > 0 ? block : undefined;
}

/**
 * The native lines of one Service's step: each leaf its entry's block lays
 * that differs from what `stored` (its last Apply's, `undefined` on a
 * create) laid. A side neither block sets is Cloudgate's own value there,
 * so removing a key shows what it returns to.
 *
 * A size-bearing argument (`aws-size.ts`) returns to the entry's
 * `size`, shown `size (<value>)`; with no `size`, on a Service already
 * made, it is the console's and stays where it is, as a console-owned
 * setting does; on a create with neither, Cloudgate's own.
 */
export function nativeAwsLines(
  name: string,
  entry: DescribedEntry,
  stored: NativeAwsBlock | undefined,
  facts: AwsMadeFacts,
  /** A bucket's trusted origins, which its CORS is written with. */
  origins: readonly string[] = [],
  found?: SavedService,
): NativeFieldDiff[] {
  const wanted = laidAwsBlock(entry);
  if (!wanted && !stored) return [];
  const side = sizeSideOf(entry.size !== undefined, found !== undefined);
  return nativeAwsDiffs(
    wanted,
    stored,
    ownDefinition(name, entry, facts, origins, found),
    // A database's settings the console owned: a key taken out is
    // handed back to the console, at the value it has.
    (address, path) =>
      isAwsSizeBearing(address, path)
        ? side === 'console'
        : isAwsConsoleOwned(address, path[0]),
    (address, path) => isAwsSizeBearing(address, path) && side === 'size',
  );
}

/** Whether a field diff is one of a `native.aws` block's lines. */
const isNativeAwsLine = (diff: {
  readonly field: string;
  readonly native?: true;
}) => diff.native === true && diff.field.startsWith('native.aws.');

/**
 * A database's move on RDS or ElastiCache with its `native.aws`:
 * a native line moves it even when nothing else does (`empty` is the move
 * that changes nothing else), so its step reads AWS; and the move carries
 * the block its read lays, the entry's, or `null` when the entry takes its
 * last one out. `move` as it was where the Service compares no block, or
 * neither the entry nor its last Apply has one.
 */
export function withNativeAws<T extends object>(
  move: T | null,
  empty: T,
  entry: DescribedEntry,
  found: SavedService,
  fields: readonly { readonly field: string; readonly native?: true }[],
): (T & { readonly native?: NativeAwsBlock | null }) | null {
  if (!comparesNativeAws(found, entry.kind)) return move;
  const wanted = laidAwsBlock(entry);
  if (!wanted && !found.nativeAws) return move;
  const moved = move ?? (fields.some(isNativeAwsLine) ? empty : null);
  return moved ? { ...moved, native: wanted ?? null } : null;
}

const ACCOUNT = '000000000000';
const REGION = 'us-east-1';
const STAND_IN_ACCOUNT = {
  awsAccountId: ACCOUNT,
  deployRoleArn: `arn:aws:iam::${ACCOUNT}:role/${STAND_IN_MARKER}`,
  externalId: STAND_IN_MARKER,
  cloudAccountId: STAND_IN_MARKER,
};

/** Where a database's stand-in definition sits: values no native key returns to. */
const DATABASE_PLACE = {
  account: STAND_IN_ACCOUNT,
  region: REGION,
  environmentId: STAND_IN_MARKER,
  stateId: STAND_IN_MARKER,
  serviceId: STAND_IN_MARKER,
  network: {
    vpcId: STAND_IN_MARKER,
    privateSubnetIds: [STAND_IN_MARKER, STAND_IN_MARKER] as const,
  },
  finalSnapshot: {
    projectName: STAND_IN_MARKER,
    environmentName: STAND_IN_MARKER,
    date: '2000-01-01',
  },
};

/**
 * Cloudgate's own `resource` object for the entry, with no native block,
 * written from stand-ins for everything only its cloud knows (the network,
 * the account, the image): the values a native key returns to are its
 * kind's, never these. A container's health check is the image's
 * `HEALTHCHECK`, which no plan knows before a build, so a removed
 * `healthCheck` field reads `default (none)`. A Service made with no
 * `size` is written at the caps it has, as its deploy writes it,
 * so a native `cpu` taken out is the pair it runs at. `undefined` when the
 * entry cannot be written (its size refused, which the plan refuses itself).
 */
function ownDefinition(
  name: string,
  entry: DescribedEntry,
  facts: AwsMadeFacts,
  origins: readonly string[],
  found: SavedService | undefined,
): ResourceBlocks | undefined {
  const placed = {
    configName: name,
    bucketName: `${STAND_IN_MARKER}-bucket`,
    account: STAND_IN_ACCOUNT,
    region: REGION,
    environmentId: STAND_IN_MARKER,
    stateId: STAND_IN_MARKER,
  };
  // A bucket's and a static site's own: what they are written from
  // is the config's `spa` and the page's origins, never a size.
  if (entry.kind === 'bucket') {
    return bucketDefinition({ ...placed, origins }).resource as ResourceBlocks;
  }
  if (entry.kind === 'static') {
    return staticDefinition({
      ...placed,
      serviceId: STAND_IN_MARKER,
      spa: entry.build?.isStaticSpa ?? false,
      liveFolder: null,
    }).resource as ResourceBlocks;
  }
  if (
    entry.kind === 'postgres' ||
    entry.kind === 'mysql' ||
    entry.kind === 'redis'
  ) {
    return databaseDefinition(name, entry, found);
  }
  if (
    entry.kind !== 'web' &&
    entry.kind !== 'web-private' &&
    entry.kind !== 'worker' &&
    entry.kind !== 'cron'
  ) {
    return undefined;
  }
  const size =
    entry.size ??
    (found?.serviceType === 'application'
      ? savedSize(found.settings.cpuLimit, found.settings.memoryLimit)
      : undefined);
  const generated = ecsDefinitionOf(
    entry.kind,
    {
      configName: name,
      entry: {
        ...(entry.command ? { command: entry.command } : {}),
        args: entry.args ?? [],
        ...(size ? { size } : {}),
      },
      service: { serviceId: STAND_IN_MARKER, replicas: 1 },
      account: {
        ...STAND_IN_ACCOUNT,
        taskExecutionRoleArn: `arn:aws:iam::${ACCOUNT}:role/${STAND_IN_MARKER}`,
        permissionsBoundaryArn: `arn:aws:iam::${ACCOUNT}:policy/${STAND_IN_MARKER}`,
      },
      region: REGION,
      environmentId: STAND_IN_MARKER,
      stateId: STAND_IN_MARKER,
      network: networkStandIns(REGION, ACCOUNT),
      image: { tag: STAND_IN_IMAGE_TAG, architecture: 'amd64' },
      variables: { values: {}, digestSecret: STAND_IN_MARKER },
      buckets: facts.linkedKinds.includes('bucket')
        ? [`${STAND_IN_MARKER}-bucket`]
        : [],
    },
    {
      port:
        entry.kind === 'worker' || entry.kind === 'cron' ? null : entry.port,
      domains: [],
    },
  );
  if (!generated.ok) return undefined;
  return generated.definition.resource as ResourceBlocks;
}

/**
 * Cloudgate's own `resource` object for a postgres's or a mysql's RDS
 * definition, or a redis's ElastiCache one, with no native block:
 * the class, version and login the entry plans, and the console's settings
 * as the saved Service holds them now (a new one's are Cloudgate's
 * defaults), so a console-owned key taken out returns to the console's
 * value, never to a default. `undefined` when the entry's create would be
 * refused, which the plan refuses itself.
 */
function databaseDefinition(
  name: string,
  entry: Extract<DescribedEntry, { kind: 'postgres' | 'mysql' | 'redis' }>,
  found: SavedService | undefined,
): ResourceBlocks | undefined {
  if (entry.kind === 'redis') {
    const created = cloudRedisCreate(name, entry);
    if (!created.ok) return undefined;
    const saved =
      found?.serviceType === 'redis' ? found.elasticache : undefined;
    const nodeType =
      entry.size === undefined && found?.serviceType === 'redis' && saved
        ? (elastiCacheNodeTypeOf(name, {
            nodeType: saved.nodeType ?? saved.applied?.nodeType ?? null,
            cpuLimit: found.settings.cpuLimit,
            memoryLimit: found.settings.memoryLimit,
          }) ?? created.cache.size.nodeType)
        : created.cache.size.nodeType;
    return redisDefinition({
      ...DATABASE_PLACE,
      configName: name,
      version: created.cache.version,
      settings: {
        ...ELASTICACHE_REDIS_DEFAULTS,
        ...(saved
          ? {
              replica: saved.replica,
              snapshotRetentionDays: saved.snapshotRetentionDays,
            }
          : {}),
        nodeType,
      },
      authToken: STAND_IN_MARKER,
    }).definition.resource as ResourceBlocks;
  }
  const created = cloudRdsCreate(name, entry);
  if (!created.ok) return undefined;
  const saved =
    found?.serviceType === 'postgres' || found?.serviceType === 'mysql'
      ? found.rds
      : undefined;
  const instanceClass =
    entry.size === undefined && found && 'rds' in found && saved
      ? (rdsClassOf(name, {
          instanceClass:
            saved.instanceClass ?? saved.applied?.instanceClass ?? null,
          cpuLimit: found.settings.cpuLimit,
          memoryLimit: found.settings.memoryLimit,
        }) ?? created.database.size.instanceClass)
      : created.database.size.instanceClass;
  return rdsDatabaseDefinition({
    ...DATABASE_PLACE,
    engine: entry.kind,
    configName: name,
    version: created.database.version,
    settings: {
      ...RDS_POSTGRES_DEFAULTS,
      ...(saved
        ? {
            storageGb: saved.storageGb,
            maxStorageGb: saved.maxStorageGb,
            multiAz: saved.multiAz,
            backupRetentionDays: saved.backupRetentionDays,
          }
        : {}),
      instanceClass,
    },
    login: { ...created.database.login, password: STAND_IN_MARKER },
  }).definition.resource as ResourceBlocks;
}
