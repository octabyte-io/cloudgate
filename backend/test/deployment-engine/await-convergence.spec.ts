import type Docker from 'dockerode';
import {
  awaitConvergence,
  CONVERGENCE_BUDGET_CAP_MS,
  CONVERGENCE_POLL_MS,
  convergenceFailed,
  convergenceLogLine,
  convergencePlan,
} from '../../src/deployment-engine/await-convergence';
import type { ConvergenceClock } from '../../src/deployment-engine/await-convergence';
import { makeApp } from './application.fixture';

type Task = {
  CreatedAt?: string;
  Spec?: { ForceUpdate?: number };
  Status?: { State?: string; Err?: string; Timestamp?: string };
};

const running = (timestamp = '2026-08-24T00:00:00Z'): Task => ({
  Status: { State: 'running', Timestamp: timestamp },
});
const failed = (err: string, timestamp = '2026-08-24T00:00:00Z'): Task => ({
  Status: { State: 'failed', Err: err, Timestamp: timestamp },
});
/**
 * Dates a task, which is the only way a test can put it either side of the
 * generation boundary `UpdateStatus.StartedAt` draws. Both timestamps
 * come out of the Swarm store on a real daemon, so a test that fakes one has to
 * fake the other in the same units.
 */
const generation = (task: Task, createdAt: string): Task => ({
  ...task,
  CreatedAt: createdAt,
});
/** Stamps the spec version a task was created from — the `ForceUpdate`
 * `mechanizeDockerContainer` bumps on every release. */
const version = (task: Task, forceUpdate: number): Task => ({
  ...task,
  Spec: { ForceUpdate: forceUpdate },
});

/**
 * A daemon that answers a scripted sequence: the nth poll gets `reads[n]`, and
 * the last entry repeats for ever so a test can describe a service that simply
 * never gets there. `updateStates` is `UpdateStatus.State` on the service
 * object, deliberately allowed to be absent — which is what a first deploy
 * looks like — and `startedAt` is the same document's `StartedAt`, which is
 * now the generation boundary rather than decoration.
 *
 * **The inspect runs first in each iteration and the read second**, which is the
 * order `awaitConvergence` asks in, so `inspect` reads one index *ahead* of the
 * counter `listTasks` bumps. Both therefore answer for the same iteration.
 */
const makeDocker = (
  reads: Task[][],
  updateStates: (string | null)[] = [],
  startedAt: string | null = null,
  extra: {
    /** `Spec.TaskTemplate.ForceUpdate` on the service object. */
    forceUpdate?: number;
    /** What a read with no desired-state filter returns — every task Swarm
     * still remembers, including the rejected ones it has since replaced.
     * Absent, that read answers like the desired-running one. */
    history?: Task[];
  } = {},
) => {
  let poll = -1;
  const at = <T>(rows: T[], index: number): T | undefined =>
    rows.length === 0
      ? undefined
      : (rows[Math.min(index, rows.length - 1)] ?? undefined);
  const listTasks = jest.fn((options: { filters: string }) => {
    const filters = JSON.parse(options.filters) as Record<string, unknown>;
    // The history read is an extra one inside an iteration, so it does not
    // advance the poll the inspect is keyed to.
    if (!('desired-state' in filters)) {
      return Promise.resolve(extra.history ?? at(reads, poll) ?? []);
    }
    poll += 1;
    return Promise.resolve(at(reads, poll) ?? []);
  });
  const inspect = jest.fn(() => {
    const state = at(updateStates, poll + 1);
    return Promise.resolve({
      ...(extra.forceUpdate === undefined
        ? {}
        : { Spec: { TaskTemplate: { ForceUpdate: extra.forceUpdate } } }),
      ...(state
        ? {
            UpdateStatus: {
              State: state,
              ...(startedAt === null ? {} : { StartedAt: startedAt }),
            },
          }
        : {}),
    });
  });
  return {
    docker: {
      listTasks,
      getService: jest.fn(() => ({ inspect })),
    } as unknown as Docker,
    listTasks,
    inspect,
  };
};

