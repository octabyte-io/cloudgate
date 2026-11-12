import {
  BUCKET_OUTPUTS,
  bucketDefinition,
} from '../../../../src/cloud-accounts/aws/definitions/bucket-definition';
import type { BucketDefinitionInput } from '../../../../src/cloud-accounts/aws/definitions/bucket-definition';
import { renderDefinition } from '../../../../src/cloud-accounts/definitions/tofu-json';
import {
  addresses,
  defaultTags,
  effectiveTags,
  resource,
  taggableResources,
} from './definition-helpers';

const NAME = 'uploads-k3f9a2qd-123456789012-eu-west-1-an';

function input(
  overrides: Partial<BucketDefinitionInput> = {},
): BucketDefinitionInput {
  return {
    configName: 'uploads',
    bucketName: NAME,
    account: {
      cloudAccountId: 'cloud-acct-1',
      awsAccountId: '123456789012',
      deployRoleArn:
        'arn:aws:iam::123456789012:role/cloudgate/cloudgate-deploy',
      externalId: 'ext-abc',
    },
    region: 'eu-west-1',
    environmentId: 'env-prod',
    stateId: 'state-bucket-1',
    origins: [],
    ...overrides,
  };
}

/**
 * A `bucket` on AWS is an S3 bucket in its own Infrastructure state,
 * made in the account regional namespace. Versioning off, S3's default
 * encryption, Block Public Access on and Cloudgate's tags, none of them a
 * config field; its browser-upload origins are its CORS resource.
 */
describe('bucketDefinition', () => {
  it('holds the bucket and its settings, and no CORS while no origin is trusted', () => {
    const definition = bucketDefinition(input());

    expect(addresses(definition)).toEqual([
      'aws_s3_bucket.bucket',
      'aws_s3_bucket_ownership_controls.bucket',
      'aws_s3_bucket_public_access_block.bucket',
      'aws_s3_bucket_server_side_encryption_configuration.bucket',
    ]);
  });

  it('makes the bucket under its real name in the account regional namespace, never emptied by a destroy', () => {
    const bucket = resource(bucketDefinition(input()), 'aws_s3_bucket.bucket');

    expect(bucket).toMatchObject({
      bucket: NAME,
      bucket_namespace: 'account-regional',
      force_destroy: false,
    });
  });

  it('leaves versioning off: no versioning resource, nothing that turns it on', () => {
    const definition = bucketDefinition(input());
    const text = renderDefinition(definition);

    expect(addresses(definition)).not.toContain(
      'aws_s3_bucket_versioning.bucket',
    );
    expect(text).not.toContain('versioning');
    expect(text).not.toContain('object_lock');
  });

  it("encrypts with S3's own default key, SSE-S3", () => {
    const encryption = resource(
      bucketDefinition(input()),
      'aws_s3_bucket_server_side_encryption_configuration.bucket',
    );

    expect(encryption).toEqual({
      bucket: '${aws_s3_bucket.bucket.id}',
      rule: [
        {
          apply_server_side_encryption_by_default: [
            { sse_algorithm: 'AES256' },
          ],
        },
      ],
    });
  });

  it('turns every Block Public Access setting on, and disables ACLs', () => {
    const definition = bucketDefinition(input());

    expect(
      resource(definition, 'aws_s3_bucket_public_access_block.bucket'),
    ).toEqual({
      bucket: '${aws_s3_bucket.bucket.id}',
      block_public_acls: true,
      block_public_policy: true,
      ignore_public_acls: true,
      restrict_public_buckets: true,
    });
    expect(
      resource(definition, 'aws_s3_bucket_ownership_controls.bucket'),
    ).toEqual({
      bucket: '${aws_s3_bucket.bucket.id}',
      rule: [{ object_ownership: 'BucketOwnerEnforced' }],
    });
  });

  it("tags the bucket with Cloudgate's mark through default_tags, and its own address", () => {
    const definition = bucketDefinition(input());

    expect(defaultTags(definition)).toEqual({
      'cloudgate:cloud-account': 'cloud-acct-1',
      'cloudgate:environment': 'env-prod',
      'cloudgate:state': 'state-bucket-1',
    });
    const taggable = taggableResources(definition).filter(
      (one) => one.type === 'aws_s3_bucket',
    );
    expect(taggable).toHaveLength(1);
    expect(effectiveTags(definition, taggable[0].body)).toEqual({
      'cloudgate:cloud-account': 'cloud-acct-1',
      'cloudgate:environment': 'env-prod',
      'cloudgate:state': 'state-bucket-1',
      'cloudgate:address': 'aws_s3_bucket.bucket',
      Name: 'cloudgate/uploads/bucket',
    });
  });

  it('is pinned to its Cloud account through the deploy role, in its region', () => {
    const provider = (
      bucketDefinition(input()).provider as Record<string, unknown>
    ).aws;

    expect(provider).toMatchObject({
      region: 'eu-west-1',
      allowed_account_ids: ['123456789012'],
      assume_role: {
        role_arn: 'arn:aws:iam::123456789012:role/cloudgate/cloudgate-deploy',
        external_id: 'ext-abc',
      },
    });
  });

  it("makes the trusted origins the bucket's CORS: one rule a browser upload needs", () => {
    const definition = bucketDefinition(
      input({
        origins: ['https://app.example.com', 'http://localhost:3000'],
      }),
    );

    expect(
      resource(definition, 'aws_s3_bucket_cors_configuration.bucket'),
    ).toEqual({
      bucket: '${aws_s3_bucket.bucket.id}',
      cors_rule: [
        {
          allowed_origins: ['https://app.example.com', 'http://localhost:3000'],
          allowed_methods: ['GET', 'PUT', 'POST', 'HEAD'],
          allowed_headers: ['*'],
          expose_headers: ['ETag'],
        },
      ],
    });
  });

  it('outputs the name, ARN and region a link hands over', () => {
    const definition = bucketDefinition(input());

    expect(definition.output).toEqual({
      [BUCKET_OUTPUTS.name]: { value: '${aws_s3_bucket.bucket.bucket}' },
      [BUCKET_OUTPUTS.arn]: { value: '${aws_s3_bucket.bucket.arn}' },
      [BUCKET_OUTPUTS.region]: {
        value: '${aws_s3_bucket.bucket.bucket_region}',
      },
    });
  });

  it('writes the same bytes for the same input', () => {
    expect(renderDefinition(bucketDefinition(input()))).toBe(
      renderDefinition(bucketDefinition(input())),
    );
  });
});
