import {
  EXISTING_BUCKET_NAME_REGEX,
  existingBucketLookup,
} from '../../src/cloud-accounts/aws/definitions/existing-bucket-lookup';
import {
  foundBucket,
  judgeBucketLookup,
} from '../../src/cloud-accounts/aws/plan-reader/existing-bucket';
import type { BucketLookupContext } from '../../src/cloud-accounts/aws/plan-reader/existing-bucket';
import type { TofuShowJson } from '../../src/cloud-accounts/aws/plan-reader/tofu-show.types';
import { storedPlan } from '../utils/fake-cloud-port';

const context: BucketLookupContext = {
  serviceName: 'uploads',
  bucketName: 'acme-prod-uploads',
  cloudAccount: 'Production AWS (123456789012)',
  region: 'eu-west-1',
};

type Show = TofuShowJson & {
  prior_state: { values: { root_module: { resources: unknown[] } } };
};

const stored = () => storedPlan('existing-bucket-lookup') as unknown as Show;

/** The stored lookup with its resources changed by `edit`. */
function withResources(edit: (resources: unknown[]) => unknown[]): Show {
  const show = stored();
  return {
    ...show,
    prior_state: {
      values: {
        root_module: {
          resources: edit(show.prior_state.values.root_module.resources),
        },
      },
    },
  } as Show;
}

const typeOf = (one: unknown) => (one as { type: string }).type;

/**
 * An existing bucket is looked up with `data` sources only, and what
 * the lookup finds is judged against ADR-0033's refusals.
 */
describe('judgeBucketLookup, with the lookup it judges', () => {
  describe('its definition', () => {
    const definition = existingBucketLookup({
      account: {
        awsAccountId: '123456789012',
        deployRoleArn: 'arn:aws:iam::123456789012:role/cloudgate-deploy',
        externalId: 'external-id',
        cloudAccountId: 'ca_1',
      },
      region: 'eu-west-1',
      environmentId: 'env_1',
      stateId: 'bucket_1',
      bucketName: 'acme-prod-uploads',
    });

    it('reads AWS and can make nothing: data sources, no resource', () => {
      expect(definition.resource).toBeUndefined();
      expect(Object.keys(definition.data as object).sort()).toEqual([
        'aws_resourcegroupstaggingapi_resources',
        'aws_s3_buckets',
      ]);
    });

    it("searches the Cloud account's buckets in its region by the name", () => {
      const data = definition.data as Record<string, Record<string, object>>;
      expect(data.aws_s3_buckets.found).toEqual({
        prefix: 'acme-prod-uploads',
        bucket_region: 'eu-west-1',
      });
    });

    it('reads the tags only of a bucket the search found by its whole name', () => {
      const data = definition.data as Record<
        string,
        Record<string, Record<string, string>>
      >;
      const tags = data.aws_resourcegroupstaggingapi_resources.bucket;
      expect(tags.count).toContain('one.name == "acme-prod-uploads"');
      expect(tags.count).toMatch(/^\$\{length\(/);
      expect(tags.resource_arn_list).toContain('one.bucket_arn');
    });

    it('iterates an empty list, not null, when the search found no bucket, so a missing one is a plan the reader names', () => {
      const data = definition.data as Record<
        string,
        Record<string, Record<string, string>>
      >;
      const tags = data.aws_resourcegroupstaggingapi_resources.bucket;
      const guarded =
        'data.aws_s3_buckets.found.buckets == null ? [] : data.aws_s3_buckets.found.buckets';
      expect(tags.count).toContain(`for one in (${guarded}) :`);
      expect(tags.resource_arn_list).toContain(`for one in (${guarded}) :`);
    });
  });

  describe('a bucket name', () => {
    it.each(['acme-prod-uploads', 'a.b-c', 'abc'])('takes %s', (name) => {
      expect(EXISTING_BUCKET_NAME_REGEX.test(name)).toBe(true);
    });

    it.each(['Acme', 'ab', '-acme', 'acme-', 'acme"x', 'a'.repeat(64)])(
      'refuses %s',
      (name) => {
        expect(EXISTING_BUCKET_NAME_REGEX.test(name)).toBe(false);
      },
    );
  });

  it('uses a bucket found by its whole name with no tag of Cloudgate’s', () => {
    const found = foundBucket(stored(), 'acme-prod-uploads');
    expect(found).toEqual({
      name: 'acme-prod-uploads',
      arn: 'arn:aws:s3:::acme-prod-uploads',
      region: 'eu-west-1',
      tags: { Team: 'shop' },
    });
    expect(judgeBucketLookup(found, context)).toEqual({
      ok: true,
      lines: [
        'uploads: existing bucket acme-prod-uploads in eu-west-1; used as given, Cloudgate changes nothing in it — no CORS, versioning or encryption — and makes nothing in it',
      ],
    });
  });

  it('finds nothing when only a longer name starts with it', () => {
    const show = withResources((resources) =>
      resources
        .filter((one) => typeOf(one) === 'aws_s3_buckets')
        .map((one) => {
          const listed = one as { values: { buckets: { name: string }[] } };
          return {
            ...listed,
            values: {
              ...listed.values,
              buckets: listed.values.buckets.filter(
                (bucket) => bucket.name !== 'acme-prod-uploads',
              ),
            },
          };
        }),
    );
    expect(foundBucket(show, 'acme-prod-uploads')).toBeNull();
  });

  it('refuses a bucket AWS does not have, naming it, the Cloud account and the region', () => {
    const verdict = judgeBucketLookup(null, context);
    expect(verdict).toEqual({
      ok: false,
      reason:
        "uploads uses the existing bucket acme-prod-uploads, but AWS has no S3 bucket acme-prod-uploads in Cloud account Production AWS (123456789012), region eu-west-1. Check the name on uploads's page; it must be in this Environment's Cloud account and region",
    });
  });

  it("refuses a bucket carrying Cloudgate's tags", () => {
    const show = withResources((resources) =>
      resources.map((one) =>
        typeOf(one) === 'aws_resourcegroupstaggingapi_resources'
          ? {
              ...(one as object),
              values: {
                resource_tag_mapping_list: [
                  {
                    resource_arn: 'arn:aws:s3:::acme-prod-uploads',
                    tags: {
                      'cloudgate:environment': 'env_other',
                      'cloudgate:cloud-account': 'ca_1',
                      Team: 'shop',
                    },
                  },
                ],
              },
            }
          : one,
      ),
    );
    const verdict = judgeBucketLookup(
      foundBucket(show, 'acme-prod-uploads'),
      context,
    );
    expect(verdict).toEqual({
      ok: false,
      reason:
        "uploads uses the existing bucket acme-prod-uploads, but acme-prod-uploads carries Cloudgate's tags (cloudgate:cloud-account, cloudgate:environment), so Cloudgate made it for an Environment; an existing bucket must be one Cloudgate did not make",
    });
  });

  it('reads a bucket the tagging API returned nothing for as untagged', () => {
    const show = withResources((resources) =>
      resources.filter(
        (one) => typeOf(one) !== 'aws_resourcegroupstaggingapi_resources',
      ),
    );
    expect(foundBucket(show, 'acme-prod-uploads')?.tags).toEqual({});
  });
});
