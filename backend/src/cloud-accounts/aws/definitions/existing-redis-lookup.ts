import { frame } from './tofu-json';
import type { TofuDefinition } from '../../definitions/tofu-json';
import type { ExistingPostgresLookupInput } from './existing-postgres-lookup';

/** The `data` addresses the lookup writes, which the reader reads back. */
export const EXISTING_REDIS_DATA = {
  /** The replication group itself. */
  group: 'cache',
  /** Its first member cluster: the engine, its version, tags and subnets. */
  member: 'cache',
  /** That cluster's cache subnet group, whose VPC the cache sits in. */
  subnets: 'cache',
  /** The serverless cache of that name, looked for once the group is not. */
  serverless: 'cache',
} as const;

/** What the lookup takes: an Existing database's, its id a replication group's. */
export type ExistingRedisLookupInput = ExistingPostgresLookupInput;

/**
 * The OpenTofu definition that looks an **Existing database** that is a
 * redis up (ADR-0033): `data` sources only, so a plan of it reads AWS
 * and can never make, change or delete anything. Pure: no AWS call, no
 * `tofu`, no database.
 *
 * The replication group (`aws_elasticache_replication_group`) gives the
 * address, the port and whether it is in cluster mode; its first member
 * cluster (`aws_elasticache_cluster`) the engine, its version and its tags;
 * that cluster's cache subnet group the VPC. AWS has no search for
 * replication groups, so a missing one fails the plan, which the reader
 * tells apart (`isMissingReplicationGroup`) and follows with
 * {@link existingServerlessLookup}. The AUTH token is never in it.
 */
export function existingRedisLookup(
  input: ExistingRedisLookupInput,
): TofuDefinition {
  const group = `data.aws_elasticache_replication_group.${EXISTING_REDIS_DATA.group}`;
  const member = `data.aws_elasticache_cluster.${EXISTING_REDIS_DATA.member}`;
  return {
    ...lookupFrame(input),
    data: {
      aws_elasticache_replication_group: {
        [EXISTING_REDIS_DATA.group]: {
          replication_group_id: input.identifier,
        },
      },
      aws_elasticache_cluster: {
        [EXISTING_REDIS_DATA.member]: {
          cluster_id: `\${tolist(${group}.member_clusters)[0]}`,
        },
      },
      aws_elasticache_subnet_group: {
        [EXISTING_REDIS_DATA.subnets]: {
          name: `\${${member}.subnet_group_name}`,
        },
      },
    },
  };
}

/**
 * The second look, only once AWS has no replication group by that id
 * whether it is a **serverless** cache's name, which a `redis`
 * cannot use (it hands out one URL form, and serverless is not it), so the
 * refusal says what was given rather than "not found".
 */
export function existingServerlessLookup(
  input: ExistingRedisLookupInput,
): TofuDefinition {
  return {
    ...lookupFrame(input),
    data: {
      aws_elasticache_serverless_cache: {
        [EXISTING_REDIS_DATA.serverless]: { name: input.identifier },
      },
    },
  };
}

function lookupFrame(input: ExistingRedisLookupInput) {
  return frame(input.account, input.region, {
    cloudAccountId: input.account.cloudAccountId,
    environmentId: input.environmentId,
    stateId: input.stateId,
  });
}
