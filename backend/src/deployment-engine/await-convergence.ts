import type Docker from 'dockerode';
import {
  currentGeneration,
  isConverged,
  readSwarmTasks,
  readSwarmUpdateStatus,
  rolledBackGeneration,
  summarizeTasks,
} from '../docker/swarm-service-health';
import { generateConfigContainer } from './mechanize';
import type { MechanizeOutcome, SwarmConfigSource } from './mechanize';

/**
 * How often the poll asks. Frequent enough that the log line lands while
 * somebody is still watching it, cheap enough against a Docker socket, and no
 * tighter than the granularity of a container starting.
 */
export const CONVERGENCE_POLL_MS = 2_000;

/** The part of the wait that is not derived from anything: image pull, task
 * scheduling, and the seconds Swarm takes to notice the spec at all. */
export const CONVERGENCE_BUDGET_FLOOR_MS = 60_000;

/** What one batch of task starts is assumed to cost when the spec carries no
 * health check to derive it from. */
export const CONVERGENCE_UNSET_HEALTH_CHECK_MS = 30_000;

/**
 * The ceiling on the whole wait.
 *
 * The number is chosen against Cloudgate, not against Docker.
 * `buildsConcurrency` defaults to **1 per Server**
 * (`deployment-queue/builds-concurrency.provider.ts`), and this poll runs inside
 * that slot — so the cap is also the longest a single pathological spec can
 * block *every other* Deployment to the same Server. Fifteen minutes is the
 * most that seemed defensible to make an unrelated Deployment wait for someone
 * else's arbitrary `StartPeriod`.
 */
export const CONVERGENCE_BUDGET_CAP_MS = 15 * 60_000;

/** What the poll is waiting for, and for how long. */
export interface ConvergencePlan {
  /** Tasks the spec asks for; 1 for a mode with no replica count. */
  wanted: number;
  budgetMs: number;
}

/**
 * The clock, as a seam. A test that exhausts fifteen minutes has to be able to
 * do it in microseconds, and the alternative — fake timers around a loop that
 * awaits a Docker call between every sleep — is the arrangement that produces
 * suites which hang instead of failing.
 */
export interface ConvergenceClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const systemClock: ConvergenceClock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

/**
 * How the wait ended. Three outcomes, because the Deployment says three
 * different things and only two of them are the same status.
 *
 * - `converged` — the tasks are running. `done`.
 * - `rolled-back` — Swarm said the release did not take and put the previous
 *   one back. An *observation*, needing no timeout, and `error`. **Reachable on
 *   an update with the shipped default `Order: 'start-first'`, and
 *   it was not before**: the poll used to answer `converged` off the previous
 *   generation's still-running task on iteration 0, so this arm — and with it
 *   the only `error` this poll can produce — could never fire on the shipped
 *   configuration. The next reader needs to know which of the two facts is
 *   current; this one is.
 * - `unconfirmed` — the budget was spent with neither. `error` only when
 *   `everyTaskFailed`, which is also an observation; otherwise `done`, because
 *   **a failure is never invented from a clock**. A slow Deployment that is
 *   perfectly fine must not fire `notifier.buildError` at people.
 */
export type ConvergenceOutcome =
  | {
      state: 'converged';
      running: number;
      wanted: number;
      elapsedMs: number;
    }
  | {
      state: 'rolled-back';
      running: number;
      wanted: number;
      elapsedMs: number;
      lastError: string | null;
    }
  | {
      state: 'unconfirmed';
      running: number;
      wanted: number;
      elapsedMs: number;
      lastError: string | null;
      /** Every task in the new generation carries an `Err` — an observed
       * failure rather than a spent stopwatch. */
      everyTaskFailed: boolean;
    };

/**
 * The wait, derived from the spec the release is about to apply rather than
 * from a constant — because no constant is correct for an arbitrary spec.
 * `healthCheckSwarm` carries whatever `StartPeriod` the operator chose, and the
 * default `UpdateConfig` is `Parallelism: 1`, so an N-replica Service converges
 * N task starts serially:
 *
 * ```
 * 60s + ceil(replicas / Parallelism) × (StartPeriod + Interval × Retries, or 30s)
 * ```
 *
 * capped at `CONVERGENCE_BUDGET_CAP_MS`. Health-check durations are
 * **nanoseconds** — that is how the Docker API takes every duration, and how
 * the console's swarm cards store them — so they are divided down here.
 */
