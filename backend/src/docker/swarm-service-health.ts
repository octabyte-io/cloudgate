import type Docker from 'dockerode';

/**
 * The shape of a Swarm task these reads touch. Deliberately partial: `/tasks`
 * returns a large document and everything below is decided by three fields.
 */
export interface SwarmTask {
  /**
   * RFC3339Nano, written by the Swarm store. Only `currentGeneration` reads it,
   * and the generation boundary it is compared against — `UpdateStatus.StartedAt`
   * — comes out of the same store, so no client clock enters this.
   */
  CreatedAt?: string;
  /**
   * The task's copy of the service's `TaskTemplate` at the moment it was
   * created. Only `ForceUpdate` is read: `mechanizeDockerContainer` bumps it on
   * every release, so it is the release's own spec version, and Swarm's
   * updater replaces a task exactly when its spec — this counter included —
   * differs from the service's.
   */
  Spec?: { ForceUpdate?: number };
  Status?: { State?: string; Err?: string; Timestamp?: string };
}

/**
 * What a read of a Swarm service found. Four fields and the middle two are the
 * reason this is not a boolean: `docker service create` returning makes the
 * service object inspectable for ever, whether or not a single task ever came
 * up, so "the service exists" and "a replica is answering" are different
 * questions and only the second one means the service can serve a request.
 */
export interface SwarmServiceHealth {
  /** The Swarm service object exists. Says nothing about replicas. */
  deployed: boolean;
  /** Tasks desired running that are actually in state `running`. */
  running: number;
  /** Replicas the service spec asks for; 1 for a non-replicated mode. */
  wanted: number;
  /**
   * The most recent `Status.Err` any task carries — the workload's own failure
   * verbatim ("task: non-zero exit (1)"), which is the most useful sentence
   * available when a service is deployed and nothing is running.
   */
  lastError: string | null;
  /** The newest task's `Status.State`, for a caller with no error to show. */
  lastState: string | null;
}

/**
 * The inspect-replicas-then-count-tasks read, in one place.
 *
 * It had drifted into two copies — `settings/infra-health.service.ts` and
 * `enterprise/forward-auth/forward-auth-proxy.service.ts` — that agreed on the
 * mechanism and disagreed on the details: one treated an absent `Replicas` as
 * zero replicas configured (which is what a *global* service looks like, and it
 * is not a fault), the other as one. The Update phase's convergence poll
 * would have been
 * the third copy, which is §1.4's violation, so the pair was extracted here
 * instead. The forward-auth reading of an absent `Replicas` won: a global
 * service wants one task per Server, not none.
 *
 * `lastTaskError`'s rule travels with it, because it is the half most likely to
 * be reinvented wrongly: `/tasks` promises no ordering, so the timestamps decide
 * which task is the newest and not the array's own order.
 */
export async function readSwarmServiceHealth(
  docker: Docker,
  serviceName: string,
): Promise<SwarmServiceHealth> {
  let wanted: number;
  try {
    const service = (await docker.getService(serviceName).inspect()) as {
      Spec?: { Mode?: { Replicated?: { Replicas?: number } } };
    };
    // A global service has no Replicas; one task per Server is what it wants.
    wanted = service.Spec?.Mode?.Replicated?.Replicas ?? 1;
  } catch {
    return {
      deployed: false,
      running: 0,
      wanted: 0,
      lastError: null,
      lastState: null,
    };
  }

  const tasks = await readSwarmTasks(docker, serviceName);
  const { running, lastError, lastState } = summarizeTasks(tasks);
  return {
    deployed: true,
    running,
    wanted,
    // A service with something running has nothing to apologise for, even if
    // an older task in the same generation died on its way there.
    lastError: running > 0 ? null : lastError,
    lastState,
  };
}

/**
 * The tasks Swarm currently wants running for a service — the only place a
 * Swarm service admits that its every task exits 1.
 *
 * Exported on its own for the convergence poll, which already knows what it
 * asked for (it just wrote the spec) and would otherwise pay for an inspect per
 * poll to read a number back that it authored.
 */
