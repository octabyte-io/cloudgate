import { frame } from './tofu-json';
import type { AwsAccountAccess } from './tofu-json';
import type { TofuDefinition } from '../../definitions/tofu-json';

/** The `data` addresses the lookup writes, which the reader reads back. */
export const EXISTING_BUCKET_DATA = {
  /** The account's buckets in the region whose names start with the name. */
  search: 'found',
  /** The tags of the bucket itself, read only when the search found it. */
  tags: 'bucket',
} as const;

export interface ExistingBucketLookupInput {
  readonly account: AwsAccountAccess & { readonly cloudAccountId: string };
  readonly region: string;
  readonly environmentId: string;
  /** The lookup's own workspace: the bucket Service's id. It holds nothing. */
  readonly stateId: string;
  /** The S3 bucket's name, as the operator typed it. */
  readonly bucketName: string;
}

/**
 * The OpenTofu definition that looks an **existing bucket** up (ADR-0033):
 * `data` sources only, so a plan of it reads AWS and can never make,
 * change or delete anything — no CORS, versioning or encryption, no object.
 * Pure: no AWS call, no `tofu`, no database.
 *
 * `aws_s3_bucket` fails the whole plan when the name names nothing, so the
 * bucket is first searched for among the account's buckets in the region
 * (`aws_s3_buckets`, by its name as a prefix, then matched whole), and its
 * tags are read through the tagging API only when the search found it: a
 * missing bucket is then a plan that found nothing, which the reader names,
 * rather than a `tofu` error to parse. The tags are what tells a bucket
 * Cloudgate made, for this or another Environment, which is refused.
 */
export function existingBucketLookup(
  input: ExistingBucketLookupInput,
): TofuDefinition {
  const { account } = input;
  const found = `data.aws_s3_buckets.${EXISTING_BUCKET_DATA.search}.buckets`;
  // The provider leaves `buckets` null, not empty, when nothing has the
  // prefix; a `for` over null fails the whole plan, so a missing bucket
  // would be a `tofu` error rather than the refusal that names it.
  const search = `(${found} == null ? [] : ${found})`;
  // A bucket name is lowercase letters, digits, dots and hyphens only
  // (`EXISTING_BUCKET_NAME_REGEX`), so it is quoted as it is.
  const matching = `[for one in ${search} : one.bucket_arn if one.name == "${input.bucketName}"]`;
  return {
    ...frame(account, input.region, {
      cloudAccountId: account.cloudAccountId,
      environmentId: input.environmentId,
      stateId: input.stateId,
    }),
    data: {
      aws_s3_buckets: {
        [EXISTING_BUCKET_DATA.search]: {
          prefix: input.bucketName,
          bucket_region: input.region,
        },
      },
      aws_resourcegroupstaggingapi_resources: {
        [EXISTING_BUCKET_DATA.tags]: {
          count: `\${length(${matching})}`,
          resource_arn_list: `\${${matching}}`,
        },
      },
    },
  };
}

/**
 * An S3 bucket name as S3 takes one: 3 to 63 lowercase letters, digits,
 * dots and hyphens, starting and ending with a letter or digit.
 */
export const EXISTING_BUCKET_NAME_REGEX =
  /^(?=.{3,63}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
