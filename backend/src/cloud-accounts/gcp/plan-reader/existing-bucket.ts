import type { StorageBucketRead } from '../../google-cloud.port';
import { BUCKET_OBJECT_ROLE } from '../definitions/bucket-definition';
import { LABEL_KEYS } from '../definitions/mark';

/**
 * An **existing bucket** on Google Cloud (the Google Cloud buckets spec "Existing bucket on
 * Google Cloud"; ADR-0033 as amended): how each plan's lookup of
 * the Cloud Storage bucket is judged, and the `gcloud` lines the operator
 * is shown. Pure: the bucket is read through the Google client port by the
 * caller. Cloudgate never changes the bucket and never adds a grant on it.
 */

/**
 * A Cloud Storage bucket name as Google takes one: lowercase letters,
 * digits, `-`, `_` and `.`, starting and ending with a letter or digit, 3 to
 * 63 characters, or up to 222 when dotted with no part over 63.
 */
export function isGoogleBucketName(name: string): boolean {
  if (!/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(name)) return false;
  if (name.length < 3) return false;
  if (!name.includes('.')) return name.length <= 63;
  return (
    name.length <= 222 && name.split('.').every((part) => part.length <= 63)
  );
}

/** What Cloud Storage answered for the bucket. */
export type GoogleBucketLookup =
  | { readonly kind: 'found'; readonly bucket: StorageBucketRead }
  /** `NOT_FOUND`: there is no such bucket. */
  | { readonly kind: 'missing' }
  /** `PERMISSION_DENIED`: Cloudgate's service account may not read it. */
  | { readonly kind: 'unreadable'; readonly message: string };

/** What a lookup is judged against: the Service and the Environment's place. */
export interface ExistingGoogleBucketContext {
  readonly serviceName: string;
  /** As the operator gave it. */
  readonly bucketName: string;
  /** The Environment's own project, where the bucket's key account is made. */
  readonly project: {
    readonly projectId: string;
    readonly projectNumber: string;
  };
  /** The Environment's region. */
  readonly region: string;
  /** The deploy service account's email, which the read grant names. */
  readonly serviceAccount: string;
}

export type ExistingGoogleBucketVerdict =
  | { readonly ok: false; readonly reason: string }
  | {
      readonly ok: true;
      /** It is in another project than the Environment's. */
      readonly elsewhere: boolean;
      /** The plan's lines for it, the location note included. */
      readonly lines: string[];
    };

/**
 * The grant an existing bucket in another project needs before every plan
 * can look it up: `roles/storage.legacyBucketReader` on the bucket
 * for Cloudgate's deploy service account, which reads the bucket's settings
 * and lists its objects but reads none of them.
 */
export function bucketReadGrant(
  bucketName: string,
  serviceAccount: string,
): string {
  return `gcloud storage buckets add-iam-policy-binding gs://${bucketName} --member=serviceAccount:${serviceAccount} --role=roles/storage.legacyBucketReader`;
}

/**
 * The grant the operator adds once the Apply made the bucket's key:
 * {@link BUCKET_OBJECT_ROLE} on the bucket for the key's own service
 * account, the role a Cloudgate-made bucket's account holds.
 */
export function bucketAccessGrant(
  bucketName: string,
  keyAccount: string,
): string {
  return `gcloud storage buckets add-iam-policy-binding gs://${bucketName} --member=serviceAccount:${keyAccount} --role=${BUCKET_OBJECT_ROLE}`;
}

/**
 * The same grant taken off again, which a Delete's report names.
 * The report comes after the Delete removed the key's account, and Google
 * then lists the member as `deleted:serviceAccount:<email>?uid=<n>`, which
 * only that name removes and whose uid Cloudgate never kept. So the
 * line reads the member from the bucket's policy and removes it by the name
 * Google gives, deleted or not; with no such member it does nothing.
 */
export function bucketAccessRevoke(
  bucketName: string,
  keyAccount: string,
): string {
  return `gcloud storage buckets get-iam-policy gs://${bucketName} --flatten='bindings[].members' --format='value(bindings.members)' | grep -F 'serviceAccount:${keyAccount}' | sort -u | xargs -r -I{} gcloud storage buckets remove-iam-policy-binding gs://${bucketName} --member={} --role=${BUCKET_OBJECT_ROLE} --format=none`;
}

/**
 * Cloud Storage's predefined dual-regions and the two regions each holds,
 * from Google's bucket-locations page. A configurable dual-region names its
 * own in `dataLocations`.
 */