export async function readSwarmTasks(
  docker: Docker,
  serviceName: string,
  /**
   * `'any'` drops the desired-state filter, for the one reader that needs a
   * task Swarm has already replaced: a rejected or failed task is desired
   * `shutdown` once its replacement exists, so after a rollback the task that
   * says *why* is not in the desired-running read at all. Swarm keeps a
   * few per slot (`TaskHistoryRetentionLimit`), which is what bounds this.
   */
  desiredState: 'running' | 'any' = 'running',
): Promise<SwarmTask[]> {
  return (await docker.listTasks({
    filters: JSON.stringify(
      desiredState === 'any'
        ? { service: [serviceName] }
        : { service: [serviceName], 'desired-state': ['running'] },
    ),
  })) as SwarmTask[];
}

/**
 * Whether Swarm has *decided* the update it is running, and when it started.
 *
 * `none` is a first deploy — `UpdateStatus` is unpopulated by design, which is
 * why the poll counts tasks at all. `undecided` covers `updating`, `paused` and
 * any state a future daemon invents: the poll may not report convergence in it,
 * because with the default `Order: 'start-first'` the *previous* generation is
 * still running and still desired-running and would satisfy `isConverged` on
 * iteration 0. `unreadable` is an inspect the daemon refused — treated as
 * `undecided` on an update, deliberately, because on an update this is no longer
 * a second signal but the generation boundary itself, and losing it must not be
 * allowed to manufacture a `converged`.
 */
export type SwarmUpdateDecision =
  'none' | 'undecided' | 'completed' | 'rolled-back' | 'unreadable';

export interface SwarmUpdateStatus {
  decision: SwarmUpdateDecision;
  /** When Swarm started the update it is reporting; null unless it is running
   * or has run one. */
  startedAt: string | null;
  /**
   * The service spec's `TaskTemplate.ForceUpdate` — the spec version of what
   * the service is *now* set to run. That is the release's own on an update
   * in flight or completed, and the previous one again once Swarm has rolled
   * back. Null when the daemon did not say.
   */
  forceUpdate: number | null;
  /**
   * Swarm stopped part-way and waits for an operator: `paused` or
   * `rollback_paused`. Still `undecided` to the poll, which must not answer
   * off it; a caller deciding what an *ended* wait means reads it.
   */
  paused: boolean;
  /** Swarm's own `UpdateStatus.Message`, trimmed; null when it wrote none. */
  message: string | null;
  /**
   * The image the service spec now names, the digest the daemon pinned
   * (`redis:8@sha256:…`) dropped — the half an operator typed. After a
   * rollback it is the image still serving.
   */
  image: string | null;
}

export async function readSwarmUpdateStatus(
  docker: Docker,
  serviceName: string,
): Promise<SwarmUpdateStatus> {
  let status:
    { State?: string; StartedAt?: string; Message?: string } | undefined;
  let forceUpdate: number | null;
  let image: string | null;
  try {
    const info = (await docker.getService(serviceName).inspect()) as {
      Spec?: {
        TaskTemplate?: {
          ForceUpdate?: number;
          ContainerSpec?: { Image?: string };
        };
      };
      UpdateStatus?: { State?: string; StartedAt?: string; Message?: string };
    };
    status = info.UpdateStatus;
    forceUpdate = specVersion(info.Spec?.TaskTemplate?.ForceUpdate);
    image =
      info.Spec?.TaskTemplate?.ContainerSpec?.Image?.split('@')[0] || null;
  } catch {
    return {
      decision: 'unreadable',
      startedAt: null,
      forceUpdate: null,
      paused: false,
      message: null,
      image: null,
    };
  }

  const read = {
    startedAt: status?.StartedAt ?? null,
    forceUpdate,
    paused: status?.State === 'paused' || status?.State === 'rollback_paused',
    message: status?.Message?.trim() || null,
    image,
  };
  switch (status?.State) {
    case undefined:
      return { decision: 'none', ...read };
    case 'completed':
      return { decision: 'completed', ...read };
    case 'rollback_started':
    case 'rollback_completed':
      return { decision: 'rolled-back', ...read };
    default:
      // `updating`, `paused`, `rollback_paused`, and anything unknown.
      return { decision: 'undecided', ...read };
  }
}

