import type { TofuShow } from '../../../src/cloud-accounts/cloud.port';

/**
 * Where moto answers differently from AWS for a field these definitions set,
 * found by running the lane. Each is closed in every plan the lane
 * reads, before it asserts anything or saves a plan file, by giving the
 * refreshed value the one the definition wrote — which is what AWS returns.
 * A gap not listed here fails the key property ("no changes"), as it should.
 *
 * A gap with `asAws` is closed instead by reading moto's refreshed value as
 * AWS would have answered it, so a change the definition really plans to
 * that field is still a change (a Domain's certificate put on a
 * distribution).
 *
 * A gap with `known` names the attributes of a block's elements that moto's
 * answer left "known after apply" in the plan: where an element is the
 * same once closed but for those, AWS would have planned none of it, so
 * each takes its refreshed value and is no longer unknown.
 */
export const MOTO_GAPS: readonly {
  readonly type: string;
  readonly field: string;
  readonly why: string;
  readonly asAws?: (refreshed: unknown, written: unknown) => unknown;
  readonly known?: readonly string[];
}[] = [
  {
    type: 'aws_ecs_service',
    field: 'enable_ecs_managed_tags',
    why: 'moto 5.2.3 does not keep EnableECSManagedTags: DescribeServices never returns it, so the provider reads false after creating it true',
  },
  // The provider reads a bucket's tags back through S3 Control's
  // ListTagsForResource, which moto 5.2.3 answers from a store of its own
  // that PutBucketTagging never fills, so a bucket reads untagged.
  {
    type: 'aws_s3_bucket',
    field: 'tags',
    why: "moto 5.2.3's S3 Control ListTagsForResource does not see the tags PutBucketTagging set",
  },
  {
    type: 'aws_s3_bucket',
    field: 'tags_all',
    why: "moto 5.2.3's S3 Control ListTagsForResource does not see the tags PutBucketTagging set",
  },
  // A Compose stack's Stack VM (ADR-0070, #1359).
  {
    type: 'aws_instance',
    field: 'maintenance_options',
    why: "moto 5.2.3 keeps no instance's maintenance options, so the provider reads auto_recovery back as moto's own value rather than the default the definition wrote, and an apply that writes them waits forever (#1368): every apply after stack-vm-create.json leaves them out (stack-vm-lane.moto-spec.ts, asMotoMakesIt)",
  },
  // A `static` site's distribution.
  {
    type: 'aws_cloudfront_distribution',
    field: 'default_cache_behavior',
    why: 'moto 5.2.3 answers a cache behaviour that names a cache policy with a default ForwardedValues as well, which AWS never returns beside a cache policy',
  },
  {
    type: 'aws_cloudfront_distribution',
    field: 'viewer_certificate',
    why: "moto 5.2.3 answers SSLSupportMethod sni-only for CloudFront's own certificate, which AWS leaves unset; and CloudFrontDefaultCertificate true beside an ACM certificate, where AWS answers false",
    // Closed by the written value only while both name the same kind of
    // certificate: a Domain's certificate put on, or taken off, the
    // distribution stays the change it is, read as AWS answers it.
    asAws: (refreshed, written) =>
      acmCertificate(refreshed) === acmCertificate(written)
        ? written
        : (refreshed as Record<string, unknown>[]).map((one) =>
            one?.acm_certificate_arn
              ? { ...one, cloudfront_default_certificate: false }
              : { ...one, ssl_support_method: null },
          ),
  },
  {
    type: 'aws_cloudfront_distribution',
    field: 'origin',
    why: "moto 5.2.3 keeps no origin's OriginAccessControlId (it reads back empty), so the provider plans the origin anew, its ResponseCompletionTimeout known after apply; a hand change to an origin's OAC therefore cannot be shown on moto, and the lane changes its bucket instead",
    // Only the OAC is closed, so the origin's bucket and path stay what moto
    // read: a deploy's switch, or a hand change to either, is still a change.
    asAws: (refreshed, written) =>
      (refreshed as Record<string, unknown>[]).map((one, at) => ({
        ...one,
        origin_access_control_id:
          one.origin_access_control_id === ''
            ? ((written as Record<string, unknown>[] | undefined) ?? [])[at]
                ?.origin_access_control_id
            : one.origin_access_control_id,
      })),
    known: ['response_completion_timeout'],
  },
];

