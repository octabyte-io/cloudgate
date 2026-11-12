import {
  AWS_ADDRESSES,
  AWS_CONTAINER_LOCKS,
  AWS_PER_INSTANCE,
} from '../../src/native/aws-locks';
import type { AwsMadeFacts } from '../../src/native/aws-locks';
import { NATIVE_META_ARGUMENTS } from '../../src/native/native-shared';
import {
  awsAddressesMade,
  nativeAwsCheck,
  parameterFamilyOf,
} from '../../src/native/aws-native';
import {
  checkResourceArguments,
  committedContainerFields,
  committedProvider,
} from '../../src/native/provider-schema';
import type { SchemaBlock } from '../../src/native/provider-schema';

/**
 * The AWS lock table and the offline schema check behind
 * `native.aws`. The planner's own spec (`plan-environment-native-aws`)
 * drives refusals through a plan; this one holds the table to the committed
 * schemas and pins the checker's rules that a plan seldom reaches.
 */

const NONE: AwsMadeFacts = { linkedKinds: [] };

/** Whether `path` (dotted) names an argument or block of `block`. */
function names(block: SchemaBlock, path: readonly string[]): boolean {
  const [head, ...rest] = path;
  if (rest.length === 0) {
    return (
      head in (block.attributes ?? {}) || head in (block.block_types ?? {})
    );
  }
  const nested = block.block_types?.[head];
  return nested !== undefined && names(nested.block, rest);
}

describe('AWS_ADDRESSES', () => {
  const aws = committedProvider('aws');

  it.each(Object.entries(AWS_ADDRESSES))(
    '%s is a committed type, and each argument it locks is one of that type',
    (_address, entry) => {
      const block = aws.resource(entry.type);
      expect(block).toBeDefined();
      const missing = Object.keys(entry.locked ?? {}).filter(
        (path) => !names(block!, path.split('.')),
      );
      expect(missing).toEqual([]);
    },
  );

  it('locks only ContainerDefinition fields of the pinned @aws-sdk/client-ecs', () => {
    const { fields } = committedContainerFields();
    expect(
      Object.keys(AWS_CONTAINER_LOCKS).filter((key) => !fields.has(key)),
    ).toEqual([]);
  });

  it('refuses every OpenTofu meta-argument and nothing the provider calls an argument', () => {
    expect(Object.keys(NATIVE_META_ARGUMENTS).sort()).toEqual(
      [
        'connection',
        'count',
        'depends_on',
        'for_each',
        'lifecycle',
        'provider',
        'provisioner',
      ].sort(),
    );
  });

  it('names no address both as made once and as made per Domain or variable', () => {
    expect(
      Object.keys(AWS_PER_INSTANCE).filter(
        (address) => address in AWS_ADDRESSES,
      ),
    ).toEqual([]);
  });
});

describe('awsAddressesMade', () => {
  it.each([
    [
      'worker',
      NONE,
      [
        'aws_ecr_repository.service',
        'aws_ecr_lifecycle_policy.service',
        'aws_cloudwatch_log_group.service',
        'aws_iam_role.task',
        'aws_ecs_task_definition.service',
        'aws_security_group.service',
        'aws_ecs_service.service',
      ],
    ],
    [
      'cron',
      { linkedKinds: ['bucket'] },
      [
        'aws_ecr_repository.service',
        'aws_ecr_lifecycle_policy.service',
        'aws_cloudwatch_log_group.service',
        'aws_iam_role.task',
        'aws_iam_role_policy.buckets',
        'aws_ecs_task_definition.service',
        'aws_security_group.service',
      ],
    ],
    [
      'mysql',
      NONE,
      [
        'aws_db_subnet_group.database',
        'aws_security_group.database',
        'aws_db_instance.database',
      ],
    ],
    [
      'redis',
      { linkedKinds: [], parameterFamily: 'valkey8' },
      [
        'aws_elasticache_subnet_group.cache',
        'aws_security_group.cache',
        'aws_elasticache_parameter_group.valkey8',
        'aws_elasticache_replication_group.cache',
      ],
    ],
    [
      'bucket',
      { linkedKinds: [], browserOrigins: false },
      [
        'aws_s3_bucket.bucket',
        'aws_s3_bucket_public_access_block.bucket',
        'aws_s3_bucket_ownership_controls.bucket',
        'aws_s3_bucket_server_side_encryption_configuration.bucket',
      ],
    ],
    [
      'static',
      NONE,
      [
        'aws_s3_bucket.site',
        'aws_s3_bucket_public_access_block.site',
        'aws_s3_bucket_ownership_controls.site',
        'aws_s3_bucket_server_side_encryption_configuration.site',
        'aws_s3_bucket_policy.site',
        'aws_cloudfront_origin_access_control.site',
        'aws_cloudfront_function.site',
        'aws_cloudfront_distribution.site',
      ],
    ],
    ['postgres', { linkedKinds: [], existing: true }, []],
  ] as const)(
    'a %s makes what its definition writes right now',
    (kind, facts, made) => {
      expect(awsAddressesMade(kind, facts)).toEqual(made);
    },
  );
});

