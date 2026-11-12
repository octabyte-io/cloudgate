import type {
  CloudRunControl,
  CloudRunEnding,
  CloudRunExecutor,
  CloudRunJob,
  CloudRunPhase,
  CloudRunSignal,
} from './cloud-run-job.types';

/** How long a run has to end on its interrupt before it is killed. */
export const CLOUD_RUN_KILL_GRACE_MS = 5 * 60_000;

/**
 * How long a shutdown waits on an interrupted run before killing it: under the
 * unit's `TimeoutStopSec=5min`, so the kill, the last log lines and the row
 * are Cloudgate's and not systemd's SIGKILL.
 */
export const CLOUD_RUN_SHUTDOWN_GRACE_MS = 4 * 60_000;

export interface CloudRunPoolOptions<V> {
  /** Runs at once, install-wide; read lazily on every scheduling tick. */
  resolveLimit: () => Promise<number> | number;
  /** The time limit in minutes, read when a run starts. */
  resolveTimeLimitMinutes: () => Promise<number> | number;
  /** A minute, in milliseconds; a spec shortens it. */
  minuteMs?: number;
  executor: CloudRunExecutor<V>;
  /**
   * Called once per ending, before the run's promise resolves, so whoever
   * awaits a run sees its row already settled. A throw here is swallowed: the
   * pool frees the slot regardless.
   */
  onEnded?: (job: CloudRunJob, ending: CloudRunEnding<V>) => Promise<void>;
  killGraceMs?: number;
  shutdownGraceMs?: number;
}

/** Why a run was asked to end from outside, first cause wins. */
type Cause =
  | { kind: 'cancelled' }
  | { kind: 'stopped'; by: string }
  | { kind: 'timed-out'; minutes: number }
  | { kind: 'shutdown' };

interface Entry<V> {
  job: CloudRunJob;
  phase: CloudRunPhase;
  cause: Cause | null;
  signal: TwoStepSignal;
  timers: ReturnType<typeof setTimeout>[];
  /** The time limit's own clock, which a hold stops. */
  limit: TimeLimit | null;
  ended: Promise<CloudRunEnding<V>>;
  settle: (ending: CloudRunEnding<V>) => void;
}

/** A run's time limit as it counts: what is left, and since when. */
interface TimeLimit {
  readonly minutes: number;
  remainingMs: number;
  /** When it last started counting, or `null` while held. */
  countingSince: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  holds: number;
}

/**
 * The Cloud run pool (spec "Cloud run executor"): a second pool in
 * the deployment queue beside builds, so a 0.8 GB `tofu plan` never runs the
 * platform host out of memory. In memory like `InMemoryQueue`; what survives
 * a restart is the Deployment rows, settled at start-up by
 * `CloudRunsService`.
 *
 * Ordering rules, all install-wide (one partition):
 * - at most `resolveLimit()` runs at once;
 * - two runs of one state (`stateKey`) never overlap, and go in order;
 * - a run that touches the Environment network starts only when no other run
 *   of its Environment is running, and while it waits or runs no other run of
 *   that Environment starts;
 * - a waiting deploy goes before a waiting read, and a read of a state whose
 *   read is already queued or running joins it;
 * - a run with `after` waits while any run of those states is queued
 *   or running, ahead of it or behind it: a link's source goes first. It
 *   holds no slot while it waits, and its time limit starts with it.
 *
 * Ending a run from outside is one interrupt, then a kill
 * {@link CLOUD_RUN_KILL_GRACE_MS} later: Cancel while it waits or plans,
 * Stop the run at any point once it runs, and the time limit, counted from
 * the run's start — never time queued or building (the build has its own
 * slot before the run is submitted), and never time the run holds it while
 * it waits outside Cloudgate: a hosted cloud build queued in CodeBuild
 * (`CloudRunControl.holdTimeLimit`). Only Cancel ends `cancelled`.
 */
export class CloudRunPool<V = unknown> {
  private waiting: Entry<V>[] = [];
  private active: Entry<V>[] = [];
  private closed = false;
  private readonly killGraceMs: number;
  private readonly shutdownGraceMs: number;
  private readonly minuteMs: number;

  constructor(private readonly options: CloudRunPoolOptions<V>) {
    this.killGraceMs = options.killGraceMs ?? CLOUD_RUN_KILL_GRACE_MS;
    this.shutdownGraceMs =
      options.shutdownGraceMs ?? CLOUD_RUN_SHUTDOWN_GRACE_MS;
    this.minuteMs = options.minuteMs ?? 60_000;
  }

  /** Queue a deploy, network or Delete run; resolves with how it ended. */
  submit(job: CloudRunJob): Promise<CloudRunEnding<V>> {
    if (this.closed) {
      return Promise.resolve({ kind: 'shutdown', started: false });
    }
    const entry = this.entry(job);
    this.waiting.push(entry);
    this.schedule();
    return entry.ended;
  }

