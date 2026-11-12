import {
  blameNativeAws,
  laysNativeAws,
  nativeAwsDiffs,
  nativeAwsReplaceRefusals,
  storedNativeAwsRefusal,
} from '../../src/native/aws-lay';

/**
 * ADR-0044 rules 5 and 9: what a deploy does with a Service's
 * stored `native.aws`: a value locked since it was applied fails the
 * Deployment naming it, and a value only AWS can judge names its path.
 */
describe('laysNativeAws', () => {
  it('lays on the kinds the one ECS builder makes, a bucket and a static site, and RDS and ElastiCache', () => {
    expect(
      ['web', 'web-private', 'worker', 'cron', 'bucket', 'static'].map(
        laysNativeAws,
      ),
    ).toEqual([true, true, true, true, true, true]);
    expect(['postgres', 'mysql', 'redis'].map(laysNativeAws)).toEqual([
      true,
      true,
      true,
    ]);
  });
});

describe('storedNativeAwsRefusal', () => {
  it('refuses a stored static site block setting its error responses while its spa owns them', () => {
    const stored = {
      'aws_cloudfront_distribution.site': {
        custom_error_response: [{ error_code: 404 }],
      },
    };
    expect(
      storedNativeAwsRefusal('docs', 'static', stored, {
        linkedKinds: [],
        spa: true,
      }),
    ).toContain(
      'docs.native.aws."aws_cloudfront_distribution.site".custom_error_response: refused - locked: the config\'s spa sets it',
    );
    expect(
      storedNativeAwsRefusal('docs', 'static', stored, {
        linkedKinds: [],
        spa: false,
      }),
    ).toBeNull();
  });

  it('fails a deploy of a database whose stored block now holds a locked value, naming it', () => {
    expect(
      storedNativeAwsRefusal(
        'pg-1',
        'postgres',
        { 'aws_db_instance.database': { publicly_accessible: true } },
        { linkedKinds: [] },
      ),
    ).toContain(
      'pg-1.native.aws."aws_db_instance.database".publicly_accessible: refused - locked',
    );
  });

  it('passes a stored block with nothing locked, and none at all', () => {
    const facts = { linkedKinds: [] };
    expect(
      storedNativeAwsRefusal(
        'api',
        'web',
        { 'aws_ecs_service.service': { enable_execute_command: true } },
        facts,
      ),
    ).toBeNull();
    expect(storedNativeAwsRefusal('api', 'web', null, facts)).toBeNull();
  });

  it('refuses a stored block holding a locked value, naming it, never stripping it', () => {
    expect(
      storedNativeAwsRefusal(
        'api',
        'web',
        {
          'aws_ecs_service.service': {
            desired_count: 4,
            enable_execute_command: true,
          },
        },
        { linkedKinds: [] },
      ),
    ).toMatch(
      /^This Service's stored native\.aws is refused, so nothing was changed: api\.native\.aws\."aws_ecs_service\.service"\.desired_count: refused - .+\. Correct the Project config and apply its plan$/,
    );
  });

  it('refuses a stored address the Service no longer makes', () => {
    expect(
      storedNativeAwsRefusal(
        'api',
        'web',
        { 'aws_iam_role_policy.buckets': { name: 'x' } },
        { linkedKinds: [] },
      ),
    ).toContain('api.native.aws."aws_iam_role_policy.buckets"');
  });
});

describe('blameNativeAws', () => {
  it('names the native path AWS refused, in the provider’s spelling or ECS’s', () => {
    const stored = {
      'aws_ecs_service.service': { health_check_grace_period_seconds: 99999 },
      'aws_ecs_task_definition.service': {
        container_definitions: { stopTimeout: 900 },
      },
    };
    expect(
      blameNativeAws(
        'InvalidParameterException: healthCheckGracePeriodSeconds must be at most 2147483647',
        stored,
      ),
    ).toBe(
      'AWS refused this Service\'s native.aws."aws_ecs_service.service".health_check_grace_period_seconds: InvalidParameterException: healthCheckGracePeriodSeconds must be at most 2147483647',
    );
    expect(
      blameNativeAws(
        'ClientException: Invalid setting for container stopTimeout',
        stored,
      ),
    ).toBe(
      'AWS refused this Service\'s native.aws."aws_ecs_task_definition.service".container_definitions.stopTimeout: ClientException: Invalid setting for container stopTimeout',
    );
  });

  it('leaves a refusal that names no native path as AWS wrote it', () => {
    const message = 'AccessDeniedException: not authorized';
    expect(
      blameNativeAws(message, {
        'aws_ecs_service.service': { enable_execute_command: true },
      }),
    ).toBe(message);
    expect(blameNativeAws(message, null)).toBe(message);
  });
});

/**
 * A native change the cloud plan carries out as a
 * replace of what holds data is refused, naming the path, read from the
 * plan's actions.
 */
