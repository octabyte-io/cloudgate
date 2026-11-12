import {
  AWS_CONSOLE_OWNED,
  awsConsoleRefusalOf,
  elastiCacheNativeColumns,
  rdsNativeColumns,
} from '../../src/native/aws-console-owned';
import { AWS_OPEN_SETTINGS } from '../../src/native/aws-open-settings';

/**
 * ADR-0044 rule 10: the settings the console owned before native.
 * Native wins and its Apply writes the console's column, the console
 * refuses one native sets, and a key taken out leaves the column as it is.
 */
describe('rdsNativeColumns', () => {
  it("writes each native value of an RDS instance to the console's column beside the block", () => {
    const block = {
      'aws_db_instance.database': {
        allocated_storage: 50,
        multi_az: true,
        performance_insights_enabled: true,
      },
    };

    expect(rdsNativeColumns(block)).toEqual({
      nativeAws: block,
      storageGb: 50,
      multiAz: true,
    });
  });

  it('writes the block alone once a key is taken out, so the column stays where it is', () => {
    expect(rdsNativeColumns(undefined)).toEqual({ nativeAws: null });
    expect(
      rdsNativeColumns({ 'aws_db_instance.database': { multi_az: true } }),
    ).not.toHaveProperty('storageGb');
  });
});

describe('rdsNativeColumns and awsConsoleRefusalOf, a native class or node type', () => {
  it('writes the class an RDS block sets, and the node type an ElastiCache one sets', () => {
    expect(
      rdsNativeColumns({
        'aws_db_instance.database': { instance_class: 'db.r7g.xlarge' },
      }),
    ).toMatchObject({ instanceClass: 'db.r7g.xlarge' });
    expect(
      elastiCacheNativeColumns({
        'aws_elasticache_replication_group.cache': {
          node_type: 'cache.r7g.large',
        },
      }),
    ).toMatchObject({ nodeType: 'cache.r7g.large' });
  });

  it('refuses a console class change while native sets it, naming the path', () => {
    expect(
      awsConsoleRefusalOf(
        'pg-1',
        { 'aws_db_instance.database': { instance_class: 'db.r7g.xlarge' } },
        ['instanceClass'],
      ),
    ).toBe(
      'instanceClass is set by pg-1.native.aws."aws_db_instance.database".instance_class in the Project config, which owns it while it sets it; change it there, or take the key out to hand it back to this page',
    );
    expect(awsConsoleRefusalOf('pg-1', null, ['instanceClass'])).toBeNull();
  });
});

describe('elastiCacheNativeColumns', () => {
  it("reads a redis's replica as two or more clusters, and its snapshot days", () => {
    expect(
      elastiCacheNativeColumns({
        'aws_elasticache_replication_group.cache': {
          num_cache_clusters: 3,
          automatic_failover_enabled: true,
          snapshot_retention_limit: 5,
        },
      }),
    ).toEqual({
      nativeAws: expect.any(Object) as object,
      replica: true,
      snapshotRetentionDays: 5,
    });
  });
});

describe('awsConsoleRefusalOf', () => {
  it('refuses a console change to a setting native sets, naming the path, and lets any other through', () => {
    const block = { 'aws_db_instance.database': { allocated_storage: 50 } };

    expect(awsConsoleRefusalOf('pg-1', block, ['storageGb', 'multiAz'])).toBe(
      'storageGb is set by pg-1.native.aws."aws_db_instance.database".allocated_storage in the Project config, which owns it while it sets it; change it there, or take the key out to hand it back to this page',
    );
    expect(awsConsoleRefusalOf('pg-1', block, ['multiAz'])).toBeNull();
    expect(awsConsoleRefusalOf('pg-1', null, ['storageGb'])).toBeNull();
  });

  it("refuses a redis's replica while native sets its failover", () => {
    expect(
      awsConsoleRefusalOf(
        'redis',
        {
          'aws_elasticache_replication_group.cache': {
            multi_az_enabled: true,
          },
        },
        ['replica'],
      ),
    ).toContain(
      'replica is set by redis.native.aws."aws_elasticache_replication_group.cache".multi_az_enabled',
    );
  });
});

describe('AWS_CONSOLE_OWNED in the census', () => {
  it('classes every one open, so native can set what the console owned', () => {
    const shut = Object.entries(AWS_CONSOLE_OWNED).flatMap(([address, keys]) =>
      Object.keys(keys)
        .filter((key) => !(AWS_OPEN_SETTINGS[address] ?? []).includes(key))
        .map((key) => `${address}.${key}`),
    );
    expect(shut).toEqual([]);
  });
});
