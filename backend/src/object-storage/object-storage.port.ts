/**
 * The **object-storage port** (the spec's "One new port"): the one seam
 * through which Cloudgate speaks the S3 protocol to a bucket outside a Plan.
 * It speaks it to Garage on a Server and to S3 on AWS alike, so everything
 * it needs to reach a bucket — where, which, and with what credential — is
 * the caller's to hand it in an {@link ObjectStorageTarget}; nothing here
 * looks a credential or an address up.
 *
 * Its only implementation, `S3ObjectStorage`, runs on the platform host
 * — a credential handed to it never reaches a Server. Every
 * e2e spec replaces the whole token with an in-memory fake
 * (`test/utils/fake-object-storage.ts`, `ctx.objectStorage`), and the real
 * adapter is checked only in the release lane, against moto and a Garage
 * container (spec seam 4).
 *
 * It holds the S3-protocol half: for a bucket's Delete, whether a
 * bucket holds files and emptying it; for a `static` site's deploy on AWS,
 * a folder's upload, and listing and deleting folders; for an
 * existing bucket on Google Cloud, whether its HMAC key reaches it,
 * through Cloud Storage's S3-compatible API (`CLOUD_STORAGE_S3`). CloudFront's
 * calls (the origin switch, the `/*` invalidation and both statuses) are
 * AWS's alone, so they are the cloud port's (`cloud.port.ts`).
 *
 * **Answers, not exceptions**, on the cloud port's rule: a bucket that could
 * not be read is `unknown`, an emptying that stopped is `{ ok: false }`.
 */
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

/** A credential the S3 protocol signs with: a key, or a role session's. */
export interface ObjectStorageCredential {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Present on a role session only. */
  readonly sessionToken?: string;
}

/** One bucket, and how to reach it. */
export interface ObjectStorageTarget {
  /**
   * The S3 API's base URL: a Garage's, or `null` for AWS's own endpoint for
   * {@link region}.
   */
  readonly endpoint: string | null;
  readonly region: string;
  /** The bucket's real name. */
  readonly bucket: string;
  readonly credential: ObjectStorageCredential;
  /** Path-style addressing: `true` for Garage, `false` for S3 (ADR-0032). */
  readonly pathStyle: boolean;
}

/**
 * Whether a bucket holds files: `holds-files` when it has any
 * object, old version or delete marker; `empty` when it has none of them;
 * `unknown` when the bucket could not be read — which every caller treats
 * as `holds-files`.
 */
export type BucketContents = 'holds-files' | 'empty' | 'unknown';

/**
 * How an emptying ended: every object, old version and delete marker gone,
 * or stopped partway with why, some files perhaps already deleted.
 */
export type EmptyOutcome =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

/**
 * Whether a credential reaches a bucket, by a list of one object
 * made with it: `ok` once it answers, `denied` when the store refuses the
 * credential (403/401), `not-found` when there is no such bucket, and
 * `unknown` when no answer came or it said anything else.
 */
export type BucketAccess = 'ok' | 'denied' | 'not-found' | 'unknown';

/** A folder's upload: every file under `directory`, at `prefix`. */
export interface FolderUpload {
  /** A folder on the platform host. */
  readonly directory: string;
  /** Where in the bucket, ending in `/`: `deployments/<deployment id>/`. */
  readonly prefix: string;
}

/** How an upload ended: how much went up, or why it stopped. */
export type UploadOutcome =
  | { readonly ok: true; readonly files: number; readonly bytes: number }
  | { readonly ok: false; readonly message: string };

/** The folders directly under a prefix, by name, or why they were not read. */
export type FolderListing =
  | { readonly ok: true; readonly folders: string[] }
  | { readonly ok: false; readonly message: string };

export interface ObjectStoragePort {
  /** One cheap read: no counts and no sizes, only whether anything is there. */
  contentsOf(target: ObjectStorageTarget): Promise<BucketContents>;
  /** Deletes every object, old version and delete marker in the bucket. */
  empty(target: ObjectStorageTarget): Promise<EmptyOutcome>;
  /**
   * Whether the target's credential reaches the bucket: a list of one
   * object made with it, as a linked Service's S3 SDK would make it
   * (an existing Google bucket's access check).
   */
  access(target: ObjectStorageTarget): Promise<BucketAccess>;
  /**
   * Uploads every file under the folder to the prefix, each with the
   * content type its extension names.
   */
  uploadFolder(
    target: ObjectStorageTarget,
    upload: FolderUpload,
  ): Promise<UploadOutcome>;
  /**
   * The names of the folders directly under `prefix` (which ends in `/`):
   * `deployments/` answers each Deployment's folder by its id.
   */
  listFolders(
    target: ObjectStorageTarget,
    prefix: string,
  ): Promise<FolderListing>;
  /** Deletes every file under `prefix` (which ends in `/`). */
  deleteFolder(
    target: ObjectStorageTarget,
    prefix: string,
  ): Promise<EmptyOutcome>;
}
