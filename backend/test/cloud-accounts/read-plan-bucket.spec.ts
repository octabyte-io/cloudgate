import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readPlan } from '../../src/cloud-accounts/aws/plan-reader/read-plan';
import type { TofuShowJson } from '../../src/cloud-accounts/aws/plan-reader/tofu-show.types';

/**
 * A bucket on S3 read from the stored real plans the bucket moto lane
 * saves (`bucket-lane.moto-spec.ts`): its create, its origins edited into a
 * CORS change, and a change made by hand in the AWS console.
 */
function plan(name: string): TofuShowJson {
  return JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'plans', `${name}.json`), 'utf8'),
  ) as TofuShowJson;
}

const read = (name: string) =>
  readPlan({
    show: plan(name),
    tagSearch: [],
    context: { serviceName: 'uploads' },
  });

describe('readPlan, a bucket on S3', () => {
  it('reads a create as the bucket by its real name, with what it is made with', () => {
    const reading = read('bucket-create');

    expect(reading.summary).toEqual([
      "S3 bucket `uploads-k3f9a2qd-123456789012-eu-central-1-an`: create, versioning off, S3's default encryption, Block Public Access on",
    ]);
    expect(reading.raw.map((line) => [line.address, line.action])).toEqual([
      ['aws_s3_bucket.bucket', 'create'],
      ['aws_s3_bucket_ownership_controls.bucket', 'create'],
      ['aws_s3_bucket_public_access_block.bucket', 'create'],
      ['aws_s3_bucket_server_side_encryption_configuration.bucket', 'create'],
    ]);
    expect(reading.drift).toEqual([]);
    expect(reading.imageOnly).toBe(false);
  });

  it('reads origins edited on its page as its CORS, naming the origins', () => {
    const reading = read('bucket-cors-change');

    expect(reading.summary).toEqual([
      'Browser uploads (CORS): allow https://app.example.com',
    ]);
    expect(reading.raw).toEqual([
      expect.objectContaining({
        address: 'aws_s3_bucket_cors_configuration.bucket',
        action: 'create',
        drift: false,
      }),
    ]);
    // A refresh of the bucket itself moving its read-only `cors_rule` is not
    // a hand change: nothing puts it back.
    expect(reading.drift).toEqual([]);
  });

  it('reads a hand change in the console as Drift the Apply puts back', () => {
    const reading = read('bucket-drift');

    expect(reading.summary).toEqual([]);
    expect(reading.counts.drift).toBe(2);
    expect(reading.drift).toEqual([
      expect.objectContaining({
        address: 'aws_s3_bucket_cors_configuration.bucket',
        line: 'Browser uploads (CORS): changed outside Cloudgate, will be put back',
        deleted: false,
        replaceForcing: false,
        fields: [
          expect.objectContaining({
            field: 'cors_rule',
            hand: expect.stringContaining('"allowed_origins":["*"]') as unknown,
            cloudgate: expect.stringContaining(
              '"allowed_origins":["https://app.example.com"]',
            ) as unknown,
          }),
        ],
      }),
      expect.objectContaining({
        address: 'aws_s3_bucket_public_access_block.bucket',
        line: 'Block Public Access: will be made again',
        deleted: true,
      }),
    ]);
  });
});

describe("readPlan, a cloud web's task role reaching a bucket it links", () => {
  it('reads the stored plan as object access on that bucket alone, by its real name', () => {
    const show = plan('web-bucket-access');
    const reading = readPlan({
      show,
      tagSearch: [],
      context: { serviceName: 'api' },
    });

    expect(reading.summary).toEqual([
      "Task role's bucket access: read and write the objects of `uploads-k3f9a2qd-123456789012-eu-central-1-an`",
    ]);
    expect(reading.raw.map((line) => [line.address, line.action])).toEqual([
      ['aws_iam_role_policy.buckets', 'create'],
    ]);
    expect(reading.drift).toEqual([]);

    const change = (show.resource_changes ?? []).find(
      (one) => one.address === 'aws_iam_role_policy.buckets',
    );
    const after = change?.change.after as { policy: string; role: string };
    expect(after.role).toBe('cloudgate-svc_1');
    expect(JSON.parse(after.policy)).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: [
            's3:GetObject',
            's3:PutObject',
            's3:DeleteObject',
            's3:AbortMultipartUpload',
            's3:ListMultipartUploadParts',
          ],
          Resource: [
            'arn:aws:s3:::uploads-k3f9a2qd-123456789012-eu-central-1-an/*',
          ],
        },
        {
          Effect: 'Allow',
          Action: ['s3:ListBucket', 's3:ListBucketMultipartUploads'],
          Resource: [
            'arn:aws:s3:::uploads-k3f9a2qd-123456789012-eu-central-1-an',
          ],
        },
      ],
    });
  });
});
