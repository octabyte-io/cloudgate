/**
 * The deployment job contract: what a caller enqueues to request a build.
 * Compose and preview variants are part of the contract now so the queue is
 * reusable when those features land.
 */

interface BaseDeploymentJob {
  /** Deployment record metadata: its title and description. */
  title: string;
  description: string;
  type: 'deploy' | 'redeploy';
  /** Server the workload deploys onto; null/absent means the local server. */
  serverId?: string | null;
}

/**
 * The Deployment row a build job builds under: its trigger inserted the
 * row `pending` and enqueued the job naming it, so a waiting job and a row are
 * the same thing by identity, not by their order in the Service's queue group.
 * `cancel` dequeues the job that names the row it was asked about, and the
 * engine claims the row its job names, never another.
 *
 * `null` on a job that names no row of its own. A preview job carries one too:
 * its row is a Deployment of the parent Application naming the preview
 * through `deployment.preview_deployment_id`, queued `pending` like any other.
 */
interface BuildJobRow {
  deploymentId: string | null;
}

export type DeploymentJob =
  | (BaseDeploymentJob &
      BuildJobRow & {
        applicationType: 'application';
        applicationId: string;
      })
  | (BaseDeploymentJob &
      BuildJobRow & {
        applicationType: 'compose';
        composeId: string;
      })
  | (BaseDeploymentJob &
      BuildJobRow & {
        applicationType: 'application-preview';
        applicationId: string;
        previewDeploymentId: string;
      });

/**
 * The Deployment row `job` builds under, or null when it names none of its
 * own. A build job names one, a preview's included, so this is the one
 * spelling of "the row a job builds" for every reader that matches jobs to
 * rows.
 */
export const ownDeploymentId = (job: DeploymentJob): string | null =>
  job.deploymentId;

/** Partition key for jobs without a serverId (the local server). */
export const LOCAL_PARTITION = '__local__';

/** Resolve the partition (server) a job builds on. */
export const getPartition = (job: DeploymentJob): string =>
  job.serverId ?? LOCAL_PARTITION;

/**
 * Resolve the FIFO group a job belongs to — the service being deployed. Two
 * builds of the same service never run in parallel (same code dir, same
 * container name), so they serialize within this group.
 *
 * A preview job is in its parent's group, `application:<parentId>`, so preview
 * builds serialize with production and with each other. That is a
 * stated constraint, not an oversight: coalescing does not lean on it, since
 * which pending build a request may join is scoped by the row's
 * `preview_deployment_id` rather than by this group.
 */
export const getGroup = (job: DeploymentJob): string => {
  if (job.applicationType === 'compose') {
    return `compose:${job.composeId}`;
  }
  return `application:${job.applicationId}`;
};
