import type Docker from 'dockerode';
import {
  currentGeneration,
  readSwarmServiceHealth,
  readSwarmTasks,
  readSwarmUpdateStatus,
  rolledBackGeneration,
  summarizeTasks,
} from '../../src/docker/swarm-service-health';
import type { SwarmTask } from '../../src/docker/swarm-service-health';

/**
 * `swarm-service-health.ts` had no spec of its own anywhere in `backend/test`,
 * which is part of how the generation bug got through: the convergence poll's two readings
 * were only ever exercised through `awaitConvergence`'s fake, and that fake had
 * no notion of a generation at all.
 */

const task = (
  state: string,
  extra: {
    err?: string;
    timestamp?: string;
    createdAt?: string;
    forceUpdate?: number;
  } = {},
): SwarmTask => ({
  ...(extra.createdAt === undefined ? {} : { CreatedAt: extra.createdAt }),
  ...(extra.forceUpdate === undefined
    ? {}
    : { Spec: { ForceUpdate: extra.forceUpdate } }),
  Status: {
    State: state,
    ...(extra.err === undefined ? {} : { Err: extra.err }),
    Timestamp: extra.timestamp ?? '2026-08-24T00:00:00Z',
  },
});

const makeDocker = (inspect: () => Promise<unknown>, tasks: SwarmTask[] = []) =>
  ({
    getService: jest.fn(() => ({ inspect: jest.fn(inspect) })),
    listTasks: jest.fn().mockResolvedValue(tasks),
  }) as unknown as Docker;

describe('currentGeneration', () => {
  const startedAt = '2026-08-24T12:37:03.940Z';

  /**
   * The trap that decides whether this is `Date.parse` or a string compare.
   * RFC3339Nano emits a variable number of fractional digits, so the task
   * `…03.940123456Z` — which Swarm created 123456 ns *after* the boundary —
   * sorts *before* `…03.94Z` lexicographically. A `localeCompare`
   * implementation drops the new generation's only task and reports an update
   * that is converging fine as `running: 0`.
   */
  it('keeps a task the boundary only outranks as a string', () => {
    const fresh = task('running', {
      createdAt: '2026-08-24T12:37:03.940123456Z',
    });

    expect(currentGeneration([fresh], startedAt)).toEqual([fresh]);
    // The string compare this test exists to rule out.
    expect('2026-08-24T12:37:03.940123456Z'.localeCompare(startedAt)).toBe(-1);
  });

  it('drops the generation that predates the update', () => {
    const old = task('running', {
      createdAt: '2026-08-24T12:36:00.000000000Z',
    });
    const fresh = task('failed', {
      err: 'task: non-zero exit (1)',
      createdAt: '2026-08-24T12:37:04Z',
    });

    expect(currentGeneration([old, fresh], startedAt)).toEqual([fresh]);
  });

  /**
   * Excluded, not included. A task the daemon will not date cannot be *shown*
   * to belong to this release, and including it is the direction that
   * manufactures a false `converged`.
   */
  it('drops a task the daemon did not date', () => {
    expect(currentGeneration([task('running')], startedAt)).toEqual([]);
  });

  it('leaves the reading alone when there is no boundary to draw', () => {
    // A first deploy: `UpdateStatus` is unpopulated by design, so there is no
    // previous generation to be confused with and nothing to filter.
    const tasks = [task('running'), task('failed', { err: 'boom' })];

    expect(currentGeneration(tasks, null)).toEqual(tasks);
  });

  it('leaves the reading alone when the boundary will not parse', () => {
    const tasks = [task('running', { createdAt: '2026-08-24T12:37:04Z' })];

    expect(currentGeneration(tasks, 'not-a-timestamp')).toEqual(tasks);
  });

  /**
   * The host's own reading. A 1 → 2 scale-up: Swarm's orchestrator
   * created slot 2's task 3 ms *before* the updater stamped `StartedAt`, so a
   * `CreatedAt >= StartedAt` filter never counted it and the Deployment waited
   * out its whole budget on a service that was 2/2 in two seconds. Both tasks
   * carry the `ForceUpdate` the release wrote, which is what says they are this
   * release's.
   */
  it('counts a scale-up task Swarm created a few ms before StartedAt', () => {
    const boundary = '2026-09-14T16:28:53.996976218Z';
    const slot1 = task('running', {
      createdAt: '2026-09-14T16:28:54.002208225Z',
      forceUpdate: 7,
    });
    const slot2 = task('running', {
      createdAt: '2026-09-14T16:28:53.993748853Z',
      forceUpdate: 7,
    });

    expect(currentGeneration([slot1, slot2], boundary, 7)).toEqual([
      slot1,
      slot2,
    ]);
  });

  /**
   * The generation boundary still holds, and not by a clock: a start-first
   * update's previous task carries the previous `ForceUpdate`, so it is out
   * however close to `StartedAt` it was created — which is the case a skew
   * allowance alone would have let back in.
   */
  it("drops the previous generation's task even when it was created at the boundary", () => {
    const boundary = '2026-09-14T16:28:53.996976218Z';
    const old = task('running', {
      createdAt: '2026-09-14T16:28:53.990000000Z',
      forceUpdate: 6,
    });
    const fresh = task('starting', {
      createdAt: '2026-09-14T16:28:54.002208225Z',
      forceUpdate: 7,
    });

    expect(currentGeneration([old, fresh], boundary, 7)).toEqual([fresh]);
  });

  /**
   * The case the timestamp got wrong in the other direction: the previous
   * generation's task restarted mid-update is created *after* `StartedAt` but
   * runs the previous spec.
   */
  it('drops a previous-spec task restarted after StartedAt', () => {
    const restarted = task('running', {
      createdAt: '2026-09-14T16:28:55Z',
      forceUpdate: 6,
    });

    expect(
      currentGeneration([restarted], '2026-09-14T16:28:53.996976218Z', 7),
    ).toEqual([]);
  });
});

