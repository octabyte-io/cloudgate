import {
  BUCKET_CORS_EXPOSED_HEADERS,
  BUCKET_CORS_METHODS,
} from '../../../buckets/bucket-origins';
import { ref } from '../../definitions/tofu-json';
import type { TofuDefinition } from '../../definitions/tofu-json';
import { markDescription, stateLabels } from './mark';
import { serviceName } from './names';
import { frame } from './tofu-json';

export interface GcpBucketDefinitionInput {
  /** The bucket Service's id: its own service account's name (S4). */
  readonly serviceId: string;
  /**
   * Its real name, minted once by the plan that created it
   * (`googleBucketName`): `cloudgate-<service key>-<8 random>`.
   */
  readonly bucketName: string;
  /** Cloudgate's id of the Cloud account, for the mark. */
  readonly cloudAccountId: string;
  /** The Google Cloud project the Cloud account connects. */
  readonly projectId: string;
  readonly region: string;
  readonly environmentId: string;
  /** The bucket Service's Infrastructure state. */
  readonly stateId: string;
  /**
   * The web origins trusted to upload to it from a browser, in this
   * Environment; empty is none.
   */
  readonly origins: readonly string[];
  /**
   * Only a Delete that asked for its files to go sets it, for that
   * run only: the destroy then empties the bucket before deleting it.
   */
  readonly forceDestroy?: boolean;
  /**
   * Which of its two key slots its state holds; one key in the
   * first slot when absent, as the first buckets made it.
   */
  readonly keys?: GcpBucketKeys;
  /**
   * An **existing bucket** (ADR-0033 as amended): one made
   * outside Cloudgate, named by the operator, in any project. Its state
   * holds only the bucket Service's own service account and its key: the
   * bucket, its settings and the grant on it are the operator's, and
   * nothing here changes them. `origins` and `forceDestroy` are not read.
   */
  readonly existing?: boolean;
}

/**
 * The two places a bucket's HMAC key can be in its state. A Rotate
 * key makes the new key in the slot the live one is not in, so that both are
 * valid while the linking Services are redeployed, and the old one is then
 * destroyed in its slot: the key moves from one slot to the other with each
 * rotation, and its state never holds more than the live key once it ends.
 */
export type GcpBucketKeySlot = 'key' | 'key_b';

/**
 * What a bucket's state holds of its keys: the slot of the live key
 * — the one every Cloud run saves and every linking Service is handed — and
 * whether the other slot holds a key too: a rotation's new key, or one it
 * could not destroy yet.
 */
export interface GcpBucketKeys {
  readonly live: GcpBucketKeySlot;
  readonly spare: boolean;
}

/** The slot a rotation makes its new key in: the one the live key is not in. */
export function otherKeySlot(slot: GcpBucketKeySlot): GcpBucketKeySlot {
  return slot === 'key' ? 'key_b' : 'key';
}

/** The address of the key in `slot`. */
export function gcpBucketKeyAddress(slot: GcpBucketKeySlot): string {
  return `google_storage_hmac_key.${slot}`;
}

/** The address of the bucket itself in its definition. */
export const GCP_BUCKET_ADDRESS = 'google_storage_bucket.bucket';

/** The address of the bucket's own service account, which holds its key. */
export const GCP_BUCKET_ACCOUNT_ADDRESS = 'google_service_account.bucket';

/** The address of the bucket's one HMAC key in its first slot. */
export const GCP_BUCKET_KEY_ADDRESS = 'google_storage_hmac_key.key';

/** The address of the account's `objectUser` binding on the bucket. */
export const GCP_BUCKET_BINDING_ADDRESS =
  'google_storage_bucket_iam_member.object_user';

/** The outputs a bucket's run saves. */
export const GCP_BUCKET_OUTPUTS = {
  name: 'bucket_name',
  /** The HMAC key's access id: the `access_key_id` Output. */
  accessKeyId: 'access_key_id',
  /** The HMAC key's secret: the `secret_access_key` Output. Sensitive. */
  secretAccessKey: 'secret_access_key',
  /** The spare slot's key's access id, while it holds one. */
  spareAccessKeyId: 'spare_access_key_id',
  /** The spare slot's key's secret. Sensitive. */
  spareSecretAccessKey: 'spare_secret_access_key',
} as const;

/**
 * The one role the bucket's own service account holds, on this bucket only
 * (ADR-0032 as amended): read, write, delete and list its objects,
 * multipart uploads included, and nothing of the bucket's own settings.
 */
export const BUCKET_OBJECT_ROLE = 'roles/storage.objectUser';

/**
 * The email of the bucket's own service account, which holds its key: its
 * fixed name in the Environment's project (S4). An existing bucket's
 * grant names it.
 */
export function bucketKeyAccountEmail(
  serviceId: string,
  projectId: string,
): string {
  return `${serviceName(serviceId)}@${projectId}.iam.gserviceaccount.com`;
}

/** How long a browser may keep a CORS preflight's answer. */
const CORS_MAX_AGE_SECONDS = 3600;

