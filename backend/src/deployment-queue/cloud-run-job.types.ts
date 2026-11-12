/**
 * The Cloud run contract ("Running the work"): what waits in
 * the Cloud run pool beside builds, how a run is asked to end from outside,
 * and how it ended. The pool (`cloud-run-pool.ts`) is pure over this file; the
 * work itself is a {@link CloudRunExecutor} injected into it, so the tofu
 * runner and the deploy, network and Delete runs plug in
 * without the pool knowing what a run does.
 */

/**
 * What a run does. `read` is a plan-only read (a push plan, "Check for
 * changes"): it records no Deployment, and a second request for the same
 * state while one is queued or running joins it. `domain` applies only a
 * Service's Domains, with no plan to approve. `destroy` is a cloud
 * Service's Delete; `network-destroy` an Environment network's
 * removal.
 */
export type CloudRunKind =
  | 'deploy'
  | 'network'
  | 'destroy'
  | 'network-destroy'
  | 'read'
  | 'domain'
  /** A postgres on RDS's create, applied from a plan. */
  | 'database'
  /** A bucket on AWS's create or change, applied from a plan. */
  | 'bucket'
  /** A Compose stack's Stack VM create, applied from a plan (ADR-0070). */
  | 'stack-vm'
  /**
   * A Compose stack on a Stack VM's Delete (#1367): its data disk's final
   * snapshot unless asked not to, everything in its state, and its daily
   * snapshots.
   */
  | 'stack-vm-destroy'
  /** A redis on ElastiCache's create, applied from a plan. */
  | 'cache'
  /** A bucket on AWS's Delete, which may empty it first. */
  | 'bucket-destroy'
  /**
   * A bucket on Cloud Storage's Rotate key: one HMAC key made, or
   * one turned off and deleted, applied with `-target` on that key alone.
   */
  | 'bucket-key'
  /** A `static` site on S3 + CloudFront's create or change, from a plan. */
  | 'static'
  /**
   * A `static` site on S3 + CloudFront's Deployment: its files
   * uploaded to a folder of their own, the origin switched, the cache
   * cleared, and the wait for both. No `tofu`.
   */
  | 'static-deploy'
  /** A postgres on RDS's or a redis on ElastiCache's Delete. */
  | 'database-destroy'
  /**
   * A `static` site on S3 + CloudFront's Rollback: a build-less
   * Deployment that switches the origin back to a rollback point's folder,
   * clears the cache and waits, as a `static-deploy` does from its switch.
   */
  | 'static-rollback';

export interface CloudRunJob {
  /** The Deployment row the run records; `null` for a plan-only read. */
  deploymentId: string | null;
  kind: CloudRunKind;
  /**
   * The Infrastructure state the run takes the lock of — a Service's
   * (`application:<id>`) or an Environment network's
   * (`network:<environmentNetworkId>`). Two runs of one state never overlap.
   */
  stateKey: string;
  environmentId: string;
  /**
   * The run changes the Environment network. It waits until no other run of
   * its Environment is running and, while it waits or runs, holds back every
   * other run of that Environment.
   */
  touchesNetwork: boolean;
  /**
   * The states of the link sources this run waits for (ADR-0031): a
   * cloud `web` whose variables link a postgres on RDS lists that
   * postgres's `postgres:<id>`. The run is not eligible while a run of any
   * of them is queued or running, wherever in the pool, so a source's 10–15
   * minute create holds the linked run back without the linked run holding
   * a slot. It never fails the run: once the source's run has ended, the
   * linked run starts and says itself whether its source is there.
   */
  after?: readonly string[];
}

/**
 * How a run ended. Only `finished` and `failed` are the run's own doing;
 * the rest were asked from outside, and only `cancelled` means nothing was
 * changed: a run stopped, timed out or cut off ends `error`, never
 * `cancelled`, and is never run again by itself.
 */
export type CloudRunEnding<V = unknown> =
  | { kind: 'finished'; value: V }
  | { kind: 'failed'; message: string }
  /** Cancelled while it waited or planned — before any apply began. */
  | { kind: 'cancelled' }
  /** **Stop the run**, by the named caller. */
  | { kind: 'stopped'; by: string }
  /** Ended by the install-wide time limit. */
  | { kind: 'timed-out'; minutes: number }
  /**
   * Cloudgate shut down. `started: false` is a run that never left the queue:
   * its row stays `pending` and start-up queues it again.
   */
  | { kind: 'shutdown'; started: boolean };

/**
 * How a running run hears that it must end — `AbortSignal`-like, in two
 * steps. The tofu runner sends `tofu` one interrupt on the first and
 * kills it and its provider on the second; the pool sends the kill 5 minutes
 * after the interrupt if the run has not ended by then. A listener added
 * after its step fired is called at once.
 */
export interface CloudRunSignal {
  readonly interrupted: boolean;
  readonly killed: boolean;
  onInterrupt(listener: () => void): void;
  onKill(listener: () => void): void;
}

/** What the pool hands a running run. */
export interface CloudRunControl {
  readonly signal: CloudRunSignal;
  /**
   * The run is about to begin its apply. From here Cancel is refused and only
   * Stop the run (or the time limit) ends it. Answers `false` when the run has
   * already been asked to end, and the run must then not apply: this is the
   * one point where "cancelled means nothing changed" is decided.
   */
  beginApply(): boolean;
  /**
   * The run is waiting on something outside Cloudgate that is not its own
   * work: a hosted cloud build queued in its cloud's build service
   * (ADR-0047), which a fresh AWS account runs one at a time. Until the
   * returned release is called, the time limit stops counting; it then goes
   * on with what was left. Stop the run and Cancel still reach the run while
   * it holds. A second release, and a hold of a run whose time limit already
   * fired, change nothing.
   */
  holdTimeLimit(): () => void;
}

/** The work of one run: plan, then (unless a read) apply. */
export type CloudRunExecutor<V = unknown> = (
  job: CloudRunJob,
  control: CloudRunControl,
) => Promise<V>;

/** Where a run is, from the pool's side. */
export type CloudRunPhase = 'waiting' | 'planning' | 'applying';