describe('rolledBackGeneration', () => {
  /**
   * After a rollback the serving spec is the previous one again, so the
   * release that did not take is the tasks carrying a *newer* `ForceUpdate`
   * than the one serving and created with this update — found here even though
   * the rejected task was created 2 ms before `StartedAt`, as it was on a live
   * rollback. An older release's failure is not part of it, and neither is the
   * rollback's own replacement, which carries the serving counter.
   */
  it('is the tasks newer than the spec Swarm rolled back to and created with this update', () => {
    const startedAt = '2026-09-14T16:55:42.342733555Z';
    const rejected = task('rejected', {
      createdAt: '2026-09-14T16:55:42.340000000Z',
      err: 'bind source path does not exist: /root/cg-ui/u06/nope',
      forceUpdate: 7,
    });
    const rollback = task('running', {
      createdAt: '2026-09-14T16:55:43.232Z',
      forceUpdate: 6,
    });
    const older = task('failed', {
      createdAt: '2026-09-14T15:00:00Z',
      err: 'an older failure',
      forceUpdate: 5,
    });

    expect(
      rolledBackGeneration([older, rejected, rollback], startedAt, 6),
    ).toEqual([rejected]);
  });

  it('falls back to the StartedAt boundary for a task with no ForceUpdate', () => {
    const startedAt = '2026-09-14T16:55:42.342733555Z';
    const rejected = task('rejected', {
      createdAt: '2026-09-14T16:55:42.344828Z',
      err: 'boom',
    });
    const older = task('failed', {
      createdAt: '2026-09-14T15:00:00Z',
      err: 'an older failure',
    });

    expect(rolledBackGeneration([older, rejected], startedAt, 6)).toEqual([
      rejected,
    ]);
  });

  /**
   * Two rolled-back releases in a row. Swarm put the spec back to counter 6
   * after B, so C was bumped from 6 to 7 as well — B's failed task, still in
   * the task history, carries the same counter as C's. Only C's `StartedAt`
   * tells them apart.
   */
  describe('after two consecutive rollbacks', () => {
    const startedAtC = '2026-09-14T17:10:00.500Z';
    const failedB = task('failed', {
      createdAt: '2026-09-14T17:02:00Z',
      err: 'B: task: non-zero exit (1)',
      forceUpdate: 7,
      // Later than C's task on purpose: which release a task belongs to is
      // the generation's question, not the newest timestamp's.
      timestamp: '2026-09-14T17:30:00Z',
    });
    const rollbackC = task('running', {
      createdAt: '2026-09-14T17:10:02Z',
      forceUpdate: 6,
      timestamp: '2026-09-14T17:10:03Z',
    });

    it("does not take the earlier Deployment's failure for this one's", () => {
      const rejectedC = task('rejected', {
        createdAt: '2026-09-14T17:10:00.498Z',
        err: 'C: No such image: shop:v9',
        forceUpdate: 7,
        timestamp: '2026-09-14T17:10:01Z',
      });

      const generation = rolledBackGeneration(
        [failedB, rejectedC, rollbackC],
        startedAtC,
        6,
      );

      expect(generation).toEqual([rejectedC]);
      expect(summarizeTasks(generation).lastError).toBe(
        'C: No such image: shop:v9',
      );
    });

    it('names no error rather than the earlier Deployment’s when this one’s tasks carry none', () => {
      const exitedC = task('complete', {
        createdAt: '2026-09-14T17:10:01Z',
        forceUpdate: 7,
        timestamp: '2026-09-14T17:10:01.5Z',
      });

      const generation = rolledBackGeneration(
        [failedB, exitedC, rollbackC],
        startedAtC,
        6,
      );

      expect(generation).toEqual([exitedC]);
      expect(summarizeTasks(generation).lastError).toBeNull();
    });
  });
});

