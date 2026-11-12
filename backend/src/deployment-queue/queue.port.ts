import type { DeploymentJob } from './job-types';

/** DI token for the deployment queue. */
export const DEPLOYMENT_QUEUE = Symbol('DEPLOYMENT_QUEUE');

export type JobState = 'waiting' | 'active';

/** Public handle for an enqueued job — a snapshot, not a live view. */
export interface QueuedJob {
  id: string;
  data: DeploymentJob;
  state: JobState;
}

/**
 * What callers (deploy triggers, queue-inspection endpoints) may do with the
 * deployment queue. Kept to a subset of BullMQ's queue API so a
 * `@nestjs/bullmq` adapter can swap in behind the same port.
 */
export interface QueuePort {
  add(data: DeploymentJob): Promise<QueuedJob>;
  getJobs(states?: JobState[]): Promise<QueuedJob[]>;
  /** Remove a pending job; resolves false if it already started (or is unknown). */
  cancel(jobId: string): Promise<boolean>;
  /**
   * Drop every pending job, and answer the jobs it dropped. The caller settles
   * the rows those jobs name — the queue is the only thing that
   * knows which builds will now never start.
   */
  clearWaiting(): Promise<QueuedJob[]>;
}
