import { NETWORK_ADDRESS_RANGE } from '../../../../src/cloud-accounts/aws/definitions/network-definition';
import {
  AUTH_TOKEN_VARIABLE,
  ELASTICACHE_REDIS_DEFAULTS,
  redisDefinition,
} from '../../../../src/cloud-accounts/aws/definitions/redis-definition';
import { valkeyVersion } from '../../../../src/cloud-accounts/aws/definitions/redis-version';
import { renderDefinition } from '../../../../src/cloud-accounts/definitions/tofu-json';
import {
  addresses,
  effectiveTags,
  resource,
  taggableResources,
} from './definition-helpers';
import type { RedisDefinitionInput } from '../../../../src/cloud-accounts/aws/definitions/redis-definition';

const TOKEN = 'a'.repeat(32) + 'b'.repeat(32);

function version(image: string) {
  const read = valkeyVersion('redis', image);
  if (!read.ok) throw new Error(read.refusal.message);
  return read.version;
}

function input(
  overrides: Partial<RedisDefinitionInput> = {},
): RedisDefinitionInput {
  return {
    configName: 'redis',
    serviceId: 'Redis_Id-1',
    account: {
      cloudAccountId: 'cloud-acct-1',
      awsAccountId: '123456789012',
      deployRoleArn:
        'arn:aws:iam::123456789012:role/cloudgate/cloudgate-deploy',
      externalId: 'ext-abc',
    },
    region: 'eu-west-1',
    environmentId: 'env-prod',
    stateId: 'state-redis',
    network: {
      vpcId: 'vpc-0a1b',
      privateSubnetIds: ['subnet-0ccc', 'subnet-0ddd'],
    },
    version: version('redis:8'),
    settings: { ...ELASTICACHE_REDIS_DEFAULTS, nodeType: 'cache.t4g.small' },
    authToken: TOKEN,
    finalSnapshot: {
      projectName: 'Shop',
      environmentName: 'production',
      date: '2026-10-17',
    },
    ...overrides,
  };
}

const GROUP = 'aws_elasticache_replication_group.cache';