/**
 * The OpenTofu definition of a `bucket` on Google Cloud, its own
 * Infrastructure state (the Google Cloud buckets spec "Bucket on Cloud Storage", ADR-0032 as
 * amended). Pure: no Google call, no `tofu`, no database. Nothing
 * in it is a config field: a bucket's entry says only its kind and
 * description.
 *
 * - **The bucket** is made under its real name in the Environment's project
 *   and region. `force_destroy` is off: a destroy never empties it, but
 *   for the one apply before a Delete that asked for its files to go
 *   ({@link GcpBucketDefinitionInput.forceDestroy}).
 * - **Soft delete is off** (retention 0) so a deleted file is gone and
 *   nothing bills after a Delete, as on AWS with versioning off. Versioning
 *   stays off by never being managed, as on AWS.
 * - **Uniform access**: IAM alone decides who reaches it, never an object's
 *   ACL, and **public access prevention** is enforced, as Block Public Access
 *   is on AWS, each written out so a hand change is Drift.
 * - **Cloudgate's labels** are on the bucket, the one kind here that takes
 *   them; its fixed name is its mark beside them (S4, S5).
 * - **Browser uploads**: the trusted origins are the bucket's CORS,
 *   one rule naming them all, with the methods and exposed header the AWS
 *   bucket's rule has; with none trusted there is no rule, so Cloud Storage
 *   allows none, and emptying the list removes it.
 * - **The key**: the S3 SDK cannot use a Cloud Run
 *   service's own identity, so the bucket has a service account of its own,
 *   named by the bucket Service's key as every Google name is, holding
 *   {@link BUCKET_OBJECT_ROLE} on this bucket only, and one HMAC key for that
 *   account, shared by every Service that links the bucket. The linking
 *   Service's own service account gets nothing here: the key is the one way
 *   in. The key's secret is a sensitive output, which no plan line shows.
 * - **Its key slots**: the live key is in one of two slots
 *   ({@link GcpBucketKeys}), and while a Rotate key holds a new key the other
 *   slot holds it too, answered as the spare outputs.
 * - **An existing bucket**: only the service account and its keys,
 *   as above; its name is the output as given.
 */
export function gcpBucketDefinition(
  input: GcpBucketDefinitionInput,
): TofuDefinition {
  const mark = {
    cloudAccountId: input.cloudAccountId,
    environmentId: input.environmentId,
    stateId: input.stateId,
  };
  const bucket = GCP_BUCKET_ADDRESS;
  const account = GCP_BUCKET_ACCOUNT_ADDRESS;
  const keys = input.keys ?? { live: 'key', spare: false };
  const live = gcpBucketKeyAddress(keys.live);
  const spare = gcpBucketKeyAddress(otherKeySlot(keys.live));
  const hmacKey = {
    service_account_email: ref(account, 'email'),
    state: 'ACTIVE',
  };
  const madeBucket = {
    google_storage_bucket: {
      bucket: {
        name: input.bucketName,
        // Cloud Storage keeps a location upper-case.
        location: input.region.toUpperCase(),
        force_destroy: input.forceDestroy === true,
        uniform_bucket_level_access: true,
        public_access_prevention: 'enforced',
        soft_delete_policy: [{ retention_duration_seconds: 0 }],
        labels: stateLabels(mark),
        ...(input.origins.length > 0
          ? {
              cors: [
                {
                  origin: [...input.origins],
                  method: [...BUCKET_CORS_METHODS],
                  response_header: [
                    'Content-Type',
                    ...BUCKET_CORS_EXPOSED_HEADERS,
                  ],
                  max_age_seconds: CORS_MAX_AGE_SECONDS,
                },
              ],
            }
          : {}),
      },
    },
    google_storage_bucket_iam_member: {
      object_user: {
        bucket: ref(bucket, 'name'),
        role: BUCKET_OBJECT_ROLE,
        member: ref(account, 'member'),
      },
    },
  };
  const resource = {
    // An existing bucket's state holds no bucket and no grant.
    ...(input.existing ? {} : madeBucket),
    google_service_account: {
      bucket: {
        account_id: serviceName(input.serviceId),
        description: markDescription(mark),
      },
    },
    google_storage_hmac_key: {
      [keys.live]: hmacKey,
      ...(keys.spare ? { [otherKeySlot(keys.live)]: hmacKey } : {}),
    },
  };
  return {
    ...frame(input.projectId, input.region),
    resource,
    output: {
      [GCP_BUCKET_OUTPUTS.name]: {
        value: input.existing ? input.bucketName : ref(bucket, 'name'),
      },
      [GCP_BUCKET_OUTPUTS.accessKeyId]: { value: ref(live, 'access_id') },
      [GCP_BUCKET_OUTPUTS.secretAccessKey]: {
        value: ref(live, 'secret'),
        sensitive: true,
      },
      ...(keys.spare
        ? {
            [GCP_BUCKET_OUTPUTS.spareAccessKeyId]: {
              value: ref(spare, 'access_id'),
            },
            [GCP_BUCKET_OUTPUTS.spareSecretAccessKey]: {
              value: ref(spare, 'secret'),
              sensitive: true,
            },
          }
        : {}),
    },
  };
}