export function convergencePlan(
  application: SwarmConfigSource,
): ConvergencePlan {
  const spec = generateConfigContainer(application);
  const wanted = spec.Mode?.Replicated?.Replicas ?? 1;

  // Docker reads `Parallelism: 0` as "every task at once", which is one batch.
  const parallelism = spec.UpdateConfig?.Parallelism || wanted || 1;
  const batches = Math.max(1, Math.ceil(wanted / parallelism));

  const health = spec.HealthCheck;
  const perBatchNs =
    (health?.StartPeriod ?? 0) +
    (health?.Interval ?? 0) * (health?.Retries ?? 0);
  const perBatchMs =
    perBatchNs > 0 ? perBatchNs / 1_000_000 : CONVERGENCE_UNSET_HEALTH_CHECK_MS;

  return {
    wanted,
    budgetMs: Math.min(
      CONVERGENCE_BUDGET_CAP_MS,
      Math.round(CONVERGENCE_BUDGET_FLOOR_MS + batches * perBatchMs),
    ),
  };
}

/**
 * Wait for a released Swarm service's tasks to be running, or for the budget to
 * run out saying so.
 *
 * **This lives beside `mechanizeDockerContainer`, not inside it.** That function
 * returns when the Docker API *accepts* the spec, and its docblock says no
 * caller may report convergence on the strength of that resolving; handing it a
 * log writer so it could report convergence itself would make a pure converge
 * call depend on the engine's file layout, which is an alternative already
 * rejected. So the caller keeps the deployment log and the status call, and this
 * returns an outcome.
 *
 * What it does with `UpdateStatus`, and what it deliberately does not do:
 *
 * - **`UpdateStatus` is the gate on an update and a second signal on a create.**
 *   The field is only populated for an *update*, and `mechanizeDockerContainer`
 *   returns `'created'` on a first deploy — a poll waiting on `UpdateStatus`
 *   would never terminate there, so on a `created` release it stays best-effort
 *   and a daemon that will not answer the inspect costs nothing. On an
 *   `updated` release it is the opposite: it is the authority on whether Swarm
 *   has decided anything yet, and until it has, this may not report
 *   convergence, because with `Order: 'start-first'` the previous generation is
 *   still running and still desired-running and satisfies `isConverged` on
 *   iteration 0. A refused inspect on an update therefore ends
 *   `unconfirmed`, never `converged` — which `convergenceFailed` leaves as
 *   `done` with a ⚠️ line, so losing the signal degrades to "convergence was
 *   not confirmed" and never to an invented failure.
 * - **It does not fail on the first task `Err`.** The default `UpdateConfig` is
 *   `FailureAction: 'rollback'`, so a healthy rollback produces failed tasks on
 *   its way back to a working state, and a task that crashes once and restarts
 *   produces one too. Failing fast would report a successful rollback as a
 *   failed Deployment. The cost is that a genuinely broken image burns the whole
 *   budget, which is the cheaper mistake.
 *
 * `rollbacks.service.ts` is the other caller of `mechanizeDockerContainer` and
 * wants exactly this wait; it is not wired here (out of scope), but nothing in the
 * signature assumes a Deployment, so it can adopt it as it stands — and when it
 * does it must pass `'updated'`, since a rollback is by definition an update.
 */
