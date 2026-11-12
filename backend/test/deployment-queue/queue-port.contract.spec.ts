import { InMemoryQueue } from '../../src/deployment-queue/in-memory-queue';
import type { DeploymentJob } from '../../src/deployment-queue/job-types';
import type { QueuePort } from '../../src/deployment-queue/queue.port';

/**
 * The contract a `QueuePort` adapter answers to, so another can be swapped in
 * behind the port without its callers noticing. The in-process queue is the
 * only adapter: every instance, hosted or not, builds through it.
 */

const adapters: Array<[string, () => QueuePort]> = [
  [
    'InMemoryQueue',
    // No processor registered: jobs stay waiting, which is the state the
    // contract is about.
    () => new InMemoryQueue({ resolveConcurrency: () => 1 }),
  ],
];

const job = (applicationId: string): DeploymentJob => ({
  applicationType: 'application',
  applicationId,
  deploymentId: null,
  title: 'Manual deployment',
  description: '',
  type: 'deploy',
  serverId: 'srv-1',
});

describe.each(adapters)('QueuePort contract: %s', (_name, createQueue) => {
  it('returns a handle from add that getJobs discovers, still waiting', async () => {
    const queue = createQueue();

    const handle = await queue.add(job('app-1'));

    expect(handle.data).toEqual(job('app-1'));
    expect(await queue.getJobs()).toContainEqual({
      id: handle.id,
      data: job('app-1'),
      state: 'waiting',
    });
  });

  it('answers getJobs for the states asked for', async () => {
    const queue = createQueue();
    const handle = await queue.add(job('app-1'));

    expect((await queue.getJobs(['waiting'])).map((j) => j.id)).toEqual([
      handle.id,
    ]);
    expect(await queue.getJobs(['active'])).toEqual([]);
  });

  it('cancel removes a pending job, and it is gone from the listing', async () => {
    const queue = createQueue();
    const kept = await queue.add(job('app-keep'));
    const cancelled = await queue.add(job('app-cancel'));

    await expect(queue.cancel(cancelled.id)).resolves.toBe(true);

    const remaining = (await queue.getJobs()).map((j) => j.id);
    expect(remaining).toContain(kept.id);
    expect(remaining).not.toContain(cancelled.id);
  });

  it('reports false for an id no job was ever handed out under', async () => {
    const queue = createQueue();

    await expect(queue.cancel('no-such-job')).resolves.toBe(false);
  });
});
