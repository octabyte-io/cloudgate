import type Docker from 'dockerode';
import { systemSettleClock } from '../../compose/compose.utils';
import {
  awaitConvergence,
  convergenceFailed,
  convergencePlan,
} from '../../deployment-engine/await-convergence';
import type { ConvergenceClock } from '../../deployment-engine/await-convergence';
import type {
  MechanizeOutcome,
  SwarmConfigSource,
} from '../../deployment-engine/mechanize';
import {
  currentGeneration,
  readSwarmTasks,
  readSwarmUpdateStatus,
  rolledBackGeneration,
  summarizeTasks,
} from '../../docker/swarm-service-health';
import type {
  SwarmTask,
  SwarmUpdateStatus,
} from '../../docker/swarm-service-health';

/**
 * What `convergeDatabaseService` did to the Swarm service, and the spec version
 * it wrote.
 *
 * `forceUpdate` is the `TaskTemplate.ForceUpdate` an update sent — the previous
 * one plus one — and it names this deploy's spec from here on: a task carrying
 * it is this deploy's, and a service no longer carrying it is a service Swarm
 * put back. Null on a create, which has no previous spec to go back to.
 */
export interface ConvergeResult {
  outcome: Extract<MechanizeOutcome, 'created' | 'updated'>;
  forceUpdate: number | null;
}

/**
 * How a database deploy ended. `confirmed: false` is a spent budget with no
 * observed failure: `done`, for the reason `awaitConvergence` gives — a failure
 * is never invented from a clock.
 */
export type DatabaseDeployVerdict =
  { failed: false; confirmed: boolean } | { failed: true; reason: string };

/**
 * The clock the verdict waits on and the deploy request bounds itself by. The
 * `SettleClock` shape, which is `ConvergenceClock`'s too; a provider only so a
 * suite can spend minutes in microseconds, as `DATABASE_VOLUME_RELEASE_CLOCK`
 * is for the volume wait.
 */
export const DATABASE_CONVERGENCE_CLOCK = 'DATABASE_CONVERGENCE_CLOCK';

/** {@link DATABASE_CONVERGENCE_CLOCK} bound to the system clock, as each of the
 * six engine modules provides it. */
export const convergenceClockProvider = {
  provide: DATABASE_CONVERGENCE_CLOCK,
  useValue: systemSettleClock,
};

/**
 * How long a deploy request may take before it answers `running` and leaves
 * the verdict to finish on its own.
 *
 * The console's `/backend` rewrite holds a response open for `proxyTimeout:
 * 240_000` (`frontend/next.config.ts`), and the verdict's own budget is up to
 * `CONVERGENCE_BUDGET_CAP_MS`, fifteen minutes. Two minutes, counted from the
 * start of the deploy so the pull is inside it, answers the common case in
 * the request — a rolled-back image is decided in about twenty seconds — and
 * leaves the proxy two more minutes of headroom for the pull that overran.
 */
export const DEPLOY_REQUEST_WAIT_MS = 120_000;

/**
 * Wait for Swarm to decide a database deploy, and say whether it took.
 *
 * `convergeDatabaseService` returns when Docker *accepts* the spec, and the
 * deploy used to write `done` right there — so a new image the data directory
 * refused (`redis:7` over a volume `redis:8` wrote) read `done` with `redis:7`
 * listed while Swarm, by the spec's own `FailureAction: 'rollback'`, had put
 * `redis:8` back. The wait is the Application's (`awaitConvergence`)
 * rather than a second copy of it; what this adds is the check
 * that wait cannot make on its own:
 *
 * - **Swarm put the previous spec back, whatever `UpdateStatus` says.** On
 *   PostgreSQL the live site answered `completed`, not `rollback_completed`,
 *   over a service back on its previous spec. `awaitConvergence` identifies the
 *   generation by the *service's* current `ForceUpdate`, which after that is
 *   the previous deploy's, so its still-running task read as converged. The
 *   counter this deploy *wrote* is the authority instead: a service carrying an
 *   older one is a service Swarm reverted. Older, not merely different — a
 *   newer one is a later deploy, whose own verdict decides.
 * - **A paused update is a failure.** `paused` / `rollback_paused` are
 *   `undecided` to the wait, which spends its budget on them; Swarm will not
 *   move on without an operator, so the deploy did not take.
 *
 * The reason is the rejected task's own `Status.Err` — Swarm's
 * "task: non-zero exit (1)" — read from the task history, since a rejected task
 * is desired `shutdown` once replaced. It is one clause, no closing
 * period (§2.5), because it becomes a 409's message.
 */
export async function awaitDatabaseDeploy(
  docker: Docker,
  serviceName: string,
  source: SwarmConfigSource,
  converged: ConvergeResult,
  options: { engineLabel: string; clock?: ConvergenceClock },
): Promise<DatabaseDeployVerdict> {
  const { engineLabel } = options;
  const outcome = await awaitConvergence(
    docker,
    serviceName,
    convergencePlan(source),
    converged.outcome,
    options.clock,
  );
  const after = await readSwarmUpdateStatus(docker, serviceName);

  const reverted =
    outcome.state === 'rolled-back' ||
    (converged.outcome === 'updated' &&
      converged.forceUpdate !== null &&
      after.forceUpdate !== null &&
      after.forceUpdate < converged.forceUpdate);

  if (!reverted && !after.paused && !convergenceFailed(outcome)) {
    return { failed: false, confirmed: outcome.state === 'converged' };
  }

  const taskError =
    ('lastError' in outcome ? outcome.lastError : null) ??
    (await rejectedTaskError(docker, serviceName, converged, after, reverted));
  const said = taskError ? ` — the new task said: ${taskError}` : '';
  const prefix = `The ${engineLabel} deploy of ${serviceName} did not take`;

  if (reverted) {
    const running = after.image ?? 'its previous image';
    return {
      failed: true,
      reason: `${prefix} — Swarm rolled it back to its previous spec, so it is still running ${running} with the settings it had before${said}`,
    };
  }
  if (after.paused) {
    const swarmSaid = after.message ? ` (${after.message})` : '';
    return {
      failed: true,
      reason: `${prefix} — Swarm paused the update part-way${swarmSaid} and will not continue or undo it on its own${said}`,
    };
  }
  return {
    failed: true,
    reason: `${prefix} — every task Swarm started for it failed${said}`,
  };
}

/** The error on a task of this deploy's spec, from the whole task history. */
async function rejectedTaskError(
  docker: Docker,
  serviceName: string,
  converged: ConvergeResult,
  after: SwarmUpdateStatus,
  reverted: boolean,
): Promise<string | null> {
  let history: SwarmTask[];
  try {
    history = await readSwarmTasks(docker, serviceName, 'any');
  } catch {
    return null;
  }
  const tasks = reverted
    ? rolledBackGeneration(history, after.startedAt, after.forceUpdate)
    : currentGeneration(history, after.startedAt, converged.forceUpdate);
  return summarizeTasks(tasks).lastError;
}
