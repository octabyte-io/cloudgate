import { NETWORK_ADDRESS_RANGE } from './network-definition';
import {
  finalSnapshotIdentifier,
  rdsInstanceIdentifier,
} from './postgres-definition';
import type {
  DatabaseNetworkIds,
  DeletingDatabase,
} from './postgres-definition';
import type { ValkeyVersion } from './redis-version';
import { frame, Resources, rule } from './tofu-json';
import { ref } from '../../definitions/tofu-json';
import type { AwsAccountAccess } from './tofu-json';
import type { TofuDefinition } from '../../definitions/tofu-json';
import { layNativeAws } from '../../../native/aws-lay';
import type { NativeAwsBlock } from '../../../native/aws-native';

/**
 * The replication group's id: the same folding as RDS's identifier (lower
 * case, letters, digits and single hyphens, a letter first), inside
 * ElastiCache's 40 characters.
 */
export function replicationGroupIdentifier(serviceId: string): string {
  return rdsInstanceIdentifier(serviceId).slice(0, 40);
}

/** Redis's port, the only one the cache's security group opens. */
export const REDIS_PORT = 6379;

/**
 * Cloudgate's own settings of a redis on ElastiCache, never in the config
 * (the AWS databases spec "Schema changes"): its node type (the size rule's, or
 * Cloudgate's when the entry has no size), the replica and how many days of
 * daily snapshots are kept. Editing them is the console's.
 */
export interface ElastiCacheRedisSettings {
  readonly nodeType: string;
  readonly replica: boolean;
  readonly snapshotRetentionDays: number;
}

/** What a new redis on ElastiCache starts with. */
export const ELASTICACHE_REDIS_DEFAULTS: Omit<
  ElastiCacheRedisSettings,
  'nodeType'
> = { replica: false, snapshotRetentionDays: 1 };

export interface RedisDefinitionInput {
  readonly configName: string;
  /** The Service's id, which names the replication group. */
  readonly serviceId: string;
  readonly account: AwsAccountAccess & { readonly cloudAccountId: string };
  readonly region: string;
  readonly environmentId: string;
  /** The Service's Infrastructure state. */
  readonly stateId: string;
  readonly network: DatabaseNetworkIds;
  /** The version rule's reading (`valkeyVersion`). */
  readonly version: Pick<ValkeyVersion, 'engineVersion' | 'parameterFamily'>;
  readonly settings: ElastiCacheRedisSettings;
  /** Cloudgate's generated AUTH token; reaches `tofu` as a variable only. */
  readonly authToken: string;
  /** What the final snapshot is named after, as for RDS (the AWS databases spec). */
  readonly finalSnapshot: {
    readonly projectName: string;
    readonly environmentName: string;
    /** `YYYY-MM-DD`. */
    readonly date: string;
  };
  /**
   * Written by a Delete's run alone, as for RDS: the final snapshot
   * the Delete names, or `null` when it asked for the data to go.
   */
  readonly deleting?: DeletingDatabase;
  /**
   * Its `native.aws` (ADR-0044 rule 3), already checked: laid over
   * what this builder writes, field by field, its parameter group's
   * `parameter` list whole. A plan's read lays the entry's, a Cloud run the
   * one its row holds. Absent or `null`: exactly Cloudgate's definition.
   */
  readonly native?: NativeAwsBlock | null;
}

/** The address of the replication group in a redis's definition, which a Delete's run targets. */
export const REDIS_GROUP_ADDRESS = 'aws_elasticache_replication_group.cache';

export interface RedisDefinition {
  readonly definition: TofuDefinition;
  /** Values for the definition's `sensitive` variables, as `TF_VAR_<name>`. */
  readonly variables: Record<string, string>;
}

/** The variable the AUTH token reaches `tofu` through. */
export const AUTH_TOKEN_VARIABLE = 'auth_token';

/** The outputs a run saves of the replication group. */
export const REDIS_OUTPUTS = {
  address: 'primary_endpoint_address',
  port: 'port',
  identifier: 'replication_group_id',
} as const;