const specVersion = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * The tasks belonging to the generation this release created.
 *
 * **The spec version decides first.** A task whose `Spec.ForceUpdate` is known
 * belongs to this release exactly when it equals `forceUpdate`, the counter
 * the release wrote. Timestamps got this wrong both ways: on a scale-up Swarm's
 * orchestrator creates the added slot's task in the same instant the updater
 * starts, and it can land a few milliseconds *before* `StartedAt` — so a
 * `CreatedAt >= StartedAt` filter never counted it and a 1 → 2 deploy waited
 * out its whole budget on a service that was 2/2 in two seconds; and a
 * previous-spec task restarted mid-update is created *after* `StartedAt`. The
 * start-first update's still-running previous task carries the previous
 * counter, so the start-first exclusion holds by construction, not by a clock.
 *
 * **The timestamp is the fallback**, for a task or a service whose counter the
 * daemon did not report. `CreatedAt` and `StartedAt` both come out of the Swarm
 * store, so this is a comparison of two of the daemon's own timestamps. **`Date.parse`, not a string
 * compare**: RFC3339Nano emits a variable number of fractional digits, so
 * `…03.94Z` sorts *after* `…03.940123456Z` lexicographically. The millisecond
 * truncation `Date.parse` costs is harmless against a `>=`.
 *
 * A task with an absent or unparseable `CreatedAt` is **excluded**, not
 * included: a task the daemon will not date cannot be shown to belong to this
 * release, and including it is the direction that manufactures a false
 * `converged`.
 */
export function currentGeneration(
  tasks: SwarmTask[],
  startedAt: string | null,
  forceUpdate: number | null = null,
): SwarmTask[] {
  const createdSince = createdSinceBoundary(startedAt);
  return tasks.filter((task) => {
    const version = specVersion(task.Spec?.ForceUpdate);
    return forceUpdate !== null && version !== null
      ? version === forceUpdate
      : createdSince(task);
  });
}

/**
 * How far before `StartedAt` a task of the same update can be created. The
 * rejected task of a live rollback was created **2 ms before** its update's
 * `StartedAt` (the first case in `rolledBackGeneration`'s spec), and the
 * same skew was measured on a scale-up. A second is ample room for that,
 * and still far short of the gap to the Deployment before, which had a build
 * and a convergence wait in between.
 */
const SAME_UPDATE_SLACK_MS = 1_000;

/**
 * The tasks of the release Swarm rolled back — where the reason it did not take
 * is to be found.
 *
 * Once Swarm rolls back, the service spec is the previous one again, so
 * `forceUpdate` here is the *serving* counter, and a task of the release that
 * did not take carries a newer one **and** was created with this update — at
 * or after its `StartedAt`, less {@link SAME_UPDATE_SLACK_MS}. Both, not
 * either: the counter alone cannot tell two failed releases apart, because
 * `mechanizeDockerContainer` bumps from the live spec and a rollback puts that
 * back, so a release after a rolled-back one writes the *same* counter again.
 * Under a union the earlier release's failed tasks, still in the task history,
 * answered for this one. The timestamp is what separates them.
 *
 * **Why not make the counter unique instead.** Bumping past the previous spec
 * as well as the live one was the alternative, and it does not hold: Swarm's
 * automatic rollback clears `PreviousSpec` as it restores `Spec`, so after one
 * there is nothing left to bump past.
 *
 * A fact the daemon did not report — a task with no `Spec`, a service whose
 * counter was unreadable — excludes nothing, so a missing counter leaves the
 * timestamp rule alone. If the two together keep nothing, the union is used
 * instead: this only ever chooses which sentence to show, never whether
 * anything converged, and a wider net beats none should a daemon ever stamp
 * `StartedAt` at the rollback rather than the update. It is deliberately
 * *empty* that widens, not "carries no error": a release whose own tasks carry
 * no `Err` shows none, rather than an earlier release's.
 */