const PREDEFINED_DUAL_REGIONS: Readonly<Record<string, readonly string[]>> = {
  ASIA1: ['asia-northeast1', 'asia-northeast2'],
  EUR4: ['europe-north1', 'europe-west4'],
  EUR5: ['europe-west1', 'europe-west2'],
  EUR7: ['europe-west2', 'europe-west3'],
  EUR8: ['europe-west3', 'europe-west6'],
  NAM4: ['us-central1', 'us-east1'],
};

/**
 * The regions a multi-region's data centers are in, by region name: the
 * `EU` one is in member states of the European Union only, so London and
 * Zurich are outside it.
 */
const MULTI_REGIONS: Readonly<Record<string, (region: string) => boolean>> = {
  US: (region) => region.startsWith('us-'),
  EU: (region) =>
    region.startsWith('europe-') &&
    region !== 'europe-west2' &&
    region !== 'europe-west6',
  ASIA: (region) => region.startsWith('asia-'),
};

/**
 * Whether a bucket's location holds the Environment's region, so
 * its linked Services reach it within one location: a region that is it, a
 * dual-region that names it, or a multi-region whose data centers it is
 * among. Anything else is a plan note, never a refusal.
 */
export function locationHoldsRegion(
  bucket: Pick<
    StorageBucketRead,
    'location' | 'locationType' | 'dataLocations'
  >,
  region: string,
): boolean {
  const location = bucket.location.toUpperCase();
  const wanted = region.toLowerCase();
  if (bucket.locationType === 'dual-region') {
    const regions =
      bucket.dataLocations.length > 0
        ? bucket.dataLocations.map((one) => one.toLowerCase())
        : (PREDEFINED_DUAL_REGIONS[location] ?? []);
    return regions.includes(wanted);
  }
  if (bucket.locationType === 'multi-region') {
    return MULTI_REGIONS[location]?.(wanted) ?? false;
  }
  return location.toLowerCase() === wanted;
}

/**
 * Whether an existing bucket can be used as given (ADR-0033 as amended), each
 * refusal naming its fix:
 *
 * - not found (its name to check);
 * - not readable, with the `legacyBucketReader` grant a bucket in another
 *   project needs;
 * - requester pays on, since the S3 SDK cannot name a project to bill, with
 *   the command that turns it off;
 * - Cloudgate's own labels: one Cloudgate made, for this or another
 *   Environment.
 *
 * Any project and any location are taken; a location that does not hold the
 * Environment's region is a note (slower, and charged between regions).
 */
export function judgeExistingGoogleBucket(
  lookup: GoogleBucketLookup,
  context: ExistingGoogleBucketContext,
): ExistingGoogleBucketVerdict {
  const { serviceName: name, bucketName } = context;
  const uses = `${name} uses the existing bucket ${bucketName}`;
  if (lookup.kind === 'missing') {
    return {
      ok: false,
      reason: `${uses}, but Google Cloud cannot find it. Check its name on ${name}'s page`,
    };
  }
  if (lookup.kind === 'unreadable') {
    return {
      ok: false,
      reason: `${uses}, but Cloudgate may not read it (${lookup.message}). A bucket in another project needs Cloudgate's service account to read it, so that every plan can look it up: \`${bucketReadGrant(bucketName, context.serviceAccount)}\``,
    };
  }
  const { bucket } = lookup;
  if (bucket.requesterPays) {
    return {
      ok: false,
      reason: `${uses}, but it has requester pays on, and the S3 SDK its linked Services use cannot name a project to bill. Turn it off: \`gcloud storage buckets update gs://${bucketName} --no-requester-pays\``,
    };
  }
  const ours = Object.keys(bucket.labels)
    .filter((key) => (Object.values(LABEL_KEYS) as string[]).includes(key))
    .sort();
  if (ours.length > 0) {
    return {
      ok: false,
      reason: `${uses}, but it carries Cloudgate's labels (${ours.join(', ')}), so Cloudgate made it for an Environment; an existing bucket must be one Cloudgate did not make`,
    };
  }
  const elsewhere = bucket.projectNumber !== context.project.projectNumber;
  const lines = [
    `${name}: existing bucket ${bucketName} in ${bucket.location}${elsewhere ? ', in another project' : ''}, used as given: Cloudgate changes nothing in it and makes only its own service account and HMAC key for it, $0/month`,
  ];
  if (!locationHoldsRegion(bucket, context.region)) {
    lines.push(
      `${name}: ${bucketName} is in ${bucket.location}, which does not hold this Environment's region ${context.region}: its linked Services reach it across regions, which is slower and charged between regions`,
    );
  }
  return { ok: true, elsewhere, lines };
}
