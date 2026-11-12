import { eq } from 'drizzle-orm';

import { CLOUD_STORAGE_S3 } from '../cloud-accounts/gcp/cloud-storage-s3';
import { bucketKeyAccountEmail } from '../cloud-accounts/gcp/definitions/bucket-definition';
import {
  bucketAccessGrant,
  bucketAccessRevoke,
} from '../cloud-accounts/gcp/plan-reader/existing-bucket';
import type { DrizzleDB } from '../db/drizzle.module';
import type { ObjectStoragePort } from '../object-storage/object-storage.port';
import { bucket } from './bucket.schema';
import type { Bucket, GoogleBucketAccess } from './bucket.schema';

/**
 * An **existing bucket** on Google Cloud's access (ADR-0033 as
 * amended): the operator grants the bucket's own service account
 * `roles/storage.objectUser` on it, and Cloudgate checks it by a list of one
 * file made with the bucket's key, never by a tick: through the
 * object-storage port, at Cloud Storage's S3-compatible API, as a linked
 * Service's S3 SDK reaches it. Nothing waits on it and
 * nothing is refused for it: plans go on, and linked Services deploy at once.
 */

/** The columns the check reads. */
type Checked = Pick<
  Bucket,
  | 'bucketId'
  | 'bucketName'
  | 'accessKeyId'
  | 'secretAccessKey'
  | 'googleAccess'
  | 'existing'
>;

/**
 * Checks the access and keeps it for the page: `ok` once the list answers,
 * else `waiting` until it first has, and `no-access` after that. A bucket
 * with no key yet (before its Apply's run) is not checked, and a check
 * Google does not answer leaves the last one as it was. Answers the status
 * now, `null` for a bucket that has none.
 */
export async function checkGoogleBucketAccess(
  db: DrizzleDB,
  objectStorage: ObjectStoragePort,
  row: Checked & Pick<Bucket, 'googleAccessCheckedAt'>,
): Promise<GoogleBucketAccess | null> {
  return (await recheckGoogleBucketAccess(db, objectStorage, row)).googleAccess;
}

/**
 * {@link checkGoogleBucketAccess}, answering the two columns as it left
 * them, so a page read shows the check without reading the bucket again.
 */
export async function recheckGoogleBucketAccess(
  db: DrizzleDB,
  objectStorage: ObjectStoragePort,
  row: Checked & Pick<Bucket, 'googleAccessCheckedAt'>,
): Promise<Pick<Bucket, 'googleAccess' | 'googleAccessCheckedAt'>> {
  const before = {
    googleAccess: row.googleAccess,
    googleAccessCheckedAt: row.googleAccessCheckedAt,
  };
  if (!row.existing || !row.accessKeyId || !row.secretAccessKey) {
    return before;
  }
  const access = await objectStorage.access({
    endpoint: CLOUD_STORAGE_S3.endpoint,
    region: CLOUD_STORAGE_S3.region,
    bucket: row.bucketName,
    credential: {
      accessKeyId: row.accessKeyId,
      secretAccessKey: row.secretAccessKey,
    },
    pathStyle: true,
  });
  if (access === 'unknown') return before;
  const reached = access === 'ok';
  const status: GoogleBucketAccess = reached
    ? 'ok'
    : row.googleAccess === 'ok' || row.googleAccess === 'no-access'
      ? 'no-access'
      : 'waiting';
  const checked = {
    googleAccess: status,
    googleAccessCheckedAt: new Date().toISOString(),
  };
  await db.update(bucket).set(checked).where(eq(bucket.bucketId, row.bucketId));
  return checked;
}

/** An existing bucket's access as its page shows it. */
export interface GoogleAccessView {
  readonly status: GoogleBucketAccess;
  readonly checkedAt: string | null;
  /** The bucket's own service account, which holds its key. */
  readonly serviceAccount: string;
  /** The exact `add-iam-policy-binding` line that grants it. */
  readonly grant: string;
  /** What the page says while the key has no access; `null` once it has. */
  readonly sentence: string | null;
}

/** The view of a checked existing bucket's access, or `null` before its first check. */
export function googleAccessView(
  row: Pick<
    Bucket,
    | 'bucketId'
    | 'bucketName'
    | 'configName'
    | 'googleAccess'
    | 'googleAccessCheckedAt'
  >,
  projectId: string,
): GoogleAccessView | null {
  if (!row.googleAccess) return null;
  const serviceAccount = bucketKeyAccountEmail(row.bucketId, projectId);
  const grant = bucketAccessGrant(row.bucketName, serviceAccount);
  return {
    status: row.googleAccess,
    checkedAt: row.googleAccessCheckedAt,
    serviceAccount,
    grant,
    sentence: accessSentence(row.googleAccess, row, grant),
  };
}

/** What the page and the Apply's log say of the access. */
export function accessSentence(
  status: GoogleBucketAccess,
  row: Pick<Bucket, 'bucketName' | 'configName'>,
  grant: string,
): string | null {
  switch (status) {
    case 'ok':
      return null;
    case 'waiting':
      return `Waiting for access: ${row.bucketName} does not let ${row.configName}'s key in yet. Grant it on the bucket, then reload this page: \`${grant}\``;
    case 'no-access':
      return `No access: ${row.configName}'s key can no longer list ${row.bucketName}, so the Services linking it cannot reach its files. Grant it again: \`${grant}\``;
  }
}

/**
 * The grant an existing bucket's Delete leaves: the operator's, on
 * their bucket, now naming a service account that is gone and so gives
 * nobody access; the report names the exact line that removes it.
 */
export function leftGrantOf(
  row: Pick<Bucket, 'bucketId' | 'bucketName'>,
  projectId: string,
): { readonly serviceAccount: string; readonly command: string } {
  const serviceAccount = bucketKeyAccountEmail(row.bucketId, projectId);
  return {
    serviceAccount,
    command: bucketAccessRevoke(row.bucketName, serviceAccount),
  };
}