describe('parameterFamilyOf', () => {
  it.each([
    ['redis:8', 'valkey8'],
    ['8.0', 'valkey8'],
    ['6-alpine', 'valkey7'],
    [undefined, undefined],
    ['latest', undefined],
  ])('reads %s as %s', (image, family) => {
    expect(parameterFamilyOf(image)).toBe(family);
  });
});

describe('checkResourceArguments', () => {
  const aws = committedProvider('aws');
  const reasons = (type: string, value: Record<string, unknown>) =>
    checkResourceArguments(aws, type, value).map(
      (finding) => `${finding.path.join('/')}: ${finding.reason}`,
    );

  it('takes a value OpenTofu converts, as tofu would', () => {
    expect(
      reasons('aws_db_instance', {
        backup_retention_period: '14',
        multi_az: 'true',
        backup_window: 3,
      }),
    ).toEqual([]);
  });

  it('refuses a value OpenTofu would not convert, null, and one only the provider computes', () => {
    expect(
      reasons('aws_db_instance', {
        backup_retention_period: 'two weeks',
        multi_az: 'yes',
        maintenance_window: null,
        endpoint: 'db.example.com',
      }),
    ).toEqual([
      'backup_retention_period: must be a number',
      'multi_az: must be true or false',
      "maintenance_window: write a value, or leave the key out for Cloudgate's own",
      'endpoint: endpoint is set by the provider once the resource exists, never written',
    ]);
  });

  it('merges a block allowed once, so its required arguments may be Cloudgate’s', () => {
    // `deployment_circuit_breaker` requires both `enable` and `rollback`.
    expect(
      reasons('aws_ecs_service', {
        deployment_circuit_breaker: { rollback: true },
      }),
    ).toEqual([]);
  });

  it('asks each item of a list that replaces Cloudgate’s whole for its required arguments', () => {
    expect(
      reasons('aws_elasticache_parameter_group', {
        parameter: [{ name: 'maxmemory-policy' }],
      }),
    ).toEqual([
      "parameter/0/value: value is required in each item written, since the list replaces Cloudgate's whole",
    ]);
  });

  it('refuses a block written more times than the provider allows, and one written as a value', () => {
    expect(
      reasons('aws_ecs_service', {
        deployment_circuit_breaker: [
          { enable: true, rollback: true },
          { enable: false, rollback: false },
        ],
        alarms: 'on',
      }),
    ).toEqual([
      'deployment_circuit_breaker: deployment_circuit_breaker takes at most 1 block',
      'alarms: alarms is a block written once, as an object',
    ]);
  });

  it('checks a map’s values and a list’s items by their type', () => {
    expect(
      reasons('aws_ecs_service', {
        triggers: { a: 'x', b: { nested: true } },
      }),
    ).toEqual(['triggers/b: must be a string']);
    expect(
      reasons('aws_db_instance', {
        enabled_cloudwatch_logs_exports: ['postgresql', ['upgrade']],
      }),
    ).toEqual(['enabled_cloudwatch_logs_exports/1: must be a string']);
  });

  it('warns of a deprecated argument with the provider’s own sentence, and checks it still', () => {
    expect(
      checkResourceArguments(aws, 'aws_s3_bucket', { acl: 'private' }),
    ).toEqual([
      {
        path: ['acl'],
        severity: 'deprecated',
        reason:
          'hashicorp/aws 6.69.1 deprecates it: acl is deprecated. Use the aws_s3_bucket_acl resource instead.',
      },
    ]);
  });
});

describe('nativeAwsCheck', () => {
  it('quotes an address and a key that is not a bare name in the path it refuses', () => {
    expect(
      nativeAwsCheck(
        'api',
        'web',
        { 'aws_ecs_service.service': { triggers: { 'a.b': ['x'] } } },
        NONE,
      ).refusals.map((refusal) => refusal.at),
    ).toEqual(['api.native.aws."aws_ecs_service.service".triggers']);

    expect(
      nativeAwsCheck(
        'api',
        'web',
        { 'aws_ecs_service.service': { 'odd key': 1 } },
        NONE,
      ).refusals.map((refusal) => refusal.at),
    ).toEqual(['api.native.aws."aws_ecs_service.service"."odd key"']);
  });

  it('refuses a key that is not an address, naming the form one takes', () => {
    expect(
      nativeAwsCheck('api', 'web', { aws_ecs_service: {} }, NONE).refusals,
    ).toEqual([
      {
        at: 'api.native.aws."aws_ecs_service"',
        message:
          'api.native.aws."aws_ecs_service": refused - an address is <type>.<name>, as the plan’s cloud lines show it',
      },
    ]);
  });

  it('does not read a table’s inherited keys as locks or addresses', () => {
    const { refusals } = nativeAwsCheck(
      'api',
      'web',
      { 'aws_ecs_service.service': { constructor: 1 } },
      NONE,
    );
    expect(refusals.map((refusal) => refusal.message)).toEqual([
      'api.native.aws."aws_ecs_service.service".constructor: refused - aws_ecs_service has no argument constructor in hashicorp/aws 6.69.1, the version Cloudgate runs',
    ]);
  });
});
