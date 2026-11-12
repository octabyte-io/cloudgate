/**
 * How a `static` site on AWS's rollback point is used and removed
 * (the spec's "Rollback"). Its point is a folder of the site's bucket, not an
 * image on a Server, so both halves go through the Cloud account: the
 * runner is `CloudStaticDeploys` in the Project config module, which
 * imports this one, so `RollbacksService` resolves this token when a point
 * with a `folder` is rolled back to or removed (`CLOUD_DOMAIN_RUNNER`'s
 * shape).
 */
export const STATIC_ROLLBACK_RUNNER = Symbol('STATIC_ROLLBACK_RUNNER');

/** What removing a point's folder did. */
export type FolderRemoval =
  /** The folder is gone, or there was no bucket to hold it. */
  | { ok: true; kept: false }
  /**
   * The distribution serves this folder now, so it stays; the next
   * Deployment's clean-up removes it once another folder is live.
   */
  | { ok: true; kept: true }
  | { ok: false; message: string };

export interface StaticRollbackRunner {
  /**
   * Records the Rollback as a build-less Deployment of the Service and
   * queues it in the Service's own Cloud run queue, behind any push's
   * switch already there, answering at once with its Deployment's id.
   */
  queue(input: {
    applicationId: string;
    folder: string;
    title: string;
    description: string;
  }): Promise<string>;
  /** Deletes a removed point's folder from the site's bucket. */
  removeFolder(input: {
    applicationId: string;
    folder: string;
  }): Promise<FolderRemoval>;
}
