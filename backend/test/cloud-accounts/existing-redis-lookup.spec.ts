import {
  existingRedisLookup,
  existingServerlessLookup,
} from '../../src/cloud-accounts/aws/definitions/existing-redis-lookup';
import {
  foundRedis,
  foundServerless,
  isMissingReplicationGroup,
  isMissingServerlessCache,
  judgeRedisLookup,
} from '../../src/cloud-accounts/aws/plan-reader/existing-redis';
import type {
  FoundRedis,
  RedisLookupContext,
} from '../../src/cloud-accounts/aws/plan-reader/existing-redis';
import type { TofuShowJson } from '../../src/cloud-accounts/aws/plan-reader/tofu-show.types';
import { storedPlan } from '../utils/fake-cloud-port';

const HOST = 'master.acme-cache.x1y2z3.euc1.cache.amazonaws.com';

const context: RedisLookupContext = {
  serviceName: 'cache',
  identifier: 'acme-cache',
  cloudAccount: 'Production AWS (123456789012)',
  region: 'eu-central-1',
  networkVpcId: 'vpc-0f00ba11',
  madeReachable: false,
  configVersion: 'redis:8',
  tls: true,
};

const found: FoundRedis = {
  engine: 'valkey',
  engineVersion: '8.0.1',
  host: HOST,
  port: 6379,
  clusterMode: false,
  vpcId: 'vpc-0f00ba11',
  tags: { Team: 'shop' },
};

const input = {
  account: {
    awsAccountId: '123456789012',
    deployRoleArn: 'arn:aws:iam::123456789012:role/cloudgate-deploy',
    externalId: 'external-id',
    cloudAccountId: 'ca_1',
  },
  region: 'eu-central-1',
  environmentId: 'env_1',
  stateId: 'ed_1',
  identifier: 'acme-cache',
};

/** The stored lookup with its replication group's values changed. */
function groupWith(values: Record<string, unknown>): TofuShowJson {
  const show = structuredClone(storedPlan('existing-redis-lookup')) as {
    prior_state: {
      values: {
        root_module: {
          resources: { type: string; values: Record<string, unknown> }[];
        };
      };
    };
  };
  const group = show.prior_state.values.root_module.resources.find(
    (one) => one.type === 'aws_elasticache_replication_group',
  )!;
  Object.assign(group.values, values);
  return show as unknown as TofuShowJson;
}

/**
 * An Existing database that is a redis is looked up with `data`
 * sources only, and what the lookup finds is judged against ADR-0033's
 * refusals, plus a redis's own: serverless and cluster mode.
 */