/** A clock that spends its budget by being asked to sleep, so a test that
 * exhausts fifteen minutes still runs in microseconds. */
const makeClock = (): ConvergenceClock & { elapsed: () => number } => {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
    elapsed: () => t,
  };
};

describe('convergencePlan', () => {
  it('derives the wait from the spec rather than a constant', () => {
    // One replica, no health check: the 60s floor plus one 30s task start.
    expect(convergencePlan(makeApp())).toEqual({
      wanted: 1,
      budgetMs: 90_000,
    });
  });

  it('serializes the wait over the batches Parallelism actually allows', () => {
    // Six replicas two at a time is three batches, not one and not six.
    const plan = convergencePlan(
      makeApp({
        replicas: 6,
        updateConfigSwarm: { Parallelism: 2, Order: 'start-first' },
      }),
    );
    expect(plan.wanted).toBe(6);
    expect(plan.budgetMs).toBe(60_000 + 3 * 30_000);
  });

  it('spends the health check the operator actually asked for', () => {
    // Nanoseconds, as everywhere the Docker API takes a duration: a 20s start
    // period plus five 4s intervals is 40s for the one replica's batch.
    const plan = convergencePlan(
      makeApp({
        healthCheckSwarm: {
          StartPeriod: 20_000_000_000,
          Interval: 4_000_000_000,
          Retries: 5,
        },
      }),
    );
    expect(plan.budgetMs).toBe(60_000 + 40_000);
  });

  it('caps a pathological spec, because the cap also blocks the Server', () => {
    const plan = convergencePlan(
      makeApp({
        replicas: 50,
        healthCheckSwarm: { StartPeriod: 600_000_000_000 },
      }),
    );
    expect(plan.budgetMs).toBe(CONVERGENCE_BUDGET_CAP_MS);
  });
});

