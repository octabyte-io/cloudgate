import { Injectable } from '@nestjs/common';
import type {
  CloudRunControl,
  CloudRunExecutor,
  CloudRunKind,
} from './cloud-run-job.types';
import { noCloudRunExecutor } from './cloud-runs.service';

/** What a plan read does once the pool starts it. */
export type CloudReadWork = (control: CloudRunControl) => Promise<unknown>;

/**
 * The work behind each Cloud run, and the pool's bound `CLOUD_RUN_EXECUTOR`.
 *
 * **A plan-only read** is work registered under the state it locks:
 * a {@link CloudRunJob} names only that state, so whoever asks for a read
 * registers what it does under the state's key just before asking, and the
 * executor takes it when the pool starts the run. A read of a key that is
 * already queued or running joins it, and then runs the work last
 * registered for it.
 *
 * **A run that records a Deployment** is done by the handler registered for
 * its kind (the network's; a Service's deploy), which reads what
 * to do from the Deployment row itself. That is what lets start-up queue a
 * `pending` row again with nothing held in memory. A kind with no handler
 * yet fails, as before, saying there is no runner.
 */
@Injectable()
export class CloudReadWorks {
  private readonly work = new Map<string, CloudReadWork>();
  private readonly handlers = new Map<CloudRunKind, CloudRunExecutor>();

  register(stateKey: string, work: CloudReadWork): void {
    this.work.set(stateKey, work);
  }

  /** The runner of every run of `kind` that records a Deployment. */
  handle(kind: Exclude<CloudRunKind, 'read'>, executor: CloudRunExecutor) {
    this.handlers.set(kind, executor);
  }

  readonly executor: CloudRunExecutor = (job, control) => {
    if (job.kind !== 'read') {
      const handler = this.handlers.get(job.kind) ?? noCloudRunExecutor;
      return handler(job, control);
    }
    const work = this.work.get(job.stateKey);
    this.work.delete(job.stateKey);
    if (!work) {
      return Promise.reject(
        new Error(`Nothing was asked of the read of ${job.stateKey}`),
      );
    }
    return work(control);
  };
}