describe('redisDefinition', () => {
  it('holds one replication group, its subnet, parameter and security groups', () => {
    const { definition } = redisDefinition(input());

    expect(addresses(definition)).toEqual([
      'aws_elasticache_parameter_group.valkey8',
      'aws_elasticache_replication_group.cache',
      'aws_elasticache_subnet_group.cache',
      'aws_security_group.cache',
    ]);
  });

  it('is one Valkey node with cluster mode off, in the private subnets', () => {
    const { definition } = redisDefinition(input());

    expect(resource(definition, GROUP)).toMatchObject({
      replication_group_id: 'cloudgate-redisxidx1',
      engine: 'valkey',
      engine_version: '8.1',
      node_type: 'cache.t4g.small',
      cluster_mode: 'disabled',
      num_cache_clusters: 1,
      automatic_failover_enabled: false,
      multi_az_enabled: false,
      port: 6379,
      subnet_group_name: '${aws_elasticache_subnet_group.cache.name}',
      security_group_ids: ['${aws_security_group.cache.id}'],
      parameter_group_name: '${aws_elasticache_parameter_group.valkey8.name}',
    });
    expect(
      resource(definition, 'aws_elasticache_subnet_group.cache'),
    ).toMatchObject({ subnet_ids: ['subnet-0ccc', 'subnet-0ddd'] });
  });

  it('never evicts a key: its parameter group sets noeviction for its family', () => {
    const { definition } = redisDefinition(
      input({ version: version('redis:7') }),
    );

    expect(
      resource(definition, 'aws_elasticache_parameter_group.valkey7'),
    ).toMatchObject({
      family: 'valkey7',
      parameter: [{ name: 'maxmemory-policy', value: 'noeviction' }],
      lifecycle: { create_before_destroy: true },
    });
  });

  it('has encryption on in transit and at rest, with the AUTH token and no RBAC users', () => {
    const { definition } = redisDefinition(input());
    const group = resource(definition, GROUP);

    expect(group).toMatchObject({
      transit_encryption_enabled: true,
      at_rest_encryption_enabled: true,
      auth_token: `\${var.${AUTH_TOKEN_VARIABLE}}`,
    });
    expect(group).not.toHaveProperty('user_group_ids');
  });

  it('hands the AUTH token to tofu as a sensitive variable, never in the file', () => {
    const { definition, variables } = redisDefinition(input());

    expect(variables).toEqual({ [AUTH_TOKEN_VARIABLE]: TOKEN });
    expect(
      (definition.variable as Record<string, unknown>)[AUTH_TOKEN_VARIABLE],
    ).toMatchObject({ sensitive: true });
    expect(renderDefinition(definition)).not.toContain(TOKEN);
  });

  it('keeps one day of snapshots, applies at once and names its final snapshot', () => {
    const { definition } = redisDefinition(input());

    expect(resource(definition, GROUP)).toMatchObject({
      snapshot_retention_limit: 1,
      apply_immediately: true,
      final_snapshot_identifier: 'shop-production-redis-final-2026-10-17',
    });
  });

  it('turns daily snapshots off at 0', () => {
    const { definition } = redisDefinition(
      input({
        settings: {
          nodeType: 'cache.t4g.small',
          replica: false,
          snapshotRetentionDays: 0,
        },
      }),
    );

    expect(resource(definition, GROUP)).toMatchObject({
      snapshot_retention_limit: 0,
    });
  });

  it('moves a major upgrade onto a parameter group of the new family, made before the old goes', () => {
    const before = redisDefinition(input({ version: version('redis:7') }));
    const after = redisDefinition(input({ version: version('redis:8') }));

    expect(addresses(before.definition)).toContain(
      'aws_elasticache_parameter_group.valkey7',
    );
    expect(addresses(after.definition)).toContain(
      'aws_elasticache_parameter_group.valkey8',
    );
    expect(addresses(after.definition)).not.toContain(
      'aws_elasticache_parameter_group.valkey7',
    );
    expect(
      resource(after.definition, 'aws_elasticache_parameter_group.valkey8'),
    ).toMatchObject({
      family: 'valkey8',
      lifecycle: { create_before_destroy: true },
    });
    expect(resource(after.definition, GROUP)).toMatchObject({
      engine_version: '8.1',
      node_type: 'cache.t4g.small',
    });
  });

  it('runs a new node type as given, the one change that resizes', () => {
    const { definition } = redisDefinition(
      input({
        settings: {
          ...ELASTICACHE_REDIS_DEFAULTS,
          nodeType: 'cache.m7g.large',
        },
      }),
    );

    expect(resource(definition, GROUP)).toMatchObject({
      node_type: 'cache.m7g.large',
      num_cache_clusters: 1,
      automatic_failover_enabled: false,
    });
  });

  it("names the Delete's own final snapshot, or none when the data goes", () => {
    const kept = redisDefinition(
      input({
        deleting: { finalSnapshot: 'shop-production-redis-final-2026-12-01' },
      }),
    );
    const gone = redisDefinition(input({ deleting: { finalSnapshot: null } }));

    expect(resource(kept.definition, GROUP)).toMatchObject({
      final_snapshot_identifier: 'shop-production-redis-final-2026-12-01',
    });
    expect(resource(gone.definition, GROUP)).toMatchObject({
      final_snapshot_identifier: null,
    });
  });

  it('adds a replica in another zone with automatic failover when the setting is on', () => {
    const { definition } = redisDefinition(
      input({
        settings: {
          nodeType: 'cache.t4g.small',
          replica: true,
          snapshotRetentionDays: 3,
        },
      }),
    );

    expect(resource(definition, GROUP)).toMatchObject({
      num_cache_clusters: 2,
      automatic_failover_enabled: true,
      multi_az_enabled: true,
      snapshot_retention_limit: 3,
    });
  });

  it('admits the cache port only from the subnets where the Environment’s Services run', () => {
    const { definition } = redisDefinition(input());
    const group = resource(definition, 'aws_security_group.cache');

    expect(group.ingress).toEqual(
      NETWORK_ADDRESS_RANGE.publicSubnets.map(
        (cidr) =>
          expect.objectContaining({
            from_port: 6379,
            to_port: 6379,
            cidr_blocks: [cidr],
          }) as object,
      ),
    );
    expect(group.egress).toEqual([]);
  });

  it("tags every resource with Cloudgate's mark and its own address", () => {
    const { definition } = redisDefinition(input());

    for (const found of taggableResources(definition)) {
      expect(effectiveTags(definition, found.body)).toMatchObject({
        'cloudgate:cloud-account': 'cloud-acct-1',
        'cloudgate:environment': 'env-prod',
        'cloudgate:state': 'state-redis',
        'cloudgate:address': found.address,
      });
    }
  });
});