describe('awaitConvergence', () => {
  it('reports the tasks running once they are', async () => {
    const { docker } = makeDocker([[], [running()]]);
    const clock = makeClock();

    const outcome = await awaitConvergence(
      docker,
      'shop-api-x1',
      { wanted: 1, budgetMs: 90_000 },
      'created',
      clock,
    );

    expect(outcome).toEqual({
      state: 'converged',
      running: 1,
      wanted: 1,
      elapsedMs: CONVERGENCE_POLL_MS,
    });
  });

  /**
   * The trap the whole design turns on. `Order: 'start-first'` is the default
   * `UpdateConfig` (`mechanize.ts`), so during a healthy rolling update the new
   * task is up before the old one is torn down and the count legitimately
   * *exceeds* the replica count. A `===` here waits out the entire budget on a
   * deploy that worked.
   */
  it('accepts the start-first overshoot instead of waiting out the budget', async () => {
    const { docker } = makeDocker([[running('1'), running('2'), running('3')]]);
    const clock = makeClock();

    const outcome = await awaitConvergence(
      docker,
      'shop-api-x1',
      { wanted: 2, budgetMs: 90_000 },
      'created',
      clock,
    );

    expect(outcome.state).toBe('converged');
    expect(outcome.running).toBe(3);
    // Nothing slept: the very first read already answered the question.
    expect(clock.elapsed()).toBe(0);
  });

  /**
   * The same overshoot on an **update**, which is the half the generation fix found. The
   * three running tasks are exactly what the previous generation looks like
   * while Swarm is still deciding, and answering `converged` off them recorded
   * a Deployment `done` seconds before Swarm rolled it back.
   *
   * Nothing here is dated and `StartedAt` is absent, so the generation filter
   * is a no-op and **the gate is the only thing under test**: revert the
   * `mayReportConvergence` clause and this returns `converged` at t=0 again.
   */
  it('refuses to call an update converged while Swarm is still deciding', async () => {
    const { docker } = makeDocker(
      [[running('1'), running('2'), running('3')]],
      ['updating'],
    );
    const clock = makeClock();

    const outcome = await awaitConvergence(
      docker,
      'shop-api-x1',
      { wanted: 2, budgetMs: 10_000 },
      'updated',
      clock,
    );

    expect(outcome.state).toBe('unconfirmed');
    expect(convergenceFailed(outcome)).toBe(false);
  });

  it('calls a service with nothing wanted converged rather than waiting', async () => {
    const { docker } = makeDocker([[]]);
    const clock = makeClock();

    const outcome = await awaitConvergence(
      docker,
      'shop-api-x1',
      { wanted: 0, budgetMs: 90_000 },
      'created',
      clock,
    );

    expect(outcome.state).toBe('converged');
    expect(clock.elapsed()).toBe(0);
  });

  /**
   * `FailureAction: 'rollback'` is the default, so a healthy rollback produces
   * failed tasks on its way to a working state — and so does a task that
   * crashes once and restarts. Failing on the first `Err` would report both as
   * a failed Deployment.
   */
  it('does not fail fast on a task error the service recovers from', async () => {
    const { docker } = makeDocker([
      [failed('task: non-zero exit (1)', '1')],
      [failed('task: non-zero exit (1)', '1'), running('2')],
    ]);
    const clock = makeClock();

    const outcome = await awaitConvergence(
      docker,
      'shop-api-x1',
      { wanted: 1, budgetMs: 90_000 },
      'created',
      clock,
    );

    expect(outcome.state).toBe('converged');
  });

  it('reports a rollback the moment Swarm admits to one', async () => {
    const { docker } = makeDocker(
      [[failed('task: non-zero exit (1)')]],
      ['rollback_started'],
    );
    const clock = makeClock();

    const outcome = await awaitConvergence(
      docker,
      'shop-api-x1',
      { wanted: 1, budgetMs: 900_000 },
      'updated',
      clock,
    );

    expect(outcome).toMatchObject({
      state: 'rolled-back',
      running: 0,
      wanted: 1,
      lastError: 'task: non-zero exit (1)',
    });
    // An observation, not a clock: it did not wait for the budget.
    expect(clock.elapsed()).toBe(0);
  });

  /**
   * **The generation boundary, and this assertion is what stands in for the live
   * observation.**
   *
   * On the host: an Application re-pointed at `alpine:3.20` with
   * `command: "false"`, redeployed with the shipped default
   * `Order: 'start-first'`. `docker service inspect` answered
   * `{"State":"rollback_completed","StartedAt":"2026-08-24T12:37:03.940Z"}`
   * — and the Deployment had already been recorded `done` 19 ms after Swarm
   * accepted the update and 2.41 s *before* Swarm finished rolling it back,
   * because the previous generation's task was still running and still
   * desired-running on iteration 0.
   *
   * The three readings below are that host's three readings, in that order,
   * against the same derived 90 s budget: the old task alone; the old task
   * beside the new one that exits 1; and the same pair at the moment Swarm
   * admits to the rollback. The old task predates `StartedAt` and the new one
   * postdates it — by 123456 nanoseconds, which is also the RFC3339Nano trap.
   */
  it('reports the rollback an update with the default Order used to hide', async () => {
    const startedAt = '2026-08-24T12:37:03.940Z';
    const old = generation(running('1'), '2026-08-24T12:36:00.000000000Z');
    const fresh = generation(
      failed('task: non-zero exit (1)', '2'),
      '2026-08-24T12:37:03.940123456Z',
    );
    const { docker } = makeDocker(
      [[old], [old, fresh], [old, fresh]],
      ['updating', 'updating', 'rollback_completed'],
      startedAt,
    );
    const clock = makeClock();

    const outcome = await awaitConvergence(
      docker,
      'shop-api-x1',
      { wanted: 1, budgetMs: 90_000 },
      'updated',
      clock,
    );

    expect(outcome).toMatchObject({
      state: 'rolled-back',
      running: 0,
      wanted: 1,
      lastError: 'task: non-zero exit (1)',
    });
    expect(convergenceFailed(outcome)).toBe(true);
    // Decided in seconds, not at the end of the budget it never used to reach.
    expect(clock.elapsed()).toBeLessThan(90_000);
  });

  /**
   * The narrowest possible falsifier, so nobody "simplifies" the generation
   * belt away: one reading, one task, and it belongs to the generation *before*
   * `StartedAt`. Before the fix this returned `converged` at t=0 with `running: 1`.
   *
   * This is the half the gate cannot cover — revert the `currentGeneration`
   * call and `running` is 1 again.
   */
  it('does not count the previous generation towards an update', async () => {
    const { docker } = makeDocker(
      [[generation(running(), '2026-08-24T12:36:00Z')]],
      ['updating'],
      '2026-08-24T12:37:03.940Z',
    );
    const clock = makeClock();

    const outcome = await awaitConvergence(
      docker,
      'shop-api-x1',
      { wanted: 1, budgetMs: 10_000 },
      'updated',
      clock,
    );

    expect(outcome).toEqual({
      state: 'unconfirmed',
      running: 0,
      wanted: 1,
      elapsedMs: 10_000,
      lastError: null,
      everyTaskFailed: false,
    });
    expect(convergenceFailed(outcome)).toBe(false);
  });

  /**
   * The host's reading on a 1 → 2 scale-up. `UpdateStatus` said
   * `completed` six seconds in and both tasks were running, but slot 2's task
   * was created 3 ms before `StartedAt`, so the timestamp filter counted 1 of 2
   * and the Deployment waited out its budget. Both tasks carry the release's
   * `ForceUpdate`, and that is what the poll now counts by.
   */
  it('confirms a completed scale-up whose new slot predates StartedAt by ms', async () => {
    const slot1 = version(
      generation(
        running('2026-09-14T16:28:55.409Z'),
        '2026-09-14T16:28:54.002208225Z',
      ),
      7,
    );
    const slot2 = version(
      generation(
        running('2026-09-14T16:28:55.390Z'),
        '2026-09-14T16:28:53.993748853Z',
      ),
      7,
    );
    const { docker } = makeDocker(
      [[slot1, slot2]],
      ['completed'],
      '2026-09-14T16:28:53.996976218Z',
      { forceUpdate: 7 },
    );
    const clock = makeClock();

    const outcome = await awaitConvergence(
      docker,
      'shop-api-x1',
      { wanted: 2, budgetMs: 120_000 },
      'updated',
      clock,
    );

    expect(outcome).toEqual({
      state: 'converged',
      running: 2,
      wanted: 2,
      elapsedMs: 0,
    });
  });

  /**
   * The generation boundary beside the scale-up fix: the previous generation's
   * still-running task, created as close to `StartedAt` as slot 2 was above, is
   * still not counted — its `ForceUpdate` is the previous one. A skew allowance
   * alone would count it and report this `converged` while the new task is still starting.
   */
  it("still does not count the previous generation's task created at the boundary", async () => {
    const old = version(
      generation(running('1'), '2026-09-14T16:28:53.993748853Z'),
      6,
    );
    const fresh = version(
      generation(
        { Status: { State: 'starting', Timestamp: '2' } },
        '2026-09-14T16:28:54.002208225Z',
      ),
      7,
    );
    const { docker } = makeDocker(
      [[old, fresh]],
      ['completed'],
      '2026-09-14T16:28:53.996976218Z',
      { forceUpdate: 7 },
    );
    const clock = makeClock();

    const outcome = await awaitConvergence(
      docker,
      'shop-api-x1',
      { wanted: 1, budgetMs: 10_000 },
      'updated',
      clock,
    );

    expect(outcome).toMatchObject({ state: 'unconfirmed', running: 0 });
  });

  /**
   * The host's reading. The rejected task is no longer desired-running
   * once Swarm has replaced it, and the newest task is the rollback's healthy
   * replacement, so the ❌ line used to carry no reason at all. The reason is
   * read from every task Swarm remembers, restricted to the Deployment that
   * did not take: a `ForceUpdate` newer than the spec rolled back to, created
   * with this update.
   */
  it('carries the rejection a rollback replaced, not the healthy replacement', async () => {
    const serving = version(
      generation(running('2026-09-14T16:40:00Z'), '2026-09-14T16:40:00Z'),
      6,
    );
    const rollback = version(
      generation(
        {
          Status: { State: 'shutdown', Timestamp: '2026-09-14T16:55:45.398Z' },
        },
        '2026-09-14T16:55:43.232Z',
      ),
      6,
    );
    const rejected = version(
      generation(
        {
          Status: {
            State: 'rejected',
            Err: 'invalid mount config for type "bind": bind source path does not exist: /root/cg-ui/u06/nope',
            Timestamp: '2026-09-14T16:55:43.210Z',
          },
        },
        '2026-09-14T16:55:42.344828Z',
      ),
      7,
    );
    const earlierFailure = version(
      generation(
        failed('an earlier Deployment failed', '2026-09-14T15:00:00Z'),
        '2026-09-14T15:00:00Z',
      ),
      6,
    );
    const { docker } = makeDocker(
      [[serving, rollback]],
      ['rollback_completed'],
      '2026-09-14T16:55:42.342733555Z',
      {
        forceUpdate: 6,
        history: [earlierFailure, serving, rollback, rejected],
      },
    );
    const clock = makeClock();

    const outcome = await awaitConvergence(
      docker,
      'shop-api-x1',
      { wanted: 1, budgetMs: 90_000 },
      'updated',
      clock,
    );

    expect(outcome).toMatchObject({
      state: 'rolled-back',
      lastError:
        'invalid mount config for type "bind": bind source path does not exist: /root/cg-ui/u06/nope',
    });
  });

  /**
   * Twice in a row. B rolled back to counter 6, so C was bumped from 6
   * to 7 again: B's failed task, still in the history, carries C's counter.
   * C's own tasks exited without an error, and the ❌ line must not borrow
   * B's.
   */
  it('does not carry an earlier rolled-back Deployment’s error into the next one', async () => {
    const serving = version(
      generation(running('2026-09-14T16:40:00Z'), '2026-09-14T16:40:00Z'),
      6,
    );
    const failedB = version(
      generation(
        failed('B: task: non-zero exit (1)', '2026-09-14T17:02:05Z'),
        '2026-09-14T17:02:00Z',
      ),
      7,
    );
    const exitedC = version(
      generation(
        { Status: { State: 'complete', Timestamp: '2026-09-14T17:10:01.5Z' } },
        '2026-09-14T17:10:01Z',
      ),
      7,
    );
    const { docker } = makeDocker(
      [[serving]],
      ['rollback_completed'],
      '2026-09-14T17:10:00.500Z',
      { forceUpdate: 6, history: [serving, failedB, exitedC] },
    );

    const outcome = await awaitConvergence(
      docker,
      'shop-api-x1',
      { wanted: 1, budgetMs: 90_000 },
      'updated',
      makeClock(),
    );

    expect(outcome).toMatchObject({ state: 'rolled-back', lastError: null });
  });

  it('leaves a spent budget unconfirmed rather than calling it a failure', async () => {
    const { docker } = makeDocker([[running()]]);
    const clock = makeClock();

    const outcome = await awaitConvergence(
      docker,
      'shop-api-x1',
      { wanted: 3, budgetMs: 10_000 },
      'created',
      clock,
    );

    expect(outcome).toEqual({
      state: 'unconfirmed',
      running: 1,
      wanted: 3,
      elapsedMs: 10_000,
      lastError: null,
      everyTaskFailed: false,
    });
    expect(convergenceFailed(outcome)).toBe(false);
  });

  it('calls a spent budget whose every task carries an error a failure', async () => {
    const { docker } = makeDocker([
      [failed('task: non-zero exit (1)', '1'), failed('no such image', '2')],
    ]);
    const clock = makeClock();

    const outcome = await awaitConvergence(
      docker,
      'shop-api-x1',
      { wanted: 2, budgetMs: 10_000 },
      'created',
      clock,
    );

    expect(outcome).toMatchObject({
      state: 'unconfirmed',
      everyTaskFailed: true,
      // The newest task by timestamp, since /tasks promises no ordering.
      lastError: 'no such image',
    });
    expect(convergenceFailed(outcome)).toBe(true);
  });

  it('survives a daemon that will not answer an inspect', async () => {
    const { docker } = makeDocker([[running()]]);
    (docker.getService as unknown as jest.Mock).mockReturnValue({
      inspect: jest.fn().mockRejectedValue(new Error('no such service')),
    });
    const clock = makeClock();

    // UpdateStatus is a second signal and is unpopulated on a first deploy
    // anyway; losing it must not lose the task count with it.
    const outcome = await awaitConvergence(
      docker,
      'shop-api-x1',
      { wanted: 1, budgetMs: 10_000 },
      'created',
      clock,
    );

    expect(outcome.state).toBe('converged');
  });

  /**
   * The same refused inspect on an **update**, where `UpdateStatus` is no
   * longer a second signal but the generation boundary itself. Losing it must
   * fail *safe*: `unconfirmed`, which `convergenceFailed` leaves as `done` with
   * a ⚠️ line, and never `converged` — which is the answer that would be
   * manufactured out of the previous generation's task.
   */
  it('refuses to convert a refused inspect on an update into a converged one', async () => {
    const { docker } = makeDocker([[running()]]);
    (docker.getService as unknown as jest.Mock).mockReturnValue({
      inspect: jest.fn().mockRejectedValue(new Error('no such service')),
    });
    const clock = makeClock();

    const outcome = await awaitConvergence(
      docker,
      'shop-api-x1',
      { wanted: 1, budgetMs: 10_000 },
      'updated',
      clock,
    );

    expect(outcome.state).toBe('unconfirmed');
    expect(convergenceFailed(outcome)).toBe(false);
  });
});

