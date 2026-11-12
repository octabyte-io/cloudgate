import { InMemoryQueue } from '../../src/deployment-queue/in-memory-queue';
import type { DeploymentJob } from '../../src/deployment-queue/job-types';

/** Drain pending microtasks + one macrotask tick so scheduling settles. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

type ApplicationJob = Extract<
  DeploymentJob,
  { applicationType: 'application' }
>;

const appJob = (
  applicationId: string,
  overrides: Partial<ApplicationJob> = {},
): ApplicationJob => ({
  applicationType: 'application',
  applicationId,
  deploymentId: null,
  type: 'deploy',
  title: 'Manual deployment',
  description: '',
  ...overrides,
});

describe('InMemoryQueue', () => {
  it('serializes two jobs of the same application FIFO — the second starts only after the first completes', async () => {
    const events: string[] = [];
    const gates: Record<string, ReturnType<typeof deferred>> = {
      one: deferred(),
      two: deferred(),
    };
    const queue = new InMemoryQueue({ resolveConcurrency: () => 5 });
    queue.process(async (job) => {
      events.push(`start:${job.data.title}`);
      await gates[job.data.title].promise;
      events.push(`finish:${job.data.title}`);
    });

    await queue.add(appJob('app-1', { title: 'one' }));
    await queue.add(appJob('app-1', { title: 'two' }));
    await flush();

    // Same group: plenty of concurrency, yet the second must wait.
    expect(events).toEqual(['start:one']);

    gates.one.resolve();
    await flush();
    expect(events).toEqual(['start:one', 'finish:one', 'start:two']);

    gates.two.resolve();
    await flush();
    expect(events).toEqual([
      'start:one',
      'finish:one',
      'start:two',
      'finish:two',
    ]);
  });

  it('runs at most the resolved concurrency of a partition at once, starting the next job when a slot frees', async () => {
    const events: string[] = [];
    const gates: Record<string, ReturnType<typeof deferred>> = {
      'app-a': deferred(),
      'app-b': deferred(),
      'app-c': deferred(),
    };
    const queue = new InMemoryQueue({ resolveConcurrency: () => 2 });
    queue.process(async (job) => {
      const id = (job.data as ApplicationJob).applicationId;
      events.push(`start:${id}`);
      await gates[id].promise;
      events.push(`finish:${id}`);
    });

    await queue.add(appJob('app-a', { serverId: 'srv-1' }));
    await queue.add(appJob('app-b', { serverId: 'srv-1' }));
    await queue.add(appJob('app-c', { serverId: 'srv-1' }));
    await flush();

    // Three distinct groups, but the partition only has two slots.
    expect(events).toEqual(['start:app-a', 'start:app-b']);

    gates['app-a'].resolve();
    await flush();
    expect(events).toEqual([
      'start:app-a',
      'start:app-b',
      'finish:app-a',
      'start:app-c',
    ]);
  });

  it('runs jobs on different serverId partitions in parallel, each within its own concurrency', async () => {
    const events: string[] = [];
    const gate = deferred();
    // Every partition (including local) is capped at 1: parallelism may only
    // come from the partitioning itself.
    const queue = new InMemoryQueue({ resolveConcurrency: () => 1 });
    queue.process(async (job) => {
      events.push(`start:${(job.data as ApplicationJob).applicationId}`);
      await gate.promise;
    });

    await queue.add(appJob('app-a', { serverId: 'srv-1' }));
    await queue.add(appJob('app-b', { serverId: 'srv-2' }));
    await queue.add(appJob('app-c')); // local partition
    await queue.add(appJob('app-d', { serverId: 'srv-1' })); // srv-1 is busy
    await flush();

    expect(events.sort()).toEqual([
      'start:app-a',
      'start:app-b',
      'start:app-c',
    ]);
    gate.resolve();
  });

  it('returns a job handle from add that getJobs can discover, with its state', async () => {
    const gate = deferred();
    const queue = new InMemoryQueue({ resolveConcurrency: () => 1 });
    queue.process(() => gate.promise);

    const first = await queue.add(appJob('app-a'));
    const second = await queue.add(appJob('app-b'));
    await flush();

    const jobs = await queue.getJobs();
    expect(jobs.map((job) => [job.id, job.state]).sort()).toEqual([
      [first.id, 'active'],
      [second.id, 'waiting'],
    ]);
    expect(await queue.getJobs(['waiting'])).toHaveLength(1);

    gate.resolve();
  });

  it('cancel removes a pending job so it never runs; an active job cannot be cancelled', async () => {
    const events: string[] = [];
    const gate = deferred();
    const queue = new InMemoryQueue({ resolveConcurrency: () => 1 });
    queue.process(async (job) => {
      events.push(`start:${(job.data as ApplicationJob).applicationId}`);
      await gate.promise;
    });

    const first = await queue.add(appJob('app-a'));
    const cancelled = await queue.add(appJob('app-b'));
    const third = await queue.add(appJob('app-c'));
    await flush();

    expect(await queue.cancel(cancelled.id)).toBe(true);
    expect(await queue.cancel(first.id)).toBe(false); // already active

    gate.resolve();
    await flush();

    expect(events).toEqual(['start:app-a', 'start:app-c']);
    const remaining = await queue.getJobs();
    expect(remaining.map((job) => job.id)).not.toContain(cancelled.id);
    void third;
  });

  it('clearWaiting drops every pending job across partitions but leaves active ones', async () => {
    const events: string[] = [];
    const gate = deferred();
    const queue = new InMemoryQueue({ resolveConcurrency: () => 1 });
    queue.process(async (job) => {
      events.push(`start:${(job.data as ApplicationJob).applicationId}`);
      await gate.promise;
    });

    await queue.add(appJob('app-a'));
    await queue.add(appJob('app-b'));
    await queue.add(appJob('app-c', { serverId: 'srv-1' }));
    await queue.add(appJob('app-d', { serverId: 'srv-1' }));
    await flush();

    // One active job per partition, the rest waiting.
    expect(events).toEqual(['start:app-a', 'start:app-c']);

    // It answers what it dropped: the caller has a pending Deployment
    // row for each of them to settle, and nothing else still knows which.
    const dropped = await queue.clearWaiting();
    expect(
      dropped.map((job) => (job.data as ApplicationJob).applicationId).sort(),
    ).toEqual(['app-b', 'app-d']);
    expect(dropped.every((job) => job.state === 'waiting')).toBe(true);

    expect(await queue.getJobs(['waiting'])).toEqual([]);
    expect((await queue.getJobs(['active'])).length).toBe(2);

    gate.resolve();
    await flush();
    // Nothing else ever starts.
    expect(events).toEqual(['start:app-a', 'start:app-c']);
  });
});