export async function awaitConvergence(
  docker: Docker,
  serviceName: string,
  plan: ConvergencePlan,
  released: MechanizeOutcome,
  clock: ConvergenceClock = systemClock,
): Promise<ConvergenceOutcome> {
  // A Service scaled to zero has converged the moment it is accepted: no task
  // is wanted, so no task will ever appear to confirm one. `isConverged` says
  // false for it — correctly, since it also answers "can this serve a request".
  if (plan.wanted <= 0) {
    return {
      state: 'converged',
      running: 0,
      wanted: plan.wanted,
      elapsedMs: 0,
    };
  }

  const startedAt = clock.now();
  for (;;) {
    // The update status first: a rollback is an *observation* and needs no
    // budget, and on an update it is also what says whether the reading below
    // is allowed to answer at all.
    const update = await readSwarmUpdateStatus(docker, serviceName);
    const all = await readSwarmTasks(docker, serviceName);
    // By the spec version the release wrote, falling back to the
    // `StartedAt` boundary only where the daemon did not report one.
    const tasks =
      released === 'updated'
        ? currentGeneration(all, update.startedAt, update.forceUpdate)
        : all;
    const { running, lastError } = summarizeTasks(tasks);
    const elapsedMs = clock.now() - startedAt;

    if (update.decision === 'rolled-back') {
      // The reason is on a task Swarm has already replaced — desired
      // `shutdown`, so absent from the read above — and the spec is the
      // previous one again, so the generation above is the wrong one to ask.
      // One more read, once, on the way out.
      const history = await readSwarmTasks(docker, serviceName, 'any');
      return {
        state: 'rolled-back',
        running,
        wanted: plan.wanted,
        elapsedMs,
        lastError:
          summarizeTasks(
            rolledBackGeneration(history, update.startedAt, update.forceUpdate),
          ).lastError ?? lastError,
      };
    }

    // With the default `Order: 'start-first'` the previous generation is
    // still running and still desired-running while Swarm is deciding, so
    // `isConverged` passes on iteration 0 and an update Swarm is two seconds
    // from rolling back was recorded `done`. An `updated` release may only
    // report convergence once Swarm has said the update is decided.
    //
    // `'none'` is in on purpose: a daemon that reports no `UpdateStatus` at all
    // for a service we just updated has told us nothing about a previous
    // generation either, and the pre-convergence behaviour is the honest floor there.
    // `'unreadable'` and `'undecided'` are not, so both keep polling and end
    // `unconfirmed` rather than inventing either answer.
    const mayReportConvergence =
      released === 'created' ||
      update.decision === 'completed' ||
      update.decision === 'none';

    if (mayReportConvergence && isConverged({ running, wanted: plan.wanted })) {
      return { state: 'converged', running, wanted: plan.wanted, elapsedMs };
    }

    if (elapsedMs >= plan.budgetMs) {
      return {
        state: 'unconfirmed',
        running,
        wanted: plan.wanted,
        elapsedMs,
        lastError,
        everyTaskFailed:
          tasks.length > 0 &&
          tasks.every((task) => Boolean(task.Status?.Err?.trim())),
      };
    }

    await clock.sleep(Math.min(CONVERGENCE_POLL_MS, plan.budgetMs - elapsedMs));
  }
}

/**
 * Whether the Deployment failed. Only the two *observed* failures count: Swarm
 * rolling the release back, and a spent budget in which every task in the new
 * generation carries an error. A bare spent budget is `done` — see
 * `ConvergenceOutcome`.
 */
export function convergenceFailed(outcome: ConvergenceOutcome): boolean {
  return (
    outcome.state === 'rolled-back' ||
    (outcome.state === 'unconfirmed' && outcome.everyTaskFailed)
  );
}

/**
 * What happened to the image before the release, for the one sentence that
 * says so. `built` is false for a docker-sourced Application, which pulls
 * rather than builds; `pushed` is whether a Registry was used at all — on the
 * default single-box install nothing is pushed, and the line said it was.
 * A pulled image is never pushed, so `pushed` is read only
 * beside `built`.
 */
export interface ReleasedImage {
  built: boolean;
  pushed: boolean;
}

const imageSentence = ({ built, pushed }: ReleasedImage): string => {
  if (built) return pushed ? 'The image built and pushed' : 'The image built';
  return 'The image was pulled';
};

/**
 * The one line the Update phase writes about how the wait ended.
 *
 * Three sentences for three outcomes, and the middle one is the whole point of
 * the build/release distinction the console's Phases card draws: the image got
 * as far as it did, and what is serving is the release before this one. The `⚠️`
 * sentence never says "failed" — the Deployment it describes may be perfectly
 * fine and merely slower than a budget nobody could have picked correctly.
 */
export function convergenceLogLine(
  serviceName: string,
  released: MechanizeOutcome,
  outcome: ConvergenceOutcome,
  image: ReleasedImage,
): string {
  switch (outcome.state) {
    case 'converged':
      return `✅ Swarm service '${serviceName}' ${released}; ${outcome.running} of ${outcome.wanted} tasks running.`;
    case 'rolled-back':
      return withTaskError(
        `❌ Swarm service '${serviceName}' did not take: Swarm rolled it back to its previous spec. ${imageSentence(image)}; what is serving is the Deployment before this one.`,
        outcome.lastError,
      );
    case 'unconfirmed':
      return withTaskError(
        `⚠️ Swarm service '${serviceName}' ${released}; ${outcome.running} of ${outcome.wanted} tasks running after ${Math.round(outcome.elapsedMs / 1000)}s. Convergence was not confirmed.`,
        outcome.lastError,
      );
  }
}

const withTaskError = (line: string, lastError: string | null): string =>
  lastError ? `${line} ${lastError}` : line;