describe('judgeRedisLookup, with the lookup it judges', () => {
  describe('its definitions', () => {
    it('reads AWS and can make nothing: data sources, no resource, no token', () => {
      const definition = existingRedisLookup(input);

      expect(definition.resource).toBeUndefined();
      expect(Object.keys(definition.data as object).sort()).toEqual([
        'aws_elasticache_cluster',
        'aws_elasticache_replication_group',
        'aws_elasticache_subnet_group',
      ]);
      expect(JSON.stringify(definition)).not.toContain('auth_token');
    });

    it('reads the engine from the first member cluster', () => {
      const data = existingRedisLookup(input).data as Record<
        string,
        Record<string, Record<string, unknown>>
      >;

      expect(data.aws_elasticache_replication_group.cache).toEqual({
        replication_group_id: 'acme-cache',
      });
      expect(data.aws_elasticache_cluster.cache).toEqual({
        cluster_id:
          '${tolist(data.aws_elasticache_replication_group.cache.member_clusters)[0]}',
      });
    });

    it('looks for a serverless cache by the same name, data only', () => {
      const definition = existingServerlessLookup(input);

      expect(definition.resource).toBeUndefined();
      expect(definition.data).toEqual({
        aws_elasticache_serverless_cache: { cache: { name: 'acme-cache' } },
      });
    });
  });

  describe('reading the plan', () => {
    it('finds the group, its engine and its VPC', () => {
      expect(
        foundRedis(
          storedPlan('existing-redis-lookup') as unknown as TofuShowJson,
        ),
      ).toEqual(found);
    });

    it.each([
      ['cluster mode enabled', { cluster_mode: 'enabled' }],
      ['cluster mode compatible', { cluster_mode: 'compatible' }],
      ['two shards', { num_node_groups: 2 }],
      [
        'a configuration endpoint and no primary',
        {
          cluster_mode: null,
          primary_endpoint_address: '',
          configuration_endpoint_address: 'clustercfg.acme-cache.x1y2z3',
        },
      ],
    ])('reads %s as cluster mode', (_case, values) => {
      expect(foundRedis(groupWith(values))?.clusterMode).toBe(true);
    });

    it('finds a serverless cache in the second look', () => {
      expect(
        foundServerless(
          storedPlan('existing-redis-serverless') as unknown as TofuShowJson,
        ),
      ).toBe(true);
    });

    it("tells AWS's not-found from any other failure", () => {
      expect(
        isMissingReplicationGroup(
          "reading ElastiCache Replication Group (acme-cache): couldn't find resource",
        ),
      ).toBe(true);
      expect(
        isMissingReplicationGroup(
          'operation error ElastiCache: DescribeReplicationGroups, ReplicationGroupNotFoundFault: Replication group acme-cache not found.',
        ),
      ).toBe(true);
      // What the pinned AWS provider prints for one AWS has not, as the moto
      // lane's real `tofu` showed.
      expect(
        isMissingReplicationGroup(
          'no matching ElastiCache Replication Group found',
        ),
      ).toBe(true);
      expect(
        isMissingReplicationGroup(
          'AccessDenied: not authorized to perform elasticache:DescribeReplicationGroups',
        ),
      ).toBe(false);
    });

    it("tells AWS's not-found from any other failure for the serverless look", () => {
      expect(
        isMissingServerlessCache(
          'no matching ElastiCache Serverless Cache found',
        ),
      ).toBe(true);
      expect(
        isMissingServerlessCache(
          'AccessDenied: not authorized to perform elasticache:DescribeServerlessCaches',
        ),
      ).toBe(false);
    });
  });

  it('uses one found as given, saying where and with which scheme', () => {
    expect(judgeRedisLookup(found, context)).toEqual({
      ok: true,
      address: { host: HOST, port: 6379 },
      lines: [
        `cache: existing cache acme-cache, Valkey 8.0.1, at ${HOST}:6379, TLS on (rediss://); used as given, Cloudgate changes nothing in it`,
      ],
    });
    const off = judgeRedisLookup(found, { ...context, tls: false });
    expect(off.ok && off.lines[0]).toContain('TLS off (redis://)');
  });

  it('accepts Redis OSS as well as Valkey', () => {
    const verdict = judgeRedisLookup(
      { ...found, engine: 'redis', engineVersion: '7.1.0' },
      { ...context, configVersion: null },
    );
    expect(verdict.ok && verdict.lines[0]).toContain('Redis OSS 7.1.0');
  });

  it('refuses a missing group, naming id, Cloud account and region', () => {
    expect(judgeRedisLookup('missing', context)).toEqual({
      ok: false,
      // Its page then says "AWS cannot find acme-cache".
      missing: true,
      reason:
        "cache uses the existing cache acme-cache, but AWS has no ElastiCache replication group acme-cache in Cloud account Production AWS (123456789012), region eu-central-1. Check the replication group id on cache's page; it must be in this Environment's Cloud account and region",
    });
  });

  it('refuses a serverless cache', () => {
    const verdict = judgeRedisLookup('serverless', context);
    expect(!verdict.ok && verdict.reason).toBe(
      'cache uses the existing cache acme-cache, but acme-cache is a serverless ElastiCache cache, so a redis cannot use it: give the id of a node-based replication group with cluster mode off',
    );
  });

  it('refuses another engine', () => {
    const verdict = judgeRedisLookup(
      { ...found, engine: 'memcached' },
      context,
    );
    expect(!verdict.ok && verdict.reason).toBe(
      'cache uses the existing cache acme-cache, but acme-cache runs memcached, not Valkey or Redis OSS, so a redis cannot use it',
    );
  });

  it("refuses one carrying Cloudgate's tags", () => {
    const verdict = judgeRedisLookup(
      { ...found, tags: { 'cloudgate:environment': 'env_2' } },
      context,
    );
    expect(!verdict.ok && verdict.reason).toContain(
      "acme-cache carries Cloudgate's tags (cloudgate:environment)",
    );
  });

  it('refuses cluster mode', () => {
    const verdict = judgeRedisLookup({ ...found, clusterMode: true }, context);
    expect(!verdict.ok && verdict.reason).toBe(
      'cache uses the existing cache acme-cache, but acme-cache is in cluster mode, so a redis cannot use it: it hands out one URL, to one primary endpoint. Give the id of a replication group with cluster mode off',
    );
  });

  it('refuses another VPC without the tick, and notes it with one', () => {
    const elsewhere = { ...context, networkVpcId: 'vpc-0e0e0e0e' };
    const refused = judgeRedisLookup(found, elsewhere);
    expect(!refused.ok && refused.reason).toContain(
      "acme-cache is in VPC vpc-0f00ba11, not this Environment network's VPC vpc-0e0e0e0e",
    );
    const ticked = judgeRedisLookup(found, {
      ...elsewhere,
      madeReachable: true,
    });
    expect(ticked.ok && ticked.lines[1]).toContain(
      'which Cloudgate cannot check',
    );
  });

  it('notes a major other than the config’s, refusing nothing', () => {
    const verdict = judgeRedisLookup(found, {
      ...context,
      configVersion: 'redis:7',
    });
    expect(verdict.ok && verdict.lines).toContain(
      "cache: acme-cache runs Valkey 8.0.1, and the config's version is 7; the version is not applied to an existing cache",
    );
  });
});