/** The ACM certificate a distribution's `viewer_certificate` names, or `''` for CloudFront's own. */
function acmCertificate(value: unknown): string {
  const [one] = Array.isArray(value)
    ? (value as Record<string, unknown>[])
    : [];
  return typeof one?.acm_certificate_arn === 'string'
    ? one.acm_certificate_arn
    : '';
}

/**
 * What moto 5.2.3 has no API for, so the lane never runs it and the stored
 * plan files that would need it stay hand-shaped. Not closed in any
 * plan: each is a step the lane leaves out, and the walk by hand
 * (`docs/aws-walk-by-hand.md`) is its only proof. Re-check on a moto bump.
 */
export const MOTO_MISSING: readonly {
  readonly what: string;
  readonly leavesOut: readonly string[];
}[] = [
  {
    what: 'ElastiCache cache parameter groups (CreateCacheParameterGroup and the rest) and ModifyReplicationGroup',
    leavesOut: [
      'applying a redis: its definition makes a parameter group (noeviction), so redis-create.json is a plan against an empty state, never followed by an apply',
      'redis-resize.json, redis-replica-on.json and redis-major-upgrade.json, which plan against a made replication group',
    ],
  },
  {
    what: 'ElastiCache serverless caches',
    leavesOut: [
      "existing-redis-serverless.json, the existing redis lookup's second look, which finds a serverless cache by that name",
    ],
  },
  {
    what: "a replication group as the provider reads it: moto makes no member cluster, and the AWS provider 6.69.1's aws_elasticache_replication_group data source fails on moto's DescribeReplicationGroups answer (a nil pointer, replication_group_data_source.go:211)",
    leavesOut: [
      'existing-redis-lookup.json, an existing redis found; only its not-found failure is run',
    ],
  },
  // An existing bucket's lookup found.
  {
    what: "ListBuckets as the AWS provider 6.69.1 reads it: moto 5.2.3 answers no BucketArn, so aws_s3_buckets gives each bucket a null bucket_arn and the lookup's resource_arn_list fails the plan",
    leavesOut: [
      'existing-bucket-lookup.json and the found look: the file is recorded from a real account (the walk by hand, 5e) and the walk is the only proof; the missing look, whose search is null, is run (bucket-lane.moto-spec.ts)',
    ],
  },
  // A `static` site's viewer-request function.
  {
    what: 'CloudFront Functions (CreateFunction answers 404)',
    leavesOut: [
      "applying a static site's aws_cloudfront_function.site and its association: static-create.json is the whole plan, but every apply after it leaves both out (static-lane.moto-spec.ts, withoutFunction)",
    ],
  },
  // The cloud port's CloudFront status reads.
  {
    what: "a finished invalidation in AWS's words: moto 5.2.3 answers Status COMPLETED where AWS answers Completed",
    leavesOut: [
      "the real adapter reading an invalidation Completed: s3-object-storage.moto-spec.ts proves the call and reads moto's answer as InProgress",
    ],
  },
  // A Compose stack's Stack VM (ADR-0070, #1359).
  {
    what: 'Data Lifecycle Manager as the AWS provider 6.69.1 makes a policy: against moto 5.2.3 its aws_dlm_lifecycle_policy create never finishes (still creating after 15 minutes)',
    leavesOut: [
      "applying a Stack VM's aws_dlm_lifecycle_policy.snapshots: stack-vm-create.json is the whole plan, but every apply after it leaves the policy out (stack-vm-lane.moto-spec.ts, asMotoMakesIt); that a snapshot is taken daily and 7 are kept is the walk by hand's",
    ],
  },
  {
    what: 'an instance with no public address: moto 5.2.3 gives every instance one whatever RunInstances asked, so the AWS provider reads associate_public_ip_address true, and that argument forces a replace no closed gap can undo',
    leavesOut: [
      "a Stack VM's associate_public_ip_address false on every apply after stack-vm-create.json (stack-vm-lane.moto-spec.ts, asMotoMakesIt): its private subnet has no route from the internet either way, and that it gets no public address is the walk by hand's",
    ],
  },
  {
    what: "Canonical's Ubuntu AMIs (owner 099720109477, ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*): moto 5.2.3 holds none of them",
    leavesOut: [
      "a Stack VM's first plan and an approved replace, which look up the pinned Ubuntu 24.04 build by its name (#1368): the lane plans with an image moto has, as a Stack VM whose image is recorded does, and replaces it on that image",
    ],
  },
  {
    what: 'a Stack VM running: moto boots nothing, so cloud-init, Docker, the data disk mount, Session Manager and EC2 auto-recovery never run',
    leavesOut: ["everything a Stack VM does once made: the walk by hand's"],
  },
  {
    what: "RDS's real minor versions: moto reports the version it was asked for",
    leavesOut: [
      'a running version such as 17.4 under an instance made with "17": postgres-major-upgrade.json reads 17 → 18',
    ],
  },
];

