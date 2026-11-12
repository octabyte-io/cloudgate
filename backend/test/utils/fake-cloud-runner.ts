import type {
  CloudRunControl,
  CloudRunJob,
} from '../../src/deployment-queue/cloud-run-job.types';

/** One run the fake has started, and what has happened to it. */
export interface FakeRun {
  job: CloudRunJob;
  events: ('plan' | 'apply' | 'interrupt' | 'kill' | 'end')[];
}

interface Gate {
  promise: Promise<void>;
  open: () => void;
}

const gate = (): Gate => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

/**
 * A Cloud run's work faked in memory, bound in place of
 * `CLOUD_RUN_EXECUTOR` by a spec that drives the Cloud run pool: each run
 * plans, then applies, and waits at each step for the spec to let it go —
 * so a spec can hold a run in its plan or its apply and Cancel or stop it
 * there. Like `tofu`, a run ends on its interrupt; one told to {@link hang}
 * ends only when it is killed. Nothing reaches AWS or spawns a process.
 *
 * Stands in until the tofu runner and the deploy and network runs
 * bind the real executor; it fakes the work, never the pool.
 */
export class FakeCloudRunner {
  readonly runs = new Map<string, FakeRun>();
  private readonly gates = new Map<string, { plan: Gate; apply: Gate }>();
  private readonly hanging = new Set<string>();

  /** The executor to bind. */
  readonly executor = async (
    job: CloudRunJob,
    control: CloudRunControl,
  ): Promise<string> => {
    const id = job.deploymentId ?? `read:${job.stateKey}`;
    const run: FakeRun = { job, events: [] };
    this.runs.set(id, run);
    const gates = this.gatesOf(id);
    let ended = false;
    const ending = gate();
    control.signal.onInterrupt(() => {
      run.events.push('interrupt');
      if (!this.hanging.has(id)) ending.open();
    });
    control.signal.onKill(() => {
      run.events.push('kill');
      ending.open();
    });
    void ending.promise.then(() => {
      ended = true;
    });

    run.events.push('plan');
    await Promise.race([gates.plan.promise, ending.promise]);
    if (!ended && job.kind !== 'read' && control.beginApply()) {
      run.events.push('apply');
      await Promise.race([gates.apply.promise, ending.promise]);
    }
    run.events.push('end');
    return id;
  };

  /** Let the run's plan finish. */
  finishPlan(id: string): void {
    this.gatesOf(id).plan.open();
  }

  /** Let the run's apply finish. */
  finishApply(id: string): void {
    this.gatesOf(id).apply.open();
  }

  /** The run ignores its interrupt and ends only when killed. */
  hang(id: string): void {
    this.hanging.add(id);
  }

  /** Whether the run has started, and what has happened to it. */
  eventsOf(id: string): FakeRun['events'] {
    return this.runs.get(id)?.events ?? [];
  }

  reset(): void {
    for (const { plan, apply } of this.gates.values()) {
      plan.open();
      apply.open();
    }
    this.runs.clear();
    this.gates.clear();
    this.hanging.clear();
  }

  private gatesOf(id: string) {
    let gates = this.gates.get(id);
    if (!gates) {
      gates = { plan: gate(), apply: gate() };
      this.gates.set(id, gates);
    }
    return gates;
  }
}
