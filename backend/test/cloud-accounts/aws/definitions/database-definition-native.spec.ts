import {
  RDS_POSTGRES_DEFAULTS,
  rdsDatabaseDefinition,
} from '../../../../src/cloud-accounts/aws/definitions/postgres-definition';
import type { RdsDatabaseDefinitionInput } from '../../../../src/cloud-accounts/aws/definitions/postgres-definition';
import { rdsMysqlVersion } from '../../../../src/cloud-accounts/aws/definitions/mysql-version';
import { rdsPostgresVersion } from '../../../../src/cloud-accounts/aws/definitions/postgres-version';
import {
  ELASTICACHE_REDIS_DEFAULTS,
  redisDefinition,
} from '../../../../src/cloud-accounts/aws/definitions/redis-definition';
import type { RedisDefinitionInput } from '../../../../src/cloud-accounts/aws/definitions/redis-definition';
import { valkeyVersion } from '../../../../src/cloud-accounts/aws/definitions/redis-version';
import { renderDefinition } from '../../../../src/cloud-accounts/definitions/tofu-json';
import type { NativeAwsBlock } from '../../../../src/native/aws-native';
import { resource } from './definition-helpers';

/**
 * ADR-0044 rule 3: `native.aws` laid over a postgres's or a
 * mysql's RDS definition and a redis's ElastiCache one, by the same merge
 * rules as a `web`'s. Pure: what the operator writes in, what the
 * definition holds out.
 */

const ACCOUNT = {
  cloudAccountId: 'cloud-acct-1',
  awsAccountId: '123456789012',
  deployRoleArn: 'arn:aws:iam::123456789012:role/cloudgate/cloudgate-deploy',
  externalId: 'ext-abc',
};
const NETWORK = {
  vpcId: 'vpc-0a1b',
  privateSubnetIds: ['subnet-0ccc', 'subnet-0ddd'] as const,
};
const SNAPSHOT = {
  projectName: 'Shop',
  environmentName: 'production',
  date: '2026-10-17',
};

function rds(
  native: NativeAwsBlock | undefined,
  engine: 'postgres' | 'mysql' = 'postgres',
) {
  const read =
    engine === 'mysql'
      ? rdsMysqlVersion('db', 'mysql:8.4')
      : rdsPostgresVersion('db', 'postgres:17');
  if (!read.ok) throw new Error(read.refusal.message);
  const input: RdsDatabaseDefinitionInput = {
    engine,
    configName: 'db',
    serviceId: 'Db_Id-1',
    account: ACCOUNT,
    region: 'eu-west-1',
    environmentId: 'env-prod',
    stateId: 'state-db',
    network: NETWORK,
    version: read.version,
    settings: { ...RDS_POSTGRES_DEFAULTS, instanceClass: 'db.t4g.micro' },
    login: { user: 'shop', database: 'shop', password: 'p' },
    finalSnapshot: SNAPSHOT,
    native,
  };
  return rdsDatabaseDefinition(input).definition;
}

function cache(native: NativeAwsBlock | undefined) {
  const read = valkeyVersion('redis', 'redis:8');
  if (!read.ok) throw new Error(read.refusal.message);
  const input: RedisDefinitionInput = {
    configName: 'redis',
    serviceId: 'Redis_Id-1',
    account: ACCOUNT,
    region: 'eu-west-1',
    environmentId: 'env-prod',
    stateId: 'state-redis',
    network: NETWORK,
    version: read.version,
    settings: { ...ELASTICACHE_REDIS_DEFAULTS, nodeType: 'cache.t4g.small' },
    authToken: 't'.repeat(64),
    finalSnapshot: SNAPSHOT,
    native,
  };
  return redisDefinition(input).definition;
}

const INSTANCE = 'aws_db_instance.database';
const GROUP = 'aws_elasticache_replication_group.cache';

describe('rdsDatabaseDefinition with native.aws', () => {
  it('writes exactly what it wrote before with no block', () => {
    expect(renderDefinition(rds(undefined))).toBe(
      renderDefinition(rds({ [INSTANCE]: {} })),
    );
  });

  it("lays a console-owned setting over the console's, keeping every other argument", () => {
    const instance = resource(
      rds({ [INSTANCE]: { allocated_storage: 50, multi_az: true } }),
      INSTANCE,
    );

    expect(instance).toEqual(
      expect.objectContaining({
        allocated_storage: 50,
        multi_az: true,
        max_allocated_storage: RDS_POSTGRES_DEFAULTS.maxStorageGb,
        backup_retention_period: RDS_POSTGRES_DEFAULTS.backupRetentionDays,
        deletion_protection: true,
        publicly_accessible: false,
      }),
    );
  });

  it('lays an argument Cloudgate never writes, escaped as written', () => {
    const instance = resource(
      rds({
        [INSTANCE]: {
          performance_insights_enabled: true,
          maintenance_window: 'sun:03:00-sun:04:00 ${x}',
        },
      }),
      INSTANCE,
    );

    expect(instance.performance_insights_enabled).toBe(true);
    expect(instance.maintenance_window).toBe('sun:03:00-sun:04:00 $${x}');
  });

  it('lays a mysql on RDS as a postgres', () => {
    const instance = resource(
      rds({ [INSTANCE]: { allocated_storage: 80 } }, 'mysql'),
      INSTANCE,
    );

    expect(instance).toEqual(
      expect.objectContaining({ engine: 'mysql', allocated_storage: 80 }),
    );
  });

  it("keeps Cloudgate's own lifecycle-free shape: no meta-argument is added", () => {
    const instance = resource(
      rds({ [INSTANCE]: { allocated_storage: 50 } }),
      INSTANCE,
    );

    expect(instance).not.toHaveProperty('lifecycle');
  });

  it('throws on an address the definition does not write', () => {
    expect(() =>
      rds({ 'aws_ecs_service.service': { enable_execute_command: true } }),
    ).toThrow(/does not write/);
  });
});

describe('redisDefinition with native.aws', () => {
  it("replaces the parameter group's whole parameter list, keeping its own lifecycle", () => {
    const group = resource(
      cache({
        'aws_elasticache_parameter_group.valkey8': {
          parameter: [{ name: 'maxmemory-policy', value: 'allkeys-lru' }],
        },
      }),
      'aws_elasticache_parameter_group.valkey8',
    );

    expect(group.parameter).toEqual([
      { name: 'maxmemory-policy', value: 'allkeys-lru' },
    ]);
    expect(group.lifecycle).toEqual({ create_before_destroy: true });
    expect(group.family).toBe('valkey8');
  });

  it("lays the replicas and snapshot days over the console's", () => {
    const group = resource(
      cache({
        [GROUP]: {
          num_cache_clusters: 3,
          automatic_failover_enabled: true,
          snapshot_retention_limit: 5,
        },
      }),
      GROUP,
    );

    expect(group).toEqual(
      expect.objectContaining({
        num_cache_clusters: 3,
        automatic_failover_enabled: true,
        snapshot_retention_limit: 5,
        engine: 'valkey',
        transit_encryption_enabled: true,
      }),
    );
  });
});