  /**
   * Queue a plan-only read, or join the read of the same state already
   * queued or running.
   */
  read(job: CloudRunJob): Promise<CloudRunEnding<V>> {
    const joined = [...this.waiting, ...this.active].find(
      (entry) =>
        entry.job.kind === 'read' &&
        entry.job.stateKey === job.stateKey &&
        entry.cause === null,
    );
    return joined ? joined.ended : this.submit({ ...job, kind: 'read' });
  }

  /** Where the run recording this Deployment is, or null if not here. */
  phaseOf(deploymentId: string): CloudRunPhase | null {
    return this.find(deploymentId)?.phase ?? null;
  }

  /**
   * Cancel: a waiting run is taken out and ends `cancelled` without starting;
   * a planning run is interrupted and ends `cancelled`. Refused (`applying`)
   * once its apply has begun.
   */
  cancel(deploymentId: string): 'cancelled' | 'applying' | 'unknown' {
    const entry = this.find(deploymentId);
    if (!entry) return 'unknown';
    if (entry.phase === 'applying') return 'applying';
    if (entry.phase === 'waiting') {
      this.waiting = this.waiting.filter((other) => other !== entry);
      void this.finish(entry, { kind: 'cancelled' });
      return 'cancelled';
    }
    this.end(entry, { kind: 'cancelled' }, this.killGraceMs);
    return 'cancelled';
  }

  /**
   * Stop the run: a running run is interrupted, then killed, and ends
   * `stopped`. A waiting run answers `waiting` — taking it out is Cancel.
   */
  stop(deploymentId: string, by: string): 'stopping' | 'waiting' | 'unknown' {
    const entry = this.find(deploymentId);
    if (!entry) return 'unknown';
    if (entry.phase === 'waiting') return 'waiting';
    this.end(entry, { kind: 'stopped', by }, this.killGraceMs);
    return 'stopping';
  }

  /**
   * Cloudgate is shutting down: nothing more starts, waiting runs end
   * unstarted (their rows stay `pending` for start-up), and every running run
   * is interrupted and waited for, killed if it outlasts the shutdown grace.
   */
  async shutdown(): Promise<void> {
    this.closed = true;
    const waiting = this.waiting;
    this.waiting = [];
    for (const entry of waiting) {
      void this.finish(entry, { kind: 'shutdown', started: false });
    }
    const running = [...this.active];
    for (const entry of running) {
      this.end(entry, { kind: 'shutdown' }, this.shutdownGraceMs);
    }
    await Promise.all([...waiting, ...running].map((entry) => entry.ended));
  }

  private entry(job: CloudRunJob): Entry<V> {
    let settle!: (ending: CloudRunEnding<V>) => void;
    const ended = new Promise<CloudRunEnding<V>>((resolve) => {
      settle = resolve;
    });
    return {
      job,
      phase: 'waiting',
      cause: null,
      signal: new TwoStepSignal(),
      timers: [],
      limit: null,
      ended,
      settle,
    };
  }

  private find(deploymentId: string): Entry<V> | undefined {
    return [...this.active, ...this.waiting].find(
      (entry) => entry.job.deploymentId === deploymentId,
    );
  }

  /** Ask a running run to end: one interrupt, a kill after `graceMs`. */
  private end(entry: Entry<V>, cause: Cause, graceMs: number): void {
    if (entry.cause !== null) return;
    entry.cause = cause;
    entry.signal.interrupt();
    entry.timers.push(unref(setTimeout(() => entry.signal.kill(), graceMs)));
  }

  private schedule(): void {
    void this.drain();
  }

  private async drain(): Promise<void> {
    const limit = Math.max(1, Math.floor(await this.options.resolveLimit()));
    while (!this.closed && this.active.length < limit) {
      const next = this.next();
      if (!next) break;
      this.waiting = this.waiting.filter((entry) => entry !== next);
      next.phase = 'planning';
      this.active.push(next);
      void this.run(next);
    }
  }

  /** The first waiting deploy that may start, else the first such read. */
  private next(): Entry<V> | undefined {
    const eligible = this.waiting.filter((entry) => this.mayStart(entry));
    return eligible.find((entry) => entry.job.kind !== 'read') ?? eligible[0];
  }

