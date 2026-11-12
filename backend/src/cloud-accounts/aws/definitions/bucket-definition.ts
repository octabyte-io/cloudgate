import {
  BUCKET_CORS_EXPOSED_HEADERS,
  BUCKET_CORS_METHODS,
} from '../../../buckets/bucket-origins';
import { frame, Resources } from './tofu-json';
import { ref } from '../../definitions/tofu-json';
import { layNativeAws } from '../../../native/aws-lay';
import type { NativeAwsBlock } from '../../../native/aws-native';
import type { AwsAccountAccess } from './tofu-json';
import type { TofuDefinition } from '../../definitions/tofu-json';

export interface BucketDefinitionInput {
  readonly configName: string;
  /**
   * Its real name, minted once by the plan that created it, in S3's account
   * regional namespace (`awsBucketName`).
   */
  readonly bucketName: string;
  readonly account: AwsAccountAccess & { readonly cloudAccountId: string };
  readonly region: string;
  readonly environmentId: string;
  /** The Service's Infrastructure state. */
  readonly stateId: string;
  /**
   * The web origins trusted to upload to it from a browser, in this
   * Environment; empty is none.
   */
  readonly origins: readonly string[];
  /**
   * Its `native.aws` (ADR-0044 rule 3), already checked: laid over
   * what this builder writes, field by field, before `main.tf.json` is
   * written. A plan read lays the entry's, a Cloud run and a read for Drift
   * the applied one its row holds. Absent or `null`: exactly Cloudgate's
   * definition.
   */
  readonly native?: NativeAwsBlock | null;
}

/** The outputs a run saves of the bucket. */
export const BUCKET_OUTPUTS = {
  name: 'bucket_name',
  arn: 'bucket_arn',
  region: 'bucket_region',
} as const;

/**
 * The OpenTofu definition of a `bucket` on AWS, its own Infrastructure state
 * (the AWS buckets spec "Bucket naming", "Browser uploads"). Pure: no AWS call,
 * no `tofu`, no database. Nothing in it is a config field: a bucket's entry
 * says only its kind and description.
 *
 * - **The bucket** is made under its real name in S3's **account regional
 *   namespace** (`bucket_namespace`), so no other AWS account can take the
 *   name. `force_destroy` is off: a destroy never empties it; a Delete that
 *   is asked to does so through the object-storage port first.
 * - **Versioning stays off** by never being managed: there is no versioning
 *   resource. S3 cannot return a bucket to "never versioned", so a resource
 *   saying `Disabled` could not put back a hand change anyway, and one
 *   saying `Suspended` would turn S3's own off into a state of its own.
 * - **Encryption is S3's default**, SSE-S3 (`AES256`), written out so a key
 *   changed by hand is Drift that the next Apply puts back.
 * - **Block Public Access** is on in all four settings, and ACLs are off
 *   (`BucketOwnerEnforced`), likewise written out to be put back.
 * - **Cloudgate's tags** reach the bucket through the provider's
 *   `default_tags`; its own address and `Name` are its resource tags.
 * - **Browser uploads**: the trusted origins are the bucket's CORS
 *   resource, one rule naming them all — S3 answers a preflight with the one
 *   origin that matched. With no origin trusted there is no CORS resource,
 *   so S3 allows none, and emptying the list destroys it.
 * - **Native**: its `native.aws` laid last, over everything above;
 *   a CORS rule it writes keeps the trusted origins.
 */
export function bucketDefinition(input: BucketDefinitionInput): TofuDefinition {
  const { account } = input;
  const mark = {
    cloudAccountId: account.cloudAccountId,
    environmentId: input.environmentId,
    stateId: input.stateId,
  };
  const r = new Resources();

  const bucket = privateBucket(r, 'bucket', input);
  const id = ref(bucket, 'id');

  if (input.origins.length > 0) {
    r.untagged('aws_s3_bucket_cors_configuration', 'bucket', {
      bucket: id,
      cors_rule: [
        {
          allowed_origins: [...input.origins],
          allowed_methods: [...BUCKET_CORS_METHODS],
          allowed_headers: ['*'],
          expose_headers: [...BUCKET_CORS_EXPOSED_HEADERS],
        },
      ],
    });
  }

  const output = (value: unknown) => ({ value });
  return {
    ...frame(account, input.region, mark),
    // Native last, over everything Cloudgate wrote.
    resource: layNativeAws(r.all(), input.native),
    output: {
      [BUCKET_OUTPUTS.name]: output(ref(bucket, 'bucket')),
      [BUCKET_OUTPUTS.arn]: output(ref(bucket, 'arn')),
      [BUCKET_OUTPUTS.region]: output(ref(bucket, 'bucket_region')),
    },
  };
}

/**
 * A private S3 bucket and the settings written out beside it, under `local`
 * its real name in the account regional namespace,
 * `force_destroy` off, Block Public Access in all four settings, ACLs off and
 * SSE-S3, each written out so a hand change is Drift. A `bucket` entry's and
 * a `static` site's own bucket alike. Returns the bucket's address.
 */
export function privateBucket(
  r: Resources,
  local: string,
  input: { readonly configName: string; readonly bucketName: string },
): string {
  const bucket = r.tagged(
    'aws_s3_bucket',
    local,
    `cloudgate/${input.configName}/${local}`,
    {
      bucket: input.bucketName,
      bucket_namespace: 'account-regional',
      force_destroy: false,
    },
  );
  const id = ref(bucket, 'id');
  r.untagged('aws_s3_bucket_public_access_block', local, {
    bucket: id,
    block_public_acls: true,
    block_public_policy: true,
    ignore_public_acls: true,
    restrict_public_buckets: true,
  });
  r.untagged('aws_s3_bucket_ownership_controls', local, {
    bucket: id,
    rule: [{ object_ownership: 'BucketOwnerEnforced' }],
  });
  r.untagged('aws_s3_bucket_server_side_encryption_configuration', local, {
    bucket: id,
    rule: [
      {
        apply_server_side_encryption_by_default: [{ sse_algorithm: 'AES256' }],
      },
    ],
  });
  return bucket;
}
