import {
  cloudgateTagged,
  dataSourcesOf,
  majorOf,
  reachOf,
  tagsOf,
  text,
} from './existing-postgres';
import type { LookupContext, LookupVerdict } from './existing-postgres';
import type { TofuShowJson } from './tofu-show.types';

/** What the lookup of an Existing database that is a redis found. */
export interface FoundRedis {
  /** The engine of its first member cluster: `valkey` or `redis`. */
  readonly engine: string;
  readonly engineVersion: string | null;
  /** Its primary endpoint; empty in cluster mode, which has none. */
  readonly host: string;
  readonly port: number;
  /** Whether it is in cluster mode (enabled, or compatible), or sharded. */
  readonly clusterMode: boolean;
  /** The VPC its member cluster's cache subnet group is in, when AWS said. */
  readonly vpcId: string | null;
  readonly tags: Readonly<Record<string, string>>;
}

/**
 * The replication group the lookup's plan read (`existing-redis-lookup.ts`),
 * or `null` when the plan read none. Read from the plan's refreshed state.
 */
export function foundRedis(show: TofuShowJson): FoundRedis | null {
  const data = dataSourcesOf(show);
  const group = data.find(
    (one) => one.type === 'aws_elasticache_replication_group',
  )?.values;
  if (!group) return null;
  const member = data.find(
    (one) => one.type === 'aws_elasticache_cluster',
  )?.values;
  const subnets = data.find(
    (one) => one.type === 'aws_elasticache_subnet_group',
  )?.values;
  const primary = text(group.primary_endpoint_address);
  const mode = text(group.cluster_mode);
  return {
    engine: text(member?.engine) ?? '',
    engineVersion: text(member?.engine_version),
    host: primary ?? '',
    port: Number(group.port) || 6379,
    clusterMode:
      (mode !== null && mode !== 'disabled') ||
      Number(group.num_node_groups) > 1 ||
      (primary === null && text(group.configuration_endpoint_address) !== null),
    vpcId: text(subnets?.vpc_id),
    tags: tagsOf(member?.tags),
  };
}

/** Whether the serverless look (`existingServerlessLookup`) read a cache. */
export function foundServerless(show: TofuShowJson): boolean {
  return dataSourcesOf(show).some(
    (one) => one.type === 'aws_elasticache_serverless_cache',
  );
}

/**
 * Whether a failed lookup failed because AWS has no replication group by
 * that id: AWS has no search for one, so `data
 * "aws_elasticache_replication_group"` fails the plan with ElastiCache's
 * `ReplicationGroupNotFoundFault` — which the pinned provider prints as
 * "no matching ElastiCache Replication Group found" (seen by the moto lane) — a
 * refusal to name, not a failure to report.
 */
export function isMissingReplicationGroup(message: string): boolean {
  return /ReplicationGroupNotFound|no matching ElastiCache Replication Group found|couldn't find resource|empty result|replication group \S+ not found/i.test(
    message,
  );
}

/** The same for the serverless look: AWS has no serverless cache by that name. */
export function isMissingServerlessCache(message: string): boolean {
  return /ServerlessCacheNotFound|no matching ElastiCache Serverless Cache found|couldn't find resource|empty result|not found/i.test(
    message,
  );
}

/** What a redis lookup is judged against: a postgres's, with the TLS flag. */
export interface RedisLookupContext extends Omit<LookupContext, 'engine'> {
  /** The operator's TLS on/off, which the Outputs' scheme follows. */
  readonly tls: boolean;
}

/**
 * Whether a replication group can be used as a `redis` as given (ADR-0033; the AWS
 * databases spec "Each plan's lookup"): refused when AWS has none by that
 * id (naming the id, the Cloud account and the region), when the id is a
 * serverless cache's, when its engine is neither Valkey nor Redis OSS, when
 * it carries Cloudgate's tags, when it is in cluster mode (so a `redis`
 * always hands out one URL form), or when it sits outside the Environment
 * network's VPC without the operator's tick. A major version other than
 * the config's is a note.
 */
export function judgeRedisLookup(
  found: FoundRedis | 'missing' | 'serverless',
  context: RedisLookupContext,
): LookupVerdict {
  const { serviceName: name, identifier } = context;
  const uses = `${name} uses the existing cache ${identifier}`;
  if (found === 'missing') {
    return {
      ok: false,
      // Its page then says "AWS cannot find" it.
      missing: true,
      reason: `${uses}, but AWS has no ElastiCache replication group ${identifier} in Cloud account ${context.cloudAccount}, region ${context.region}. Check the replication group id on ${name}'s page; it must be in this Environment's Cloud account and region`,
    };
  }
  if (found === 'serverless') {
    return {
      ok: false,
      reason: `${uses}, but ${identifier} is a serverless ElastiCache cache, so a redis cannot use it: give the id of a node-based replication group with cluster mode off`,
    };
  }
  if (found.engine !== 'valkey' && found.engine !== 'redis') {
    return {
      ok: false,
      reason: `${uses}, but ${identifier} runs ${found.engine || 'an engine AWS did not name'}, not Valkey or Redis OSS, so a redis cannot use it`,
    };
  }
  const tagged = cloudgateTagged(uses, identifier, found.tags);
  if (tagged) return { ok: false, reason: tagged };
  if (found.clusterMode || found.host === '') {
    return {
      ok: false,
      reason: `${uses}, but ${identifier} is in cluster mode, so a redis cannot use it: it hands out one URL, to one primary endpoint. Give the id of a replication group with cluster mode off`,
    };
  }
  const engine = engineName(found.engine);
  const lines = [
    `${name}: existing cache ${identifier}, ${engine}${found.engineVersion ? ` ${found.engineVersion}` : ''}, at ${found.host}:${found.port}, ${context.tls ? 'TLS on (rediss://)' : 'TLS off (redis://)'}; used as given, Cloudgate changes nothing in it`,
  ];
  const reach = reachOf(context, found.vpcId);
  if (reach.refusal) return { ok: false, reason: reach.refusal };
  lines.push(...reach.lines);
  const wanted = majorOf(context.configVersion);
  const running = majorOf(found.engineVersion);
  if (wanted !== null && running !== null && wanted !== running) {
    lines.push(
      `${name}: ${identifier} runs ${engine} ${found.engineVersion}, and the config's version is ${wanted}; the version is not applied to an existing cache`,
    );
  }
  return {
    ok: true,
    address: { host: found.host, port: found.port },
    lines,
  };
}

function engineName(engine: string): string {
  return engine === 'valkey' ? 'Valkey' : 'Redis OSS';
}
