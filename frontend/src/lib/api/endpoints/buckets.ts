import { api } from "../client";

import type { ApplicationStatus, CloudLeftover } from "./applications";
import type { BucketLeftBehind } from "./teardown";

/**
 * `buckets.controller.ts` — a Bucket: a Service written `kind: bucket`
 * in the Project config, which holds files and runs nothing of its own. On a
 * Server it is its own Garage container (ADR-0037).
 *
 * `GET /buckets/:id`, `PUT /buckets/:id/origins` for the web origins
 * trusted to upload to it from a browser, `POST
 * /buckets/:id/rotate-key`, and its Delete, with Retry and
 * Forget for one on AWS whose Delete is incomplete. A
 * bucket is made by a plan, never by a form here — but for an existing
 * bucket, `POST /buckets/existing` — and its key is never
 * sent: `hasKey` says only that it is set (ADR-0019).
 */

/**
 * Where a bucket is (ADR-0035): its Server, the platform host, or an S3
 * bucket in a Cloud account and region.
 */
export type BucketPlace =
  | { kind: "server"; serverId: string; serverName: string }
  | { kind: "platform-host" }
  | {
      kind: "cloud";
      cloudAccountId: string;
      cloudAccountName: string;
      /**
       * Its Cloud account's own id: on AWS the account id its real name
       * ends with; on Google Cloud the project id, where Cloudgate makes
       * the bucket, or an existing bucket's key.
       */
      cloudId: string;
      /**
       * Its Cloud account's cloud: on Google Cloud the bucket has a
       * key of its own, which Rotate key replaces; on AWS it has none.
       */
      cloud: "aws" | "gcp";
      region: string;
      /**
       * An existing bucket on Google Cloud in a project other than its
       * Cloud account's: that project's number; `null` otherwise.
       */
      bucketProjectNumber: string | null;
    };

export interface Bucket {
  bucketId: string;
  name: string;
  appName: string;
  configName: string;
  description: string | null;
  /** Its real name, Cloudgate's, made once when the bucket was created. */
  bucketName: string;
  /** Always `us-east-1` on a Server; the Cloud account's region on AWS. */
  region: string;
  place: BucketPlace;
  /**
   * An existing bucket (ADR-0033): one made outside Cloudgate, in
   * `place`'s Cloud account and region, chosen by its name. Every plan looks
   * it up; Cloudgate never changes it, and its Delete leaves it as it was.
   * Its `applicationStatus` is `done` once a plan's lookup found it.
   */
  existing: boolean;
  /**
   * An existing bucket on Google Cloud's access; `null` until the
   * Apply made its key, and for every other bucket.
   */
  googleAccess: BucketGoogleAccess | null;
  serverId: string | null;
  /**
   * The Docker volume its files are on, which a volume backup names;
   * `null` for an S3 bucket, which has none.
   */
  volumeName: string | null;
  hasKey: boolean;
  /**
   * The web origins trusted to upload to it straight from a browser,
   * in this Environment; Cloudgate's, never the Project config's. Empty is
   * none.
   */
  origins: string[];
  /**
   * Its last Rotate key, running or ended, or `null` before the
   * first. Never a key.
   */
  keyRotation: KeyRotation | null;
  /**
   * A bucket on AWS's Delete (ADR-0038): `deleting` while its
   * destroy-only Cloud run is queued or running, `incomplete` once it left
   * something in AWS — a bucket "partly emptied" included — or did not
   * finish; `null` when there is none.
   */
  cloudDelete: BucketCloudDelete | null;
  applicationStatus: ApplicationStatus;
  createdAt: string;
  environmentId: string;
  environment: {
    environmentId: string;
    name: string;
    project: { projectId: string; name: string };
  };
}

/** A bucket on AWS's Delete under way or incomplete. */
export interface BucketCloudDelete {
  status: "deleting" | "incomplete";
  /** The Deployment that records its latest run. */
  deploymentId: string;
  /** Its Delete asked for its files to go, so a Retry empties it again. */
  deleteFiles: boolean;
  left: CloudLeftover[];
  /** Why the latest run did not finish; `null` when it did. */
  unfinished: string | null;
}

/** One linking Service's redeploy in a key rotation, and how it ended. */
export interface KeyRotationRedeploy {
  configName: string;
  serviceType: "application" | "postgres" | "mysql" | "redis";
  serviceId: string;
  /** An Application's queued Deployment; `null` for a database. */
  deploymentId: string | null;
  queuedAt: string;
  outcome: "done" | "failed" | null;
}

/**
 * Where a bucket's Rotate key is: `redeploying` every Service that
 * links its key with the new one, or `putting-back` the ones already on it
 * after another failed; ended `done` or `failed`, with `message` saying
 * how and `failed` naming each Service whose redeploy failed.
 */