describe('summarizeTasks', () => {
  /**
   * The rejection is followed by the rollback's error-free replacement,
   * which is the newest task. The newest *error* is the sentence worth showing;
   * the newest task's state is still the state.
   */
  it('keeps a rejection a newer error-free task came after', () => {
    const summary = summarizeTasks([
      task('shutdown', { timestamp: '2026-09-14T16:55:45.398Z' }),
      task('rejected', {
        err: 'invalid mount config for type "bind": bind source path does not exist: /root/cg-ui/u06/nope',
        timestamp: '2026-09-14T16:55:43.210Z',
      }),
    ]);

    expect(summary).toEqual({
      running: 0,
      lastError:
        'invalid mount config for type "bind": bind source path does not exist: /root/cg-ui/u06/nope',
      lastState: 'shutdown',
    });
  });

  it('orders by time, not by string, across fractions of different lengths', () => {
    // `…03.91Z` is 10 ms after `…03.9Z`, and sorts before it as text.
    const summary = summarizeTasks([
      task('failed', {
        err: 'the older error',
        timestamp: '2026-09-14T16:55:03.9Z',
      }),
      task('rejected', {
        err: 'the newer error',
        timestamp: '2026-09-14T16:55:03.91Z',
      }),
    ]);

    expect(summary.lastError).toBe('the newer error');
    expect(summary.lastState).toBe('rejected');
  });
});

describe('readSwarmTasks', () => {
  it('asks for desired-running tasks by default', async () => {
    const listTasks = jest.fn().mockResolvedValue([]);
    await readSwarmTasks({ listTasks } as unknown as Docker, 'shop-api-x1');

    expect(listTasks).toHaveBeenCalledWith({
      filters: JSON.stringify({
        service: ['shop-api-x1'],
        'desired-state': ['running'],
      }),
    });
  });

  /**
   * A rejected task's desired state is `shutdown` once Swarm has replaced it,
   * so the desired-running read cannot see the one task that says why a
   * rollback happened.
   */
  it('can ask for every task Swarm still remembers', async () => {
    const listTasks = jest.fn().mockResolvedValue([]);
    await readSwarmTasks(
      { listTasks } as unknown as Docker,
      'shop-api-x1',
      'any',
    );

    expect(listTasks).toHaveBeenCalledWith({
      filters: JSON.stringify({ service: ['shop-api-x1'] }),
    });
  });
});

