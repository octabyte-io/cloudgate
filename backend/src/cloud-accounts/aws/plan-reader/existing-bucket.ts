import { TAG_KEYS } from '../definitions/tags';
import type {
  TofuModule,
  TofuShowJson,
  TofuStateResource,
} from './tofu-show.types';

/** What the lookup of an existing bucket found in AWS. */
export interface FoundBucket {
  readonly name: string;
  readonly arn: string;
  readonly region: string | null;
  readonly tags: Readonly<Record<string, string>>;
}

/**
 * The bucket the lookup's plan read (`existing-bucket-lookup.ts`), or `null`
 * when the account has none by that whole name in the region. Read from the
 * plan's refreshed state, where OpenTofu puts every `data` source it read
 * while planning. The search is by prefix, so only a whole match counts.
 */
export function foundBucket(
  show: TofuShowJson,
  bucketName: string,
): FoundBucket | null {
  const data = [
    ...resourcesOf(show.prior_state?.values?.root_module),
    ...resourcesOf(show.planned_values?.root_module),
  ].filter((resource) => resource.mode === 'data');
  const listed = data.find((one) => one.type === 'aws_s3_buckets')?.values
    ?.buckets;
  const bucket = (Array.isArray(listed) ? listed : [])
    .map((one) => one as Record<string, unknown>)
    .find((one) => one.name === bucketName);
  if (!bucket) return null;
  const arn = typeof bucket.bucket_arn === 'string' ? bucket.bucket_arn : '';
  const mappings = data
    .filter((one) => one.type === 'aws_resourcegroupstaggingapi_resources')
    .flatMap((one) => {
      const list = one.values?.resource_tag_mapping_list;
      return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
    });
  const tagged = mappings.find((one) => one.resource_arn === arn)?.tags;
  const tags =
    tagged && typeof tagged === 'object'
      ? Object.fromEntries(
          Object.entries(tagged as Record<string, unknown>).map(
            ([key, value]) => [key, String(value)],
          ),
        )
      : {};
  return {
    name: bucketName,
    arn,
    region:
      typeof bucket.bucket_region === 'string' && bucket.bucket_region !== ''
        ? bucket.bucket_region
        : null,
    tags,
  };
}

function resourcesOf(module: TofuModule | undefined): TofuStateResource[] {
  if (!module) return [];
  return [
    ...(module.resources ?? []),
    ...(module.child_modules ?? []).flatMap(resourcesOf),
  ];
}

/** What a lookup is judged against: the Service and where it looks. */
export interface BucketLookupContext {
  /** The Service's Config name. */
  readonly serviceName: string;
  readonly bucketName: string;
  /** The Cloud account as an operator knows it: its name and AWS account id. */
  readonly cloudAccount: string;
  readonly region: string;
}

export type BucketLookupVerdict =
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly lines: string[] };

/**
 * Whether an existing bucket can be used as given (ADR-0033, the AWS buckets spec
 * "Use existing"): refused when the Cloud account has no such bucket in the
 * region, naming it, the Cloud account and the region, and when it carries
 * Cloudgate's tags — one Cloudgate made, for this or another Environment,
 * which one Environment must not take over.
 */
export function judgeBucketLookup(
  found: FoundBucket | null,
  context: BucketLookupContext,
): BucketLookupVerdict {
  const { serviceName: name, bucketName } = context;
  const uses = `${name} uses the existing bucket ${bucketName}`;
  if (!found) {
    return {
      ok: false,
      reason: `${uses}, but AWS has no S3 bucket ${bucketName} in Cloud account ${context.cloudAccount}, region ${context.region}. Check the name on ${name}'s page; it must be in this Environment's Cloud account and region`,
    };
  }
  const ours = Object.keys(found.tags).filter((key) =>
    (Object.values(TAG_KEYS) as string[]).includes(key),
  );
  if (ours.length > 0) {
    return {
      ok: false,
      reason: `${uses}, but ${bucketName} carries Cloudgate's tags (${ours.sort().join(', ')}), so Cloudgate made it for an Environment; an existing bucket must be one Cloudgate did not make`,
    };
  }
  return {
    ok: true,
    lines: [
      `${name}: existing bucket ${bucketName} in ${context.region}; used as given, Cloudgate changes nothing in it — no CORS, versioning or encryption — and makes nothing in it`,
    ],
  };
}