export interface KeyRotation {
  status: "running" | "done" | "failed";
  phase: "redeploying" | "putting-back" | null;
  startedAt: string;
  finishedAt: string | null;
  queued: boolean;
  redeploys: KeyRotationRedeploy[];
  putBacks: KeyRotationRedeploy[];
  failed: string[];
  message: string | null;
}

/**
 * What a bucket's Delete answered: `bucketLeftBehind` is the bucket it
 * kept because it holds files, could not be read or was only partly emptied,
 * named once; `volumeLeftBehind` an empty bucket's volume Docker kept.
 */
export interface BucketDeleteReport {
  volumeLeftBehind: boolean;
  bucketLeftBehind?: BucketLeftBehind;
  /**
   * A bucket on AWS that was empty, or asked to be emptied: the
   * destroy-only Cloud run its Delete queued. The bucket reads "Deleting"
   * until it ends.
   */
  cloudDelete?: { status: "deleting"; deploymentId: string };
  /**
   * An existing bucket's Delete: the bucket it left as it was, files
   * and all, and the sentence saying so. Nothing reached AWS.
   */
  bucketLeftAsItWas?: BucketLeftAsItWas;
}

/** An existing bucket a Delete left as it was. */
export interface BucketLeftAsItWas {
  bucketName: string;
  message: string;
  /**
   * On Google Cloud: the grant the operator added on the bucket for
   * its key's service account, left with it, and the exact line that
   * removes it. `message` names it too.
   */
  grantLeft?: { serviceAccount: string; command: string };
}

/**
 * An existing bucket on Google Cloud's access: "waiting for access"
 * until a list of one file made with its key succeeds, ok, or "no access"
 * when it fails after that, with the `add-iam-policy-binding` line that
 * grants it. Nothing waits on it.
 */
export interface BucketGoogleAccess {
  status: "waiting" | "ok" | "no-access";
  checkedAt: string | null;
  /** The bucket's own service account, which holds its key. */
  serviceAccount: string;
  grant: string;
  /** What the page says while the key has no access; `null` once it has. */
  sentence: string | null;
}

/**
 * What the "Use an existing bucket" form shows: on Google Cloud the
 * grant a bucket in another project needs so every plan can look it up,
 * `<bucket>` standing for its name. `null` on AWS.
 */
export interface ExistingBucketReach {
  google: {
    projectId: string;
    serviceAccount: string;
    readGrant: string;
  } | null;
}

export const bucketsApi = {
  findOne: (bucketId: string) => api.get<Bucket>(`/buckets/${bucketId}`),
  /**
   * "Use an existing bucket" (ADR-0033): the Environment's `bucket`
   * entry stands for an S3 bucket the operator already has, named here.
   * `service: create`. The Project config does not change.
   */
  createExisting: (body: {
    environmentId: string;
    configName: string;
    bucketName: string;
  }) => api.post<Bucket>("/buckets/existing", body),
  /** What the "Use an existing bucket" form shows. `service: create`. */
  existingReach: (environmentId: string) =>
    api.get<ExistingBucketReach>(
      `/buckets/existing/reach?environmentId=${encodeURIComponent(environmentId)}`,
    ),
  /** The whole new list; answers the bucket as it now reads. */
  putOrigins: (bucketId: string, origins: string[]) =>
    api.put<Bucket>(`/buckets/${bucketId}/origins`, { origins }),
  /**
   * Rotate key: `service: update`. Answers once the new key is made
   * and every linking Service's redeploy queued; `keyRotation` follows them.
   */
  rotateKey: (bucketId: string) =>
    api.post<Bucket>(`/buckets/${bucketId}/rotate-key`),
  /**
   * Keeps a bucket that holds files and removes an empty one; `deleteFiles`
   * — "also delete its files" — empties it first. `service: delete` only.
   */
  remove: (bucketId: string, deleteFiles = false) =>
    api.delete<BucketDeleteReport>(`/buckets/${bucketId}`, {
      query: { deleteFiles: deleteFiles ? "true" : "false" },
    }),
  /** Retry a bucket on AWS's incomplete Delete: `service: delete`. */
  retryDelete: (bucketId: string) =>
    api.post<BucketDeleteReport>(`/buckets/${bucketId}/delete/retry`),
  /**
   * Forget a bucket on AWS's incomplete Delete: the row dropped, what
   * is left written into the audit log. `service: delete`.
   */
  forgetDelete: (bucketId: string) =>
    api.post<{ bucketId: string; forgotten: CloudLeftover[] }>(
      `/buckets/${bucketId}/delete/forget`,
    ),
};
