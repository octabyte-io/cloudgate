import { getGroup, getPartition } from './job-types';
import type { DeploymentJob } from './job-types';
import type { JobState, QueuedJob, QueuePort } from './queue.port';

/**
 * In-memory deployment queue: jobs are partitioned by serverId, each partition
 * runs up to its resolved concurrency in parallel, and within a partition jobs
 * of the same group (application or compose) are serialized FIFO so two builds
 * of one service never overlap.
 */

type Processor = (job: QueuedJob) => Promise<void>;

interface InternalJob {
  id: string;
  data: DeploymentJob;
  state: JobState;
  partition: string;
  group: string;
}

interface Partition {
  waiting: InternalJob[];
  active: InternalJob[];
  /** Groups currently running in this partition. */
  activeGroups: Set<string>;
}

export interface InMemoryQueueOptions {
  /**
   * Max jobs that may run in parallel for a partition. Resolved lazily on
   * every scheduling tick so license/config changes apply without a restart.
   */
  resolveConcurrency: (partition: string) => Promise<number> | number;
}

export class InMemoryQueue implements QueuePort {
  private partitions = new Map<string, Partition>();
  private processor: Processor | null = null;
  private seq = 0;

  constructor(private readonly options: InMemoryQueueOptions) {}

  /** Register the worker; registering also starts scheduling. */
  process(processor: Processor): void {
    this.processor = processor;
    this.schedule();
  }

  add(data: DeploymentJob): Promise<QueuedJob> {
    const partitionKey = getPartition(data);
    const job: InternalJob = {
      id: `job-${++this.seq}`,
      data,
      state: 'waiting',
      partition: partitionKey,
      group: getGroup(data),
    };
    this.getPartition(partitionKey).waiting.push(job);
    const handle = this.toPublic(job);
    this.schedule();
    return Promise.resolve(handle);
  }

  private getPartition(key: string): Partition {
    let partition = this.partitions.get(key);
    if (!partition) {
      partition = { waiting: [], active: [], activeGroups: new Set() };
      this.partitions.set(key, partition);
    }
    return partition;
  }

  private toPublic(job: InternalJob): QueuedJob {
    return { id: job.id, data: job.data, state: job.state };
  }

  /** Snapshot of jobs in the requested states (defaults to all). */
  getJobs(states?: JobState[]): Promise<QueuedJob[]> {
    const wantWaiting = !states || states.includes('waiting');
    const wantActive = !states || states.includes('active');
    const jobs: QueuedJob[] = [];
    for (const partition of this.partitions.values()) {
      if (wantWaiting) {
        jobs.push(...partition.waiting.map((job) => this.toPublic(job)));
      }
      if (wantActive) {
        jobs.push(...partition.active.map((job) => this.toPublic(job)));
      }
    }
    return Promise.resolve(jobs);
  }

  /** Remove a pending job. Active jobs cannot be cancelled. */
  cancel(jobId: string): Promise<boolean> {
    for (const partition of this.partitions.values()) {
      const before = partition.waiting.length;
      partition.waiting = partition.waiting.filter((job) => job.id !== jobId);
      if (partition.waiting.length !== before) return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }

  /** Drop every pending job and answer them; running jobs keep their slots. */
  clearWaiting(): Promise<QueuedJob[]> {
    const dropped: QueuedJob[] = [];
    for (const partition of this.partitions.values()) {
      dropped.push(...partition.waiting.map((job) => this.toPublic(job)));
      partition.waiting = [];
    }
    return Promise.resolve(dropped);
  }

  private schedule(): void {
    if (!this.processor) return;
    for (const key of this.partitions.keys()) {
      void this.drainPartition(key);
    }
  }

  private async drainPartition(key: string): Promise<void> {
    const partition = this.partitions.get(key);
    if (!partition || !this.processor) return;

    const concurrency = Math.max(1, await this.options.resolveConcurrency(key));

    while (partition.active.length < concurrency) {
      // First waiting job whose group is not already running.
      const index = partition.waiting.findIndex(
        (job) => !partition.activeGroups.has(job.group),
      );
      if (index === -1) break;

      const [job] = partition.waiting.splice(index, 1);
      job.state = 'active';
      partition.active.push(job);
      partition.activeGroups.add(job.group);
      void this.runJob(job);
    }
  }

  private async runJob(job: InternalJob): Promise<void> {
    try {
      await this.processor?.(this.toPublic(job));
    } catch {
      // A failed deployment is recorded by the processor itself; the queue
      // only cares that the slot (and the group) freed up.
    } finally {
      const partition = this.getPartition(job.partition);
      partition.active = partition.active.filter((j) => j.id !== job.id);
      partition.activeGroups.delete(job.group);
      void this.drainPartition(job.partition);
    }
  }
}
