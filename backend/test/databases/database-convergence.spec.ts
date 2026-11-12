import type Docker from 'dockerode';
import { awaitDatabaseDeploy } from '../../src/databases/common/database-convergence';
import { convergeDatabaseService } from '../../src/databases/common/database-spec';
import type { SwarmConfigSource } from '../../src/deployment-engine/mechanize';
import type { ConvergenceClock } from '../../src/deployment-engine/await-convergence';

/**
 * A database deploy used to write `done` the moment Docker accepted the
 * spec, so a new image Swarm rolled back seconds later read `done` with the
 * unapplied image listed. The double below is the seam: `inspect()` is what
 * `docker service inspect` answers and `listTasks()` what `docker service ps`
 * does, each shaped after the two live sites on the ticket.
 */
const source = { replicas: 1 } as unknown as SwarmConfigSource;

const STARTED = '2026-09-18T18:57:10.000000000Z';

interface Service {
  Version?: { Index: number };
  Spec: {
    TaskTemplate: { ForceUpdate?: number; ContainerSpec?: { Image?: string } };
    Mode?: { Replicated?: { Replicas?: number } };
  };
  UpdateStatus?: { State?: string; Message?: string; StartedAt?: string };
}

interface Task {
  CreatedAt?: string;
  DesiredState: 'running' | 'shutdown';
  Spec?: { ForceUpdate?: number };
  Status: { State: string; Err?: string; Timestamp?: string };
}

function swarm(service: Service | null, tasks: Task[]) {
  const inspect = jest.fn(() =>
    service
      ? Promise.resolve(service)
      : Promise.reject(new Error('no such service')),
  );
  const docker = {
    getService: jest.fn(() => ({ inspect, update: jest.fn() })),
    createService: jest.fn(),
    listTasks: jest.fn(({ filters }: { filters: string }) => {
      const parsed = JSON.parse(filters) as { 'desired-state'?: string[] };
      return Promise.resolve(
        parsed['desired-state']
          ? tasks.filter((task) => task.DesiredState === 'running')
          : tasks,
      );
    }),
  };
  return docker as unknown as Docker & typeof docker;
}

/** A clock that advances by whatever it is asked to sleep, so a spent budget
 * costs microseconds. */
function fakeClock(): ConvergenceClock {
  let now = 0;
  return {
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
  };
}

/** The previous spec's task, still (or again) serving. */
const serving = (forceUpdate: number): Task => ({
  CreatedAt: '2026-09-18T18:50:00Z',
  DesiredState: 'running',
  Spec: { ForceUpdate: forceUpdate },
  Status: { State: 'running', Timestamp: '2026-09-18T18:57:18Z' },
});

/** This deploy's own task, which exited on start. */
const rejected = (forceUpdate: number): Task => ({
  CreatedAt: '2026-09-18T18:57:10.5Z',
  DesiredState: 'shutdown',
  Spec: { ForceUpdate: forceUpdate },
  Status: {
    State: 'failed',
    Err: 'task: non-zero exit (1)',
    Timestamp: '2026-09-18T18:57:12Z',
  },
});