  private mayStart(entry: Entry<V>): boolean {
    const { stateKey, environmentId, touchesNetwork, after } = entry.job;
    if (after?.length && this.sourceStillRuns(entry, after)) return false;
    const sameEnvironment = (other: Entry<V>) =>
      other.job.environmentId === environmentId;
    if (this.active.some((other) => other.job.stateKey === stateKey)) {
      return false;
    }
    const activeHere = this.active.filter(sameEnvironment);
    if (activeHere.some((other) => other.job.touchesNetwork)) return false;
    const aheadHere = this.waiting
      .slice(0, this.waiting.indexOf(entry))
      .filter(sameEnvironment);
    if (touchesNetwork) {
      // It waits for every run of its Environment queued or running before it.
      return activeHere.length === 0 && aheadHere.length === 0;
    }
    // And holds back every run of its Environment queued after it.
    return !aheadHere.some((other) => other.job.touchesNetwork);
  }

  /** Whether a run of one of `sources` is queued or running, other than `entry`. */
  private sourceStillRuns(
    entry: Entry<V>,
    sources: readonly string[],
  ): boolean {
    return [...this.active, ...this.waiting].some(
      (other) =>
        other !== entry &&
        other.job.kind !== 'read' &&
        sources.includes(other.job.stateKey),
    );
  }

  private async run(entry: Entry<V>): Promise<void> {
    const control: CloudRunControl = {
      signal: entry.signal,
      beginApply: () => {
        if (entry.cause !== null) return false;
        entry.phase = 'applying';
        return true;
      },
      holdTimeLimit: () => this.holdLimit(entry),
    };
    let own: CloudRunEnding<V>;
    try {
      const minutes = await this.options.resolveTimeLimitMinutes();
      entry.limit = {
        minutes,
        remainingMs: minutes * this.minuteMs,
        countingSince: null,
        timer: null,
        holds: 0,
      };
      this.countLimit(entry, entry.limit);
      own = {
        kind: 'finished',
        value: await this.options.executor(entry.job, control),
      };
    } catch (error) {
      own = {
        kind: 'failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    for (const timer of entry.timers) clearTimeout(timer);
    if (entry.limit?.timer) clearTimeout(entry.limit.timer);
    this.active = this.active.filter((other) => other !== entry);
    await this.finish(entry, endingOf(entry.cause, own));
    this.schedule();
  }

  /** The time limit counts on from what is left of it. */
  private countLimit(entry: Entry<V>, limit: TimeLimit): void {
    limit.countingSince = Date.now();
    limit.timer = unref(
      setTimeout(
        () =>
          this.end(
            entry,
            { kind: 'timed-out', minutes: limit.minutes },
            this.killGraceMs,
          ),
        limit.remainingMs,
      ),
    );
  }

  /** {@link CloudRunControl.holdTimeLimit}: stops the clock until released. */
  private holdLimit(entry: Entry<V>): () => void {
    const limit = entry.limit;
    if (!limit || entry.cause !== null) return () => undefined;
    if (limit.holds === 0 && limit.timer && limit.countingSince !== null) {
      clearTimeout(limit.timer);
      limit.timer = null;
      limit.remainingMs = Math.max(
        0,
        limit.remainingMs - (Date.now() - limit.countingSince),
      );
      limit.countingSince = null;
    }
    limit.holds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      limit.holds -= 1;
      if (limit.holds === 0 && entry.cause === null && this.isActive(entry)) {
        this.countLimit(entry, limit);
      }
    };
  }

  private isActive(entry: Entry<V>): boolean {
    return this.active.includes(entry);
  }

  private async finish(
    entry: Entry<V>,
    ending: CloudRunEnding<V>,
  ): Promise<void> {
    try {
      await this.options.onEnded?.(entry.job, ending);
    } catch {
      // The row is the recorder's to keep; the slot is the pool's to free.
    }
    entry.settle(ending);
  }
}

/** The ending a cause from outside makes of whatever the run returned. */
function endingOf<V>(
  cause: Cause | null,
  own: CloudRunEnding<V>,
): CloudRunEnding<V> {
  if (cause === null) return own;
  if (cause.kind === 'shutdown') return { kind: 'shutdown', started: true };
  return cause;
}

/** A run's timers never hold the process open on their own. */
function unref(
  timer: ReturnType<typeof setTimeout>,
): ReturnType<typeof setTimeout> {
  timer.unref();
  return timer;
}

/** {@link CloudRunSignal}, fired by the pool. */
class TwoStepSignal implements CloudRunSignal {
  interrupted = false;
  killed = false;
  private readonly interruptListeners: (() => void)[] = [];
  private readonly killListeners: (() => void)[] = [];

  onInterrupt(listener: () => void): void {
    if (this.interrupted) listener();
    else this.interruptListeners.push(listener);
  }

  onKill(listener: () => void): void {
    if (this.killed) listener();
    else this.killListeners.push(listener);
  }

  interrupt(): void {
    if (this.interrupted) return;
    this.interrupted = true;
    for (const listener of this.interruptListeners) listener();
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    for (const listener of this.killListeners) listener();
  }
}
