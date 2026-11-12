import type { Logger } from '@nestjs/common';

import type {
  KeptResource,
  Leftover,
} from '../cloud-accounts/aws/delete-check';
import type { GcpCloudAccount } from '../cloud-accounts/cloud-provider';
import type { TofuFailure, TofuShow } from '../cloud-accounts/cloud.port';
import { GOOGLE_STORAGE_BUCKET_TYPE } from '../cloud-accounts/gcp/delete-check';
import { LABEL_KEYS } from '../cloud-accounts/gcp/definitions/mark';
import { idKey, serviceName } from '../cloud-accounts/gcp/definitions/names';
import { NOT_FOUND } from '../cloud-accounts/google-cloud.port';
import type {
  GoogleAccessToken,
  GoogleCloudPort,
} from '../cloud-accounts/google-cloud.port';
import { describeError } from '../common/describe-error';
import type { BucketContents } from '../object-storage/object-storage.port';
import type { CloudBucketKept } from './bucket-files';
import type { Bucket } from './bucket.schema';

// The steps of a bucket on Google Cloud's Delete (spec "Bucket
// on Cloud Storage") that are not the run's bookkeeping: whether it holds
// files, read by a one-result list through the Google client port, and what
// a kept or left Cloud Storage bucket is named as. `CloudBucketDeletes` holds
// the run and the row, beside the AWS half's `cloud-bucket-delete-steps.ts`.

/** Google's own name for a Cloud Storage bucket's kind, as a report names it. */
export const GOOGLE_BUCKET_TYPE = GOOGLE_STORAGE_BUCKET_TYPE;

/** What a kept Cloud Storage bucket costs, as the report names it. */
const KEPT_COST =
  'Cloud Storage for the files it holds, billed until you empty or delete it in Google Cloud';

/**
 * Whether it holds files: Cloud Storage's list of its objects, old versions
 * included, asking for one. A bucket Google does not have holds none, so
 * there is nothing to lose; any other refusal, or no answer, is `unknown`.
 * Never throws.
 */
export async function googleBucketContents(
  google: GoogleCloudPort,
  logger: Logger,
  found: Bucket,
  token: GoogleAccessToken,
): Promise<BucketContents> {
  try {
    const answer = await google.listObjects(token, {
      bucket: found.bucketName,
      maxResults: 1,
      versions: true,
    });
    if (answer.ok) return answer.value.length > 0 ? 'holds-files' : 'empty';
    if (answer.code === NOT_FOUND) return 'empty';
    logger.warn(
      `${found.appName}: Cloudgate could not tell whether ${found.bucketName} holds files — Google answered ${answer.code}: ${answer.message}`,
    );
    return 'unknown';
  } catch (error) {
    logger.warn(
      `${found.appName}: Cloudgate could not tell whether ${found.bucketName} holds files — ${describeError(error)}`,
    );
    return 'unknown';
  }
}

/** A kept Cloud Storage bucket as the Delete's answer names it: with its project and region. */
export function googleKeptOf(
  found: Bucket,
  account: GcpCloudAccount,
  region: string,
  files: 'holds-files' | 'unknown',
): CloudBucketKept {
  return {
    bucketName: found.bucketName,
    because: files,
    cloud: {
      cloudAccountId: account.cloudAccountId,
      cloudAccountName: account.name,
      projectId: account.cloudId,
      region,
    },
  };
}

/** A kept Cloud Storage bucket as the report's *Kept* list names it. */
export function googleKeptResource(
  found: Bucket,
  account: GcpCloudAccount,
  region: string,
): KeptResource {
  return {
    type: GOOGLE_BUCKET_TYPE,
    awsId: found.bucketName,
    projectId: account.cloudId,
    region,
    cost: KEPT_COST,
  };
}

/** A Cloud Storage bucket whose emptying stopped partway, *left* with its state's label. */
export function googlePartlyEmptied(
  found: Bucket,
  region: string,
  state: { readonly infrastructureStateId: string },
): Leftover {
  return {
    type: GOOGLE_BUCKET_TYPE,
    awsId: found.bucketName,
    region,
    tag: `${LABEL_KEYS.state}=${idKey(state.infrastructureStateId)}`,
    because: 'partly-emptied',
  };
}

/** The bucket's own service account, by its fixed name (S4). */
export function bucketAccountName(found: Bucket): string {
  return serviceName(found.bucketId);
}

/** Every action a plan takes on one address. */
export function changesAt(show: TofuShow, address: string): string[] {
  const changes = (show.resource_changes ?? []) as {
    address?: string;
    change?: { actions?: string[] };
  }[];
  return changes
    .filter((one) => one.address === address)
    .flatMap((one) => one.change?.actions ?? []);
}

/** Said by the apply before the emptying when the state holds no bucket to empty. */
export const NO_BUCKET_TO_EMPTY: TofuFailure = {
  ok: false,
  reason: 'failed',
  message: 'The state holds no bucket to empty.',
};