interface Change {
  address: string;
  type: string;
  change: {
    actions: string[];
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    after_unknown?: Record<string, unknown>;
  };
}

interface StateResource {
  address: string;
  type: string;
  values?: Record<string, unknown>;
}

/** Equal values, whatever order their keys were written in. */
const same = (a: unknown, b: unknown) =>
  JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** The plan as AWS would have printed it, every {@link MOTO_GAPS} closed. */
export function closeMotoGaps(show: TofuShow): TofuShow {
  const plan = structuredClone(show) as TofuShow & {
    resource_changes?: Change[];
    resource_drift?: Change[];
    prior_state?: {
      values?: { root_module?: { resources?: StateResource[] } };
    };
  };
  /** Per address, each gap's field as AWS would have answered it. */
  const planned = new Map<string, Record<string, (moto: unknown) => unknown>>();

  for (const change of plan.resource_changes ?? []) {
    const { before, after, actions } = change.change;
    if (!before || !after) continue;
    for (const gap of MOTO_GAPS) {
      if (gap.type !== change.type || !(gap.field in after)) continue;
      const written = after[gap.field];
      const asAws = (moto: unknown) =>
        gap.asAws ? gap.asAws(moto, written) : written;
      before[gap.field] = asAws(before[gap.field]);
      if (gap.known) {
        knownAsAws(before[gap.field], written, change.change, gap);
      }
      const fields = planned.get(change.address) ?? {};
      fields[gap.field] = asAws;
      planned.set(change.address, fields);
    }
    if (actions.join() === 'update' && same(before, after)) {
      change.change.actions = ['no-op'];
    }
  }

  plan.resource_drift = (plan.resource_drift ?? []).filter((drift) => {
    const fields = planned.get(drift.address);
    const { before, after } = drift.change;
    if (!fields || !before || !after) return true;
    closeFields(before, fields);
    closeFields(after, fields);
    return !same(before, after);
  });

  for (const resource of plan.prior_state?.values?.root_module?.resources ??
    []) {
    const fields = planned.get(resource.address);
    if (fields && resource.values) closeFields(resource.values, fields);
  }
  return plan;
}

/**
 * Each element of a gap's block that is the same before and after but for
 * its `known` attributes: those take their refreshed value and are no
 * longer unknown, as AWS's plan of an unchanged element has them.
 */
function knownAsAws(
  before: unknown,
  after: unknown,
  change: Change['change'],
  gap: { readonly field: string; readonly known?: readonly string[] },
) {
  const known = gap.known ?? [];
  const unknown = change.after_unknown?.[gap.field];
  if (!Array.isArray(before) || !Array.isArray(after)) return;
  if (!Array.isArray(unknown)) return;
  const without = (one: unknown) =>
    Object.fromEntries(
      Object.entries((one ?? {}) as Record<string, unknown>).filter(
        ([key]) => !known.includes(key),
      ),
    );
  after.forEach((element: Record<string, unknown>, at) => {
    const flags = unknown[at] as Record<string, unknown> | undefined;
    if (!flags || !same(without(before[at]), without(element))) return;
    for (const key of known) {
      if (flags[key] !== true) continue;
      element[key] = (before[at] as Record<string, unknown>)[key];
      delete flags[key];
    }
  });
}

function closeFields(
  values: Record<string, unknown>,
  fields: Record<string, (moto: unknown) => unknown>,
) {
  for (const [field, asAws] of Object.entries(fields)) {
    values[field] = asAws(values[field]);
  }
}