describe('nativeAwsReplaceRefusals', () => {
  const block = {
    'aws_s3_bucket.bucket': {
      object_lock_enabled: true,
      request_payer: 'Requester',
    },
  };
  const replaced = {
    address: 'aws_s3_bucket.bucket',
    action: 'replace',
    fields: ['object_lock_enabled'],
  };

  it('refuses the native path whose change replaces the bucket, and only it', () => {
    expect(nativeAwsReplaceRefusals('uploads', block, [replaced])).toEqual([
      {
        at: 'uploads.native.aws."aws_s3_bucket.bucket".object_lock_enabled',
        message:
          'uploads.native.aws."aws_s3_bucket.bucket".object_lock_enabled: refused - OpenTofu would replace the bucket for it, losing every file in it',
      },
    ]);
  });

  it('refuses a static site’s bucket replace too', () => {
    expect(
      nativeAwsReplaceRefusals(
        'docs',
        { 'aws_s3_bucket.site': { object_lock_enabled: true } },
        [{ ...replaced, address: 'aws_s3_bucket.site' }],
      ).map((one) => one.message),
    ).toEqual([
      'docs.native.aws."aws_s3_bucket.site".object_lock_enabled: refused - OpenTofu would replace the site\'s bucket for it, losing every Deployment\'s files in it',
    ]);
  });

  it('refuses nothing for an in-place change, a replace native did not force, or what holds no data', () => {
    expect(
      nativeAwsReplaceRefusals('uploads', block, [
        { ...replaced, action: 'change' },
      ]),
    ).toEqual([]);
    expect(
      nativeAwsReplaceRefusals('uploads', block, [
        { ...replaced, fields: ['bucket'] },
      ]),
    ).toEqual([]);
    expect(
      nativeAwsReplaceRefusals(
        'uploads',
        {
          'aws_s3_bucket_server_side_encryption_configuration.bucket': {
            expected_bucket_owner: '123456789012',
          },
        },
        [
          {
            address:
              'aws_s3_bucket_server_side_encryption_configuration.bucket',
            action: 'replace',
            fields: ['expected_bucket_owner'],
          },
        ],
      ),
    ).toEqual([]);
    expect(nativeAwsReplaceRefusals('uploads', null, [replaced])).toEqual([]);
  });
});

/**
 * ADR-0044 rule 10: the same rule refuses a native change OpenTofu
 * would carry out as a replace of what holds a database's or a cache's
 * data, naming each native path.
 */
describe('nativeAwsReplaceRefusals on RDS and ElastiCache', () => {
  const STORAGE = 'native.aws."aws_db_instance.database".storage_encrypted';
  const WINDOW = 'native.aws."aws_db_instance.database".maintenance_window';
  const block = {
    'aws_db_instance.database': {
      storage_encrypted: false,
      maintenance_window: 'sun:03:00-sun:04:00',
    },
  };

  it('refuses the native path the replace is forced by, naming what it would replace', () => {
    expect(
      nativeAwsReplaceRefusals('pg-1', block, [
        {
          address: 'aws_db_instance.database',
          action: 'replace',
          fields: ['storage_encrypted'],
        },
      ]),
    ).toEqual([
      {
        at: `pg-1.${STORAGE}`,
        message: `pg-1.${STORAGE}: refused - OpenTofu would replace the database instance for it, deleting the data it holds (set it back, or move the data to a new Service yourself)`,
      },
    ]);
  });

  it('names every native path when the read names none that forces it', () => {
    expect(
      nativeAwsReplaceRefusals('pg-1', block, [
        { address: 'aws_db_instance.database', action: 'replace', fields: [] },
      ]).map((one) => one.at),
    ).toEqual([`pg-1.${STORAGE}`, `pg-1.${WINDOW}`]);
  });

  it("refuses a redis's replication group replaced the same way", () => {
    expect(
      nativeAwsReplaceRefusals(
        'redis',
        {
          'aws_elasticache_replication_group.cache': {
            at_rest_encryption_enabled: false,
          },
        },
        [
          {
            address: 'aws_elasticache_replication_group.cache',
            action: 'replace',
            fields: ['at_rest_encryption_enabled'],
          },
        ],
      ).map((one) => one.message),
    ).toEqual([
      'redis.native.aws."aws_elasticache_replication_group.cache".at_rest_encryption_enabled: refused - OpenTofu would replace the replication group for it, deleting the data it holds (set it back, or move the data to a new Service yourself)',
    ]);
  });

  it('lets an in-place change, a replace of what holds no data, or a step with no native block through', () => {
    expect(
      nativeAwsReplaceRefusals(
        'pg-1',
        {
          ...block,
          'aws_elasticache_parameter_group.valkey8': { description: 'x' },
        },
        [
          {
            address: 'aws_db_instance.database',
            action: 'change',
            fields: ['maintenance_window'],
          },
          {
            address: 'aws_elasticache_parameter_group.valkey8',
            action: 'replace',
            fields: ['description'],
          },
        ],
      ),
    ).toEqual([]);
    expect(
      nativeAwsReplaceRefusals('pg-1', null, [
        {
          address: 'aws_db_instance.database',
          action: 'replace',
          fields: ['engine'],
        },
      ]),
    ).toEqual([]);
  });
});

describe('nativeAwsDiffs, on a setting the console owned', () => {
  const owned = (address: string, path: readonly (string | number)[]) =>
    address === 'aws_db_instance.database' && path[0] === 'allocated_storage';
  const cloudgate = {
    aws_db_instance: { database: { allocated_storage: 50 } },
  };

  it("reads a side native sets none of as the console's, and a key taken out as handed back even where it stays", () => {
    expect(
      nativeAwsDiffs(
        undefined,
        { 'aws_db_instance.database': { allocated_storage: 50 } },
        cloudgate,
        owned,
      ),
    ).toEqual([
      {
        field: 'native.aws."aws_db_instance.database".allocated_storage',
        from: 50,
        to: 50,
        native: true,
        toConsole: true,
      },
    ]);
  });
});