/**
 * The OpenTofu definition of a `redis` on ElastiCache for Valkey, its own
 * Infrastructure state (the AWS databases spec "OpenTofu generation for a redis on
 * AWS"). Pure: no AWS call, no `tofu`, no database.
 *
 * One `aws_elasticache_replication_group` in the **Environment network**'s
 * two private subnets (its own cache subnet group): node-based, cluster
 * mode off, engine `valkey`, one node unless the replica setting is on (then
 * a second in another zone, with automatic failover). Its parameter group
 * sets `maxmemory-policy noeviction`, so a queue's keys are never evicted.
 * TLS in transit and encryption at rest are always on, with one AUTH token
 * Cloudgate generates — a `sensitive` variable, never in the file — and no
 * RBAC users. Daily snapshots are kept as Cloudgate's setting says, changes
 * apply at once, and a Delete takes a final snapshot named as RDS's is.
 *
 * The parameter group is named by its family (`valkey7`, `valkey8`) and made
 * before the old one goes, so a major upgrade moves the group onto a new one
 * in the same run rather than replacing the one it uses.
 *
 * **The security group** follows RDS's rule (`postgres-definition.ts`): the
 * cache's port only from the network's two public subnets, where this
 * Environment's cloud Services run their tasks, and no way out.
 */
export function redisDefinition(input: RedisDefinitionInput): RedisDefinition {
  const { account, network, settings, version } = input;
  const mark = {
    cloudAccountId: account.cloudAccountId,
    environmentId: input.environmentId,
    stateId: input.stateId,
  };
  const label = (part: string) => `cloudgate/${input.configName}/${part}`;
  const identifier = replicationGroupIdentifier(input.serviceId);
  const r = new Resources();

  const subnets = r.tagged(
    'aws_elasticache_subnet_group',
    'cache',
    label('subnets'),
    {
      name: identifier,
      description: 'Cloudgate: the Environment network private subnets',
      subnet_ids: [...network.privateSubnetIds],
    },
  );

  const parameters = r.tagged(
    'aws_elasticache_parameter_group',
    version.parameterFamily,
    label('parameters'),
    {
      name: `${identifier}-${version.parameterFamily}`,
      family: version.parameterFamily,
      description: 'Cloudgate: keys are never evicted (noeviction)',
      parameter: [{ name: 'maxmemory-policy', value: 'noeviction' }],
      lifecycle: { create_before_destroy: true },
    },
  );

  const group = r.tagged('aws_security_group', 'cache', label('cache'), {
    name: `cloudgate-cache-${input.serviceId}`,
    description:
      'Cloudgate: a cache, reachable from the Services of the Environment only',
    vpc_id: network.vpcId,
    ingress: NETWORK_ADDRESS_RANGE.publicSubnets.map((cidr) =>
      rule({ port: REDIS_PORT, protocol: 'tcp', cidr }),
    ),
    egress: [],
  });

  const cache = r.tagged(
    'aws_elasticache_replication_group',
    'cache',
    label('cache'),
    {
      replication_group_id: identifier,
      description: `Cloudgate: ${input.configName}`,
      engine: 'valkey',
      engine_version: version.engineVersion,
      node_type: settings.nodeType,
      cluster_mode: 'disabled',
      num_cache_clusters: settings.replica ? 2 : 1,
      automatic_failover_enabled: settings.replica,
      multi_az_enabled: settings.replica,
      parameter_group_name: ref(parameters, 'name'),
      port: REDIS_PORT,
      subnet_group_name: ref(subnets, 'name'),
      security_group_ids: [ref(group, 'id')],
      at_rest_encryption_enabled: true,
      transit_encryption_enabled: true,
      auth_token: `\${var.${AUTH_TOKEN_VARIABLE}}`,
      auto_minor_version_upgrade: true,
      snapshot_retention_limit: settings.snapshotRetentionDays,
      apply_immediately: true,
      final_snapshot_identifier: input.deleting
        ? input.deleting.finalSnapshot
        : finalSnapshotIdentifier({
            ...input.finalSnapshot,
            configName: input.configName,
          }),
    },
  );

  const output = (value: unknown) => ({ value });
  return {
    variables: { [AUTH_TOKEN_VARIABLE]: input.authToken },
    definition: {
      ...frame(account, input.region, mark),
      variable: {
        [AUTH_TOKEN_VARIABLE]: {
          type: 'string',
          sensitive: true,
          nullable: false,
        },
      },
      // Native last, over everything Cloudgate wrote.
      resource: layNativeAws(r.all(), input.native),
      output: {
        [REDIS_OUTPUTS.address]: output(ref(cache, 'primary_endpoint_address')),
        [REDIS_OUTPUTS.port]: output(ref(cache, 'port')),
        [REDIS_OUTPUTS.identifier]: output(ref(cache, 'replication_group_id')),
      },
    },
  };
}