describe('awaitDatabaseDeploy', () => {
  it('fails a deploy Swarm rolled back, with the rejected task’s error and the image still running', async () => {
    // The Redis site: `redis:7` against a volume `redis:8` wrote.
    const docker = swarm(
      {
        Spec: {
          TaskTemplate: {
            ForceUpdate: 3,
            ContainerSpec: { Image: 'redis:8@sha256:0123abcd' },
          },
        },
        UpdateStatus: {
          State: 'rollback_completed',
          Message: 'rollback completed',
          StartedAt: STARTED,
        },
      },
      [serving(3), rejected(4)],
    );

    const verdict = await awaitDatabaseDeploy(
      docker,
      'redis-b8hgsp',
      source,
      { outcome: 'updated', forceUpdate: 4 },
      { engineLabel: 'Redis', clock: fakeClock() },
    );

    expect(verdict.failed).toBe(true);
    expect(verdict.failed && verdict.reason).toContain(
      'task: non-zero exit (1)',
    );
    expect(verdict.failed && verdict.reason).toContain('redis:8');
    expect(verdict.failed && verdict.reason).not.toContain('sha256');
    // One clause, as every 409 message is (§2.5).
    expect(verdict.failed && verdict.reason).not.toMatch(/\.$/);
  });

  it('fails a deploy whose spec Swarm put back even though UpdateStatus says completed', async () => {
    // The PostgreSQL site on the ticket's comment: `completed`, not
    // `rollback_completed`, and the service back on the previous spec. The
    // spec version the deploy wrote (4) is no longer the service's (3).
    const docker = swarm(
      {
        Spec: {
          TaskTemplate: {
            ForceUpdate: 3,
            ContainerSpec: { Image: 'postgres:16' },
          },
        },
        UpdateStatus: {
          State: 'completed',
          Message: 'update completed',
          StartedAt: STARTED,
        },
      },
      [serving(3), rejected(4), rejected(4)],
    );

    const verdict = await awaitDatabaseDeploy(
      docker,
      'postgres-ui-pg',
      source,
      { outcome: 'updated', forceUpdate: 4 },
      { engineLabel: 'PostgreSQL', clock: fakeClock() },
    );

    expect(verdict.failed).toBe(true);
    expect(verdict.failed && verdict.reason).toContain(
      'task: non-zero exit (1)',
    );
    expect(verdict.failed && verdict.reason).toContain('postgres:16');
  });

  it('passes a completed update whose running task carries the spec it wrote', async () => {
    const docker = swarm(
      {
        Spec: {
          TaskTemplate: { ForceUpdate: 4, ContainerSpec: { Image: 'redis:8' } },
        },
        UpdateStatus: { State: 'completed', StartedAt: STARTED },
      },
      [{ ...serving(4), CreatedAt: '2026-09-18T18:57:11Z' }],
    );

    const verdict = await awaitDatabaseDeploy(
      docker,
      'redis-b8hgsp',
      source,
      { outcome: 'updated', forceUpdate: 4 },
      { engineLabel: 'Redis', clock: fakeClock() },
    );

    expect(verdict).toEqual({ failed: false, confirmed: true });
  });

  it('does not call the deploy failed while the previous spec is still running and Swarm has not decided', async () => {
    // Stop-first means there is a window with the old task still up; a
    // spent budget there is "not confirmed", never an invented failure.
    const docker = swarm(
      {
        Spec: {
          TaskTemplate: { ForceUpdate: 4, ContainerSpec: { Image: 'redis:8' } },
        },
        UpdateStatus: { State: 'updating', StartedAt: STARTED },
      },
      [serving(3)],
    );

    const verdict = await awaitDatabaseDeploy(
      docker,
      'redis-b8hgsp',
      source,
      { outcome: 'updated', forceUpdate: 4 },
      { engineLabel: 'Redis', clock: fakeClock() },
    );

    expect(verdict).toEqual({ failed: false, confirmed: false });
  });

  it('fails a deploy Swarm paused on, with Swarm’s own message', async () => {
    const docker = swarm(
      {
        Spec: {
          TaskTemplate: { ForceUpdate: 4, ContainerSpec: { Image: 'redis:7' } },
        },
        UpdateStatus: {
          State: 'paused',
          Message:
            'update paused due to failure or early termination of task x',
          StartedAt: STARTED,
        },
      },
      [serving(3), rejected(4)],
    );

    const verdict = await awaitDatabaseDeploy(
      docker,
      'redis-b8hgsp',
      source,
      { outcome: 'updated', forceUpdate: 4 },
      { engineLabel: 'Redis', clock: fakeClock() },
    );

    expect(verdict.failed).toBe(true);
    expect(verdict.failed && verdict.reason).toContain('paused');
    expect(verdict.failed && verdict.reason).toContain(
      'update paused due to failure',
    );
  });

  it('passes a first deploy once its task is running', async () => {
    const docker = swarm(null, [serving(0)]);

    const verdict = await awaitDatabaseDeploy(
      docker,
      'redis-new',
      source,
      { outcome: 'created', forceUpdate: null },
      { engineLabel: 'Redis', clock: fakeClock() },
    );

    expect(verdict).toEqual({ failed: false, confirmed: true });
  });

  it('fails a first deploy whose every task exited, with the task’s error', async () => {
    const docker = swarm(null, [{ ...rejected(0), DesiredState: 'running' }]);

    const verdict = await awaitDatabaseDeploy(
      docker,
      'redis-new',
      source,
      { outcome: 'created', forceUpdate: null },
      { engineLabel: 'Redis', clock: fakeClock() },
    );

    expect(verdict.failed).toBe(true);
    expect(verdict.failed && verdict.reason).toContain(
      'task: non-zero exit (1)',
    );
  });
});

describe('convergeDatabaseService', () => {
  it('reports an update with the spec version it wrote', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const docker = {
      getService: () => ({
        inspect: () =>
          Promise.resolve({
            Version: { Index: '12' },
            Spec: { TaskTemplate: { ForceUpdate: 3 } },
          }),
        update,
      }),
      createService: jest.fn(),
    } as unknown as Docker;

    await expect(
      convergeDatabaseService(docker, 'redis-b8hgsp', { TaskTemplate: {} }),
    ).resolves.toEqual({ outcome: 'updated', forceUpdate: 4 });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 12,
        TaskTemplate: expect.objectContaining({ ForceUpdate: 4 }) as unknown,
      }),
    );
  });

  it('reports a create when there is no service', async () => {
    const createService = jest.fn().mockResolvedValue(undefined);
    const docker = {
      getService: () => ({
        inspect: () => Promise.reject(new Error('no such service')),
      }),
      createService,
    } as unknown as Docker;

    await expect(
      convergeDatabaseService(docker, 'redis-new', { TaskTemplate: {} }),
    ).resolves.toEqual({ outcome: 'created', forceUpdate: null });
    expect(createService).toHaveBeenCalledTimes(1);
  });
});
