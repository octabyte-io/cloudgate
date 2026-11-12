import type {
  CloudRunServiceStatus,
  CloudRunWorkerPoolStatus,
} from '../google-cloud.port';
import type { CloudRunResource } from './definitions/cloud-run-definition';

/**
 * Where a Cloud Run service's newest revision is, read off the service's own
 * report: a deploy waits until it is
 * **serving** — ready and taking all traffic, the point after which every
 * other image version may go — or **failed**, when its Ready condition
 * failed and Google's words say why.
 */
export type Rollout =
  | { readonly state: 'waiting' }
  | { readonly state: 'serving'; readonly revision: string }
  | {
      readonly state: 'failed';
      readonly revision: string | null;
      readonly reason: string;
    };

export function rolloutOf(status: CloudRunServiceStatus): Rollout {
  const condition = status.terminalCondition;
  if (condition?.state === 'CONDITION_FAILED') {
    return {
      state: 'failed',
      revision: status.latestCreatedRevision,
      reason:
        condition.message ?? condition.reason ?? 'Cloud Run did not say why',
    };
  }
  const newest = status.latestCreatedRevision;
  if (
    status.reconciling ||
    condition?.state !== 'CONDITION_SUCCEEDED' ||
    newest === null ||
    status.latestReadyRevision !== newest
  ) {
    return { state: 'waiting' };
  }
  // `null` is "the latest ready revision", which is the newest now.
  const toNewest = status.traffic
    .filter((one) => one.revision === null || one.revision === newest)
    .reduce((sum, one) => sum + one.percent, 0);
  return toNewest === 100
    ? { state: 'serving', revision: newest }
    : { state: 'waiting' };
}

/**
 * Where a Worker's worker pool's newest revision is, as
 * {@link rolloutOf} reads a service's: serving once it is ready, every
 * instance runs it, and the pool is at the `instances` its deploy set; a
 * revision that fails to start is failed, in Google's condition's words.
 */
export function workerPoolRolloutOf(
  status: CloudRunWorkerPoolStatus,
  instances: number,
): Rollout {
  const rollout = rolloutOf({ ...status, traffic: status.instanceSplits });
  if (rollout.state === 'serving' && status.instanceCount !== instances) {
    return { state: 'waiting' };
  }
  return rollout;
}

/**
 * The project's log store filtered to one revision:
 * the app's own output and Cloud Run's messages about it, never the
 * per-request log. A Worker's revision is its worker pool's.
 */
export function failedRevisionLogFilter(
  serviceName: string,
  revision: string,
  resource: CloudRunResource = 'service',
): string {
  return [
    ...cloudRunResource(serviceName, resource),
    `resource.labels.revision_name="${revision}"`,
    'NOT log_name:"run.googleapis.com%2Frequests"',
  ].join(' AND ');
}

/** Cloud Logging's monitored resource type and name label, by Cloud Run resource. */
const LOGGED_AS: Record<
  CloudRunResource,
  { readonly type: string; readonly nameLabel: string }
> = {
  service: { type: 'cloud_run_revision', nameLabel: 'service_name' },
  'worker-pool': {
    type: 'cloud_run_worker_pool',
    nameLabel: 'worker_pool_name',
  },
  job: { type: 'cloud_run_job', nameLabel: 'job_name' },
};

/**
 * Cloud Logging's monitored resource of one Cloud Run resource by its fixed
 * name: a service's revisions, or a Worker's worker pool.
 */
export function cloudRunResource(
  name: string,
  resource: CloudRunResource,
): string[] {
  const { type, nameLabel } = LOGGED_AS[resource];
  return [`resource.type="${type}"`, `resource.labels.${nameLabel}="${name}"`];
}
