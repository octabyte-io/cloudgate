import { customAlphabet } from 'nanoid';

import type {
  DatabaseNetworkIds,
  DeletingDatabase,
} from '../cloud-accounts/aws/definitions/postgres-definition';
import { redisDefinition } from '../cloud-accounts/aws/definitions/redis-definition';
import type { RedisDefinition } from '../cloud-accounts/aws/definitions/redis-definition';
import { valkeyVersion } from '../cloud-accounts/aws/definitions/redis-version';
import type { ValkeyVersion } from '../cloud-accounts/aws/definitions/redis-version';
import type { AwsCloudAccount } from '../cloud-accounts/cloud-provider';
import type { DrizzleDB } from '../db/drizzle.module';
import type { Redis } from '../db/schema';
import { elastiCacheNodeTypeOf } from './planner/cloud-redis';
import type { ElastiCacheConsoleSettings } from './planner/plan.types';
import type { NativeAwsBlock } from '../native/aws-native';
import { snapshotDate, snapshotNames } from './rds-postgres-places';

/**
 * The console's settings of a redis on ElastiCache as a row holds them
 * what an Apply records as written, and the next plan diffs against.
 */
export function elastiCacheConsoleSettings(
  row: Pick<Redis, 'nodeType' | 'replica' | 'snapshotRetentionDays'>,
): ElastiCacheConsoleSettings {
  return {
    nodeType: row.nodeType,
    replica: row.replica,
    snapshotRetentionDays: row.snapshotRetentionDays,
  };
}

/**
 * A redis on ElastiCache's AUTH token (the AWS databases spec): 64 characters
 * Cloudgate generates, letters and digits only, so it is inside what
 * ElastiCache takes (16 to 128 printable characters, never `@`, `"` or
 * `/`) and needs no escaping in a `rediss://` URL.
 */
export const generateAuthToken = customAlphabet(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  64,
);

/**
 * The OpenTofu definition of a redis on ElastiCache from its saved row
 * its node type and version as the row holds them unless the
 * caller names the ones a change moves to, Cloudgate's settings as the
 * console holds them, and its AUTH token as a sensitive variable. A
 * change's read writes it with the step's node type and version before the
 * Apply saves them; the Apply's Cloud run writes it after, from the row
 * alone, so both write the same definition.
 */
export async function savedRedisDefinition(
  db: Pick<DrizzleDB, 'select'>,
  input: {
    readonly row: Redis;
    readonly account: AwsCloudAccount;
    readonly stateId: string;
    readonly network: DatabaseNetworkIds;
    readonly nodeType?: string;
    readonly version?: Pick<ValkeyVersion, 'engineVersion' | 'parameterFamily'>;
    /** A Delete's run: its final snapshot named, or skipped. */
    readonly deleting?: DeletingDatabase;
    /**
     * The `native.aws` a change's read lays, its step's, before the
     * Apply saves it; absent, the one the row holds, which every Cloud run
     * lays.
     */
    readonly native?: NativeAwsBlock | null;
  },
): Promise<
  | { readonly ok: true; readonly generated: RedisDefinition }
  | { readonly ok: false; readonly message: string }
> {
  const { row, account } = input;
  const name = row.configName ?? row.name;
  if (!row.cloudAccountId || !row.region) {
    return { ok: false, message: `${name} does not run in a Cloud account` };
  }
  if (!row.authToken) {
    return { ok: false, message: `${name} has no AUTH token` };
  }
  let version = input.version;
  if (!version) {
    const read = valkeyVersion(name, row.dockerImage);
    if (!read.ok) return { ok: false, message: read.refusal.message };
    version = read.version;
  }
  const nodeType = input.nodeType ?? elastiCacheNodeTypeOf(name, row);
  if (!nodeType) {
    return {
      ok: false,
      message: `${name}'s size is above every node type Cloudgate chooses`,
    };
  }
  return {
    ok: true,
    generated: redisDefinition({
      configName: name,
      serviceId: row.redisId,
      account: {
        awsAccountId: account.cloudId,
        deployRoleArn: account.deployRoleArn,
        externalId: account.externalId,
        cloudAccountId: account.cloudAccountId,
      },
      region: row.region,
      environmentId: row.environmentId,
      stateId: input.stateId,
      network: input.network,
      version,
      settings: {
        nodeType,
        replica: row.replica,
        snapshotRetentionDays: row.snapshotRetentionDays,
      },
      authToken: row.authToken,
      finalSnapshot: {
        ...(await snapshotNames(db, row.environmentId)),
        date: snapshotDate(new Date(row.createdAt)),
      },
      ...(input.deleting ? { deleting: input.deleting } : {}),
      native: input.native !== undefined ? input.native : row.nativeAws,
    }),
  };
}
