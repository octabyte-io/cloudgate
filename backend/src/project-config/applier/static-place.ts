import type {
  EmptyOutcome,
  FolderListing,
  FolderUpload,
  UploadOutcome,
} from '../../object-storage/object-storage.port';
import type { Application } from '../../db/schema';
import type { CloudRunControl } from '../../deployment-queue/cloud-run-job.types';

// **How a static site's folder goes live, per cloud** (the Google Cloud buckets spec
// "Modules"). A static site's Deployment and Rollback are one run on every
// cloud (`CloudStaticDeploys`): the per-Service queue, the 30-minute cap, the
// upload of `publish` to the Deployment's own folder, the folder clean-up,
// the Deployment log's step lines and the restart rule. What differs
// is how the uploaded folder is made live and how the CDN learns of it —
// on AWS an origin-path switch and CloudFront's spread
// (`AwsStaticDeploys`), on Google Cloud a server-side copy into the fixed
// `live/` folder and a cache clear per Domain (`GoogleStaticDeploys`). Each
// cloud's half is a {@link StaticHalf}, chosen by
// the cloud seam (ADR-0043), so a second cloud's static deploy is one more
// half, not an edit of the run.

/**
 * The ceiling on a static site's Deployment (the AWS buckets spec "Landing" 5, the
 * Google Cloud buckets spec "Failure and cap"): what a half does at it is its own —
 * on AWS the Deployment ends done, "still spreading"; on Google Cloud, where nothing
 * spreads, it ends failed.
 */
export const STATIC_DEPLOY_CAP_MS = 30 * 60_000;

/** `4,005 files`, `1 file`: a count as the log says it. */
export function counted(count: number, noun: string): string {
  return `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`;
}

/** A static site's row with the columns every cloud's half reads set. */
export interface StaticSite {
  readonly found: Application;
  /** Its Config name, as the log names it. */
  readonly name: string;
  readonly region: string;
  /** Its own bucket's real name. */
  readonly bucket: string;
}

/**
 * The site's own bucket, as the run reaches its Deployment folders: each
 * call is already signed with the cloud's session.
 */
export interface StaticFolders {
  /** A place in the bucket as the log names it: `s3://<bucket>/<prefix>`, `gs://…`. */
  where(prefix: string): string;
  /**
   * `publish` uploaded to a Deployment folder. `startedAt` is when the
   * Deployment's run began, on the static clock, for a half that holds the
   * upload to the Deployment's cap (on Google).
   */
  upload(upload: FolderUpload, startedAt?: number): Promise<UploadOutcome>;
  list(prefix: string): Promise<FolderListing>;
  delete(prefix: string): Promise<EmptyOutcome>;
}

/** What a clean-up spares beside the rollback points. */
export interface FoldersInUse {
  /** The Deployment folder visitors are served, if they are served one. */
  readonly live: string | null;
  /** A previous folder still served for a while, and the while, as logged. */
  readonly previous: { readonly folder: string; readonly while: string } | null;
}

/** How a site is served on one cloud, once it can be. */
export interface StaticServing {
  /** Where, as the log's first line names it: `S3 + CloudFront in Cloud account … (region)`. */
  readonly place: string;
  /** What serves the files, as the deploy's first line ends: `served by distribution …`. */
  readonly servedBy: string;
  /** What a Rollback leaves as the Project config says: `the distribution's settings`. */
  readonly settings: string;
  /**
   * What the Deployment ends with when a Cloudgate restart cuts it off once
   * {@link goLive} has begun, when "the next deploy picks up from what was
   * made" would not say it: on Google Cloud, a copy into `live/` cut off
   * partway leaves files from both versions. It is never run again
   * Absent on a cloud whose go-live is one switch.
   */
  readonly cutOff?: string;
  /**
   * Makes `folder` the one visitors are served, logging its own steps. From
   * here the Deployment has changed what they see; a refusal throws, naming
   * what the site serves now. `startedAt` is when the Deployment's run
   * began, on the static clock, for a half that holds its step to the
   * Deployment's cap (on Google, the copy into `live/`).
   */
  goLive(input: {
    folder: string;
    startedAt: number;
    control: CloudRunControl;
    log: (line: string) => Promise<void>;
  }): Promise<void>;
  /**
   * After {@link goLive} and its rollback point: how the CDN learns of the
   * change, logged by its own lines. Answers what the clean-up spares.
   */
  settle(input: {
    deploymentId: string;
    folder: string;
    /** As {@link goLive}'s: on Google the per-Domain cache clears are held to the cap. */
    startedAt: number;
    control: CloudRunControl;
    log: (line: string) => Promise<void>;
  }): Promise<FoldersInUse>;
}

/** One cloud's half of a static site's Deployment. */
export interface StaticHalf {
  readonly folders: StaticFolders;
  /**
   * The site as it is served. Throws, naming what is missing, when there
   * is nowhere to serve its files yet: before anything is logged or
   * uploaded.
   */
  serving(): StaticServing;
}
