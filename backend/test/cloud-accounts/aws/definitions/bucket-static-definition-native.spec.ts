import { bucketDefinition } from '../../../../src/cloud-accounts/aws/definitions/bucket-definition';
import type { BucketDefinitionInput } from '../../../../src/cloud-accounts/aws/definitions/bucket-definition';
import {
  STATIC_ORIGIN_ID,
  staticDefinition,
} from '../../../../src/cloud-accounts/aws/definitions/static-definition';
import type { StaticDefinitionInput } from '../../../../src/cloud-accounts/aws/definitions/static-definition';
import type { NativeAwsBlock } from '../../../../src/native/aws-native';
import { resource } from './definition-helpers';

/**
 * ADR-0044 rule 3: `native.aws` laid over a `bucket`'s S3
 * definition and a `static` site's S3 + CloudFront one, before
 * `main.tf.json` is written. Pure: what the operator writes in, what the
 * definition holds out.
 */

const ACCOUNT = {
  cloudAccountId: 'cloud-acct-1',
  awsAccountId: '123456789012',
  deployRoleArn: 'arn:aws:iam::123456789012:role/cloudgate/cloudgate-deploy',
  externalId: 'ext-abc',
};

function bucketOf(
  native: NativeAwsBlock | null | undefined,
  overrides: Partial<BucketDefinitionInput> = {},
) {
  return bucketDefinition({
    configName: 'uploads',
    bucketName: 'uploads-k3f9a2qd-123456789012-eu-west-1-an',
    account: ACCOUNT,
    region: 'eu-west-1',
    environmentId: 'env-prod',
    stateId: 'state-bucket-1',
    origins: [],
    native,
    ...overrides,
  });
}

function siteOf(
  native: NativeAwsBlock | null | undefined,
  overrides: Partial<StaticDefinitionInput> = {},
) {
  return staticDefinition({
    configName: 'docs',
    serviceId: 'app_static_1',
    bucketName: 'docs-p4x8m2rt-123456789012-eu-west-1-an',
    spa: false,
    account: ACCOUNT,
    region: 'eu-west-1',
    environmentId: 'env-prod',
    stateId: 'state-static-1',
    liveFolder: 'dep-1',
    native,
    ...overrides,
  });
}

const KMS: NativeAwsBlock = {
  'aws_s3_bucket_server_side_encryption_configuration.bucket': {
    rule: [
      {
        apply_server_side_encryption_by_default: {
          sse_algorithm: 'aws:kms',
        },
        bucket_key_enabled: true,
      },
    ],
  },
};

describe('bucketDefinition native.aws', () => {
  it('writes exactly what it wrote before with no block, or an empty one', () => {
    expect(bucketOf(undefined)).toEqual(bucketOf(null));
    expect(bucketOf({})).toEqual(bucketOf(null));
  });

  it('replaces its encryption rule whole, keeping the bucket it encrypts', () => {
    const encryption = resource(
      bucketOf(KMS),
      'aws_s3_bucket_server_side_encryption_configuration.bucket',
    );

    expect(encryption).toEqual({
      bucket: '${aws_s3_bucket.bucket.id}',
      rule: [
        {
          apply_server_side_encryption_by_default: {
            sse_algorithm: 'aws:kms',
          },
          bucket_key_enabled: true,
        },
      ],
    });
  });

  it('lays each CORS rule written with the origins its page trusts', () => {
    const cors = resource(
      bucketOf(
        {
          'aws_s3_bucket_cors_configuration.bucket': {
            cors_rule: [
              {
                allowed_methods: ['GET', 'PUT'],
                allowed_headers: ['*'],
                max_age_seconds: 3600,
              },
              { allowed_methods: ['HEAD'] },
            ],
          },
        },
        { origins: ['https://app.example.com'] },
      ),
      'aws_s3_bucket_cors_configuration.bucket',
    );

    expect(cors.cors_rule).toEqual([
      {
        allowed_methods: ['GET', 'PUT'],
        allowed_headers: ['*'],
        max_age_seconds: 3600,
        allowed_origins: ['https://app.example.com'],
      },
      {
        allowed_methods: ['HEAD'],
        allowed_origins: ['https://app.example.com'],
      },
    ]);
  });

  it('lays a plain bucket argument and keeps every one of Cloudgate’s', () => {
    const bucket = resource(
      bucketOf({ 'aws_s3_bucket.bucket': { object_lock_enabled: true } }),
      'aws_s3_bucket.bucket',
    );

    expect(bucket).toMatchObject({
      bucket: 'uploads-k3f9a2qd-123456789012-eu-west-1-an',
      bucket_namespace: 'account-regional',
      force_destroy: false,
      object_lock_enabled: true,
    });
  });
});

describe('staticDefinition native.aws', () => {
  it('writes exactly what it wrote before with no block', () => {
    expect(siteOf(undefined)).toEqual(siteOf(null));
  });

  it('lays price class and HTTP version, keeping the origin, aliases and certificate', () => {
    const before = resource(siteOf(null), 'aws_cloudfront_distribution.site');
    const after = resource(
      siteOf({
        'aws_cloudfront_distribution.site': {
          price_class: 'PriceClass_100',
          http_version: 'http2and3',
        },
      }),
      'aws_cloudfront_distribution.site',
    );

    expect(after).toEqual({
      ...before,
      price_class: 'PriceClass_100',
      http_version: 'http2and3',
    });
  });

  it('merges the cache behaviour field by field, keeping its origin and function', () => {
    const [behavior] = resource(
      siteOf({
        'aws_cloudfront_distribution.site': {
          default_cache_behavior: {
            compress: false,
            viewer_protocol_policy: 'https-only',
          },
        },
      }),
      'aws_cloudfront_distribution.site',
    ).default_cache_behavior as Record<string, unknown>[];

    expect(behavior).toMatchObject({
      target_origin_id: STATIC_ORIGIN_ID,
      compress: false,
      viewer_protocol_policy: 'https-only',
      function_association: [
        {
          event_type: 'viewer-request',
          function_arn: '${aws_cloudfront_function.site.arn}',
        },
      ],
    });
  });

  it('replaces its error responses whole on a site without spa', () => {
    const custom = [
      {
        error_code: 404,
        response_code: 404,
        response_page_path: '/not-found.html',
      },
    ];
    const distribution = resource(
      siteOf({
        'aws_cloudfront_distribution.site': { custom_error_response: custom },
      }),
      'aws_cloudfront_distribution.site',
    );

    expect(distribution.custom_error_response).toEqual(custom);
  });

  it('lays its own bucket’s encryption', () => {
    const encryption = resource(
      siteOf({
        'aws_s3_bucket_server_side_encryption_configuration.site': {
          rule: [
            {
              apply_server_side_encryption_by_default: {
                sse_algorithm: 'aws:kms',
              },
            },
          ],
        },
      }),
      'aws_s3_bucket_server_side_encryption_configuration.site',
    );

    expect(encryption.rule).toEqual([
      {
        apply_server_side_encryption_by_default: { sse_algorithm: 'aws:kms' },
      },
    ]);
  });
});