describe('readSwarmUpdateStatus', () => {
  it('calls an unpopulated UpdateStatus a first deploy rather than a verdict', async () => {
    const docker = makeDocker(() => Promise.resolve({}));

    expect(await readSwarmUpdateStatus(docker, 'shop-api-x1')).toEqual({
      decision: 'none',
      startedAt: null,
      forceUpdate: null,
      paused: false,
      message: null,
      image: null,
    });
  });

  it('reads a finished update, and the boundary it finished from', async () => {
    const docker = makeDocker(() =>
      Promise.resolve({
        Spec: { TaskTemplate: { ForceUpdate: 7 } },
        UpdateStatus: {
          State: 'completed',
          StartedAt: '2026-08-24T12:37:03.940Z',
        },
      }),
    );

    expect(await readSwarmUpdateStatus(docker, 'shop-api-x1')).toEqual({
      decision: 'completed',
      startedAt: '2026-08-24T12:37:03.940Z',
      // The spec version the release wrote, which is what names its tasks.
      forceUpdate: 7,
      paused: false,
      message: null,
      image: null,
    });
  });

  it.each(['rollback_started', 'rollback_completed'])(
    'reads %s as Swarm having rolled the update back',
    async (state) => {
      const docker = makeDocker(() =>
        Promise.resolve({ UpdateStatus: { State: state } }),
      );

      expect(await readSwarmUpdateStatus(docker, 'shop-api-x1')).toMatchObject({
        decision: 'rolled-back',
      });
    },
  );

  /**
   * `paused` is the state the issue's own reproduction never reached and the
   * one an operator gets from `FailureAction: 'pause'`. It is *undecided*, not
   * a verdict — which is what keeps the poll from answering off the previous
   * generation. `updating` is the same case and is the one the host saw.
   */
  it.each(['updating', 'paused', 'rollback_paused', 'a_state_from_2030'])(
    'leaves %s undecided rather than guessing at it',
    async (state) => {
      const docker = makeDocker(() =>
        Promise.resolve({
          UpdateStatus: { State: state, StartedAt: '2026-08-24T12:37:03.940Z' },
        }),
      );

      expect(await readSwarmUpdateStatus(docker, 'shop-api-x1')).toMatchObject({
        decision: 'undecided',
        startedAt: '2026-08-24T12:37:03.940Z',
        forceUpdate: null,
        paused: state.endsWith('paused'),
      });
    },
  );

  it('carries Swarm’s message and the image the spec now names, without the pinned digest', async () => {
    const docker = makeDocker(() =>
      Promise.resolve({
        Spec: {
          TaskTemplate: {
            ForceUpdate: 3,
            ContainerSpec: { Image: 'redis:8@sha256:0123abcd' },
          },
        },
        UpdateStatus: {
          State: 'rollback_completed',
          Message: ' rollback completed ',
        },
      }),
    );

    expect(await readSwarmUpdateStatus(docker, 'redis-b8hgsp')).toMatchObject({
      decision: 'rolled-back',
      forceUpdate: 3,
      message: 'rollback completed',
      image: 'redis:8',
    });
  });

  it('says so when the daemon will not answer the inspect', async () => {
    const docker = makeDocker(() =>
      Promise.reject(new Error('no such service')),
    );

    expect(await readSwarmUpdateStatus(docker, 'shop-api-x1')).toEqual({
      decision: 'unreadable',
      startedAt: null,
      forceUpdate: null,
      paused: false,
      message: null,
      image: null,
    });
  });
});

describe('readSwarmServiceHealth', () => {
  /**
   * The absence the generation boundary depends on, pinned by a test that names it. The
   * generation belt belongs to `awaitConvergence`, which is asking "did *this
   * release* take". This read is asking "can this serve a request", and during
   * a healthy `start-first` update the answer is the *previous* generation —
   * so filtering it out here would report a mid-update service as down to
   * `settings/infra-health.service.ts` and to
   * `enterprise/forward-auth/forward-auth-proxy.service.ts`.
   */
  it('counts both generations mid-update, because both are serving', async () => {
    const docker = makeDocker(
      () =>
        Promise.resolve({
          Spec: { Mode: { Replicated: { Replicas: 2 } } },
          UpdateStatus: {
            State: 'updating',
            StartedAt: '2026-08-24T12:37:03.940Z',
          },
        }),
      [
        task('running', { createdAt: '2026-08-24T12:36:00Z', timestamp: '1' }),
        task('running', { createdAt: '2026-08-24T12:36:00Z', timestamp: '2' }),
        task('running', { createdAt: '2026-08-24T12:37:04Z', timestamp: '3' }),
      ],
    );

    expect(await readSwarmServiceHealth(docker, 'shop-api-x1')).toMatchObject({
      deployed: true,
      running: 3,
      wanted: 2,
    });
  });
});