describe('convergenceLogLine', () => {
  it('counts the tasks it saw running', () => {
    expect(
      convergenceLogLine(
        'shop-api-x1',
        'updated',
        {
          state: 'converged',
          running: 2,
          wanted: 2,
          elapsedMs: 4_000,
        },
        { built: true, pushed: false },
      ),
    ).toBe("✅ Swarm service 'shop-api-x1' updated; 2 of 2 tasks running.");
  });

  const rolledBack = {
    state: 'rolled-back' as const,
    running: 0,
    wanted: 1,
    elapsedMs: 8_000,
    lastError: 'task: non-zero exit (1)',
  };

  it('says what is serving when Swarm rolled the service back', () => {
    expect(
      convergenceLogLine('shop-api-x1', 'updated', rolledBack, {
        built: true,
        pushed: true,
      }),
    ).toBe(
      "❌ Swarm service 'shop-api-x1' did not take: Swarm rolled it back to its previous spec. " +
        'The image built and pushed; what is serving is the Deployment before this one. ' +
        'task: non-zero exit (1)',
    );
  });

  /** No registry, nothing pushed — the line may not say otherwise. */
  it('does not claim a push when no registry was used', () => {
    expect(
      convergenceLogLine('shop-api-x1', 'updated', rolledBack, {
        built: true,
        pushed: false,
      }),
    ).toBe(
      "❌ Swarm service 'shop-api-x1' did not take: Swarm rolled it back to its previous spec. " +
        'The image built; what is serving is the Deployment before this one. ' +
        'task: non-zero exit (1)',
    );
  });

  it('does not claim a build for an image that was pulled', () => {
    expect(
      convergenceLogLine('shop-api-x1', 'updated', rolledBack, {
        built: false,
        pushed: false,
      }),
    ).toContain('The image was pulled; what is serving');
    // A pulled image is never pushed, so a caller that says it was is
    // not believed: there is no "pulled and pushed" sentence to reach.
    expect(
      convergenceLogLine('shop-api-x1', 'updated', rolledBack, {
        built: false,
        pushed: true,
      }),
    ).toContain('The image was pulled; what is serving');
  });

  it('says the wait ran out without claiming a failure', () => {
    expect(
      convergenceLogLine(
        'shop-api-x1',
        'created',
        {
          state: 'unconfirmed',
          running: 1,
          wanted: 3,
          elapsedMs: 90_000,
          lastError: null,
          everyTaskFailed: false,
        },
        { built: true, pushed: false },
      ),
    ).toBe(
      "⚠️ Swarm service 'shop-api-x1' created; 1 of 3 tasks running after 90s. " +
        'Convergence was not confirmed.',
    );
  });
});