export function rolledBackGeneration(
  tasks: SwarmTask[],
  startedAt: string | null,
  forceUpdate: number | null,
): SwarmTask[] {
  const createdWith = createdSinceBoundary(startedAt, SAME_UPDATE_SLACK_MS);
  const newerSpec = (task: SwarmTask): boolean | null => {
    const version = specVersion(task.Spec?.ForceUpdate);
    return forceUpdate === null || version === null
      ? null
      : version > forceUpdate;
  };
  const both = tasks.filter(
    (task) => newerSpec(task) !== false && createdWith(task),
  );
  if (both.length > 0) return both;
  return tasks.filter((task) => newerSpec(task) === true || createdWith(task));
}

/** A daemon timestamp as milliseconds, for ordering; unparseable sorts last. */
const timestampMs = (timestamp: string | undefined): number => {
  const parsed = timestamp ? Date.parse(timestamp) : NaN;
  return Number.isNaN(parsed) ? -Infinity : parsed;
};

/** The start-first timestamp rule, `slackMs` early: with no parseable boundary,
 * everything is in. */
function createdSinceBoundary(
  startedAt: string | null,
  slackMs = 0,
): (task: SwarmTask) => boolean {
  const boundary = (startedAt ? Date.parse(startedAt) : NaN) - slackMs;
  if (Number.isNaN(boundary)) return () => true;
  return (task) => {
    const createdAt = task.CreatedAt ? Date.parse(task.CreatedAt) : NaN;
    return Number.isNaN(createdAt) ? false : createdAt >= boundary;
  };
}

/** The three numbers every caller of `readSwarmTasks` then computes. */
export function summarizeTasks(tasks: SwarmTask[]): {
  running: number;
  lastError: string | null;
  lastState: string | null;
} {
  const running = tasks.filter(
    (task) => task.Status?.State === 'running',
  ).length;
  // `/tasks` promises no ordering, so the timestamps decide — parsed, not
  // string-compared, for the variable-length fraction `currentGeneration`
  // describes.
  const byNewest = [...tasks].sort(
    (a, b) =>
      timestampMs(b.Status?.Timestamp) - timestampMs(a.Status?.Timestamp),
  );
  // The newest *error*, not the newest task's: after a rollback the newest
  // task is the healthy replacement, which carries no `Err`, and reading it
  // lost the rejection that was the only sentence saying why. No task
  // with an `Err` at all yields null rather than an empty sentence.
  const lastError =
    byNewest.map((task) => task.Status?.Err?.trim()).find(Boolean) ?? null;
  return {
    running,
    lastError,
    lastState: byNewest[0]?.Status?.State ?? null,
  };
}

/**
 * Whether a service is at its replica count.
 *
 * **`>=`, never `===`.** The default `UpdateConfig` is `Order: 'start-first'`
 * (`deployment-engine/mechanize.ts`), so during a healthy rolling update the new
 * task is running before the old one is torn down and the count legitimately
 * exceeds what the spec asks for. An equality test here reads that healthy
 * moment as "not there yet".
 *
 * The overshoot described above is what **`readSwarmServiceHealth`** observes,
 * and it is no longer what `awaitConvergence` reads: the poll passes
 * a single generation's tasks in on an update, so the `>=` is not dead code
 * there either — a replaced task inside one generation can still briefly exceed
 * the count — but the two-generation overshoot belongs to the health read alone.
 */
export function isConverged(counts: {
  running: number;
  wanted: number;
}): boolean {
  return counts.wanted > 0 && counts.running >= counts.wanted;
}
