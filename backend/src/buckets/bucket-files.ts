import type { BucketContents } from '../object-storage/object-storage.port';

/**
 * What a bucket's Delete found in it, as the Plan's destroy row
 * shows it: *holds files*, *empty* or *can't tell* (`unknown`). `unknown`
 * counts as `holds-files` everywhere.
 */
export type BucketFiles = BucketContents;

/**
 * Why a bucket was kept: it holds files, it could not be read, or it was
 * asked to be emptied and the emptying stopped partway.
 */
export type BucketKeptBecause = 'holds-files' | 'unknown' | 'partly-emptied';

/**
 * A bucket a Delete kept and named once, as left behind, before Cloudgate
 * forgot it: on a Server its volume ({@link ServerBucketLeftBehind}),
 * on AWS the S3 bucket itself ({@link CloudBucketKept}).
 */
export type BucketLeftBehind = ServerBucketLeftBehind | CloudBucketKept;

/**
 * A bucket on a Server a Delete kept: its volume. The Garage
 * container is gone and the files are on that volume.
 */
export interface ServerBucketLeftBehind {
  /** The bucket's real name. */
  readonly bucketName: string;
  /** Its volume on its run Server. */
  readonly volumeName: string;
  readonly serverId: string | null;
  readonly because: BucketKeptBecause;
}

/**
 * An S3 bucket a cloud Delete kept on purpose (ADR-0038's *Kept*): it
 * holds files, or could not be read. It keeps Cloudgate's tag, and its row
 * and Infrastructure state are gone. One whose emptying stopped partway is
 * not kept but *left* (`Leftover.because`), which keeps the row.
 *
 * On Google Cloud it is a Cloud Storage bucket, named with its
 * project rather than an AWS account; it keeps Cloudgate's labels, and its
 * HMAC key and service account are destroyed all the same.
 */
export interface CloudBucketKept {
  /** The bucket's real name. */
  readonly bucketName: string;
  readonly because: 'holds-files' | 'unknown';
  /**
   * Where it stays: its Cloud account, that account's AWS id or Google
   * Cloud project, and its region.
   */
  readonly cloud: {
    readonly cloudAccountId: string;
    readonly cloudAccountName: string;
    readonly region: string;
  } & ({ readonly awsAccountId: string } | { readonly projectId: string });
}

/** A bucket is deleted only when it is known to be empty. */
export const keepsFiles = (files: BucketFiles): boolean => files !== 'empty';

/** An existing bucket its Delete left as it was. */
export interface BucketLeftAsItWas {
  readonly bucketName: string;
  readonly message: string;
  /**
   * On Google Cloud (ADR-0033 as amended): the grant the
   * operator added on the bucket for its key's service account, left with
   * it, and the exact line that removes it. Absent on AWS, and when no key
   * was ever made.
   */
  readonly grantLeft?: {
    readonly serviceAccount: string;
    readonly command: string;
  };
}

/**
 * What an existing bucket's Delete says (ADR-0033): Cloudgate removed only
 * its own records, and the bucket and its files are the operator's. A
 * config that still lists the entry makes it a new bucket at the next plan,
 * which the sentence says too, so a Delete is never mistaken for a switch.
 */
export function leftAsItWas(
  bucketName: string,
  configName: string,
  grantLeft?: BucketLeftAsItWas['grantLeft'],
): BucketLeftAsItWas {
  if (grantLeft) {
    return {
      bucketName,
      message: `${bucketName} was left as it was, files and all; it is yours. Cloudgate destroys only the HMAC key and service account it made for ${configName}. The grant you added on ${bucketName} is left too, naming ${grantLeft.serviceAccount}, which gives nobody access once it is gone; remove it with \`${grantLeft.command}\`. If the Project config still lists ${configName}, the next plan creates it as a new, empty bucket.`,
      grantLeft,
    };
  }
  return {
    bucketName,
    message: `${bucketName} was left as it was, files and all; it is yours. Cloudgate removed only its own records of ${configName}; if the Project config still lists ${configName}, the next plan creates it as a new, empty bucket.`,
  };
}
