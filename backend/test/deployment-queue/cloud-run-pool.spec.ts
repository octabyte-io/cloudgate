import { CloudRunPool } from '../../src/deployment-queue/cloud-run-pool';
import type {
  CloudRunControl,
  CloudRunEnding,
  CloudRunJob,
} from '../../src/deployment-queue/cloud-run-job.types';

/** Drain pending microtasks + one macrotask tick so scheduling settles. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const MINUTE = 60_000;

const run = (
  id: string,
  overrides: Partial<CloudRunJob> = {},
): CloudRunJob => ({
  deploymentId: id,
  kind: 'deploy',
  stateKey: `application:${id}`,
  environmentId: 'env-1',
  touchesNetwork: false,
  ...overrides,
});

const network = (id: string, environmentId = 'env-1'): CloudRunJob => ({
  deploymentId: id,
  kind: 'network',
  stateKey: `network:${environmentId}`,
  environmentId,
  touchesNetwork: true,
});

const read = (stateKey: string): CloudRunJob => ({
  deploymentId: null,
  kind: 'read',
  stateKey,
  environmentId: 'env-1',
  touchesNetwork: false,
});

/**
 * An executor whose runs each wait on a gate of their own, named by the
 * deployment id (or `read:<stateKey>`), recording start and end — and, like
 * `tofu`, ending when it is interrupted unless told to hang.
 */
function scripted() {
  const events: string[] = [];
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const controls = new Map<string, CloudRunControl>();
  const hangs = new Set<string>();
  const name = (job: CloudRunJob) => job.deploymentId ?? `read:${job.stateKey}`;
  const gate = (id: string) => {
    let g = gates.get(id);
    if (!g) {
      g = deferred();
      gates.set(id, g);
    }
    return g;
  };
  const executor = async (job: CloudRunJob, control: CloudRunControl) => {
    const id = name(job);
    controls.set(id, control);
    events.push(`start:${id}`);
    control.signal.onInterrupt(() => {
      events.push(`interrupt:${id}`);
      if (!hangs.has(id)) gate(id).resolve();
    });
    control.signal.onKill(() => {
      events.push(`kill:${id}`);
      gate(id).resolve();
    });
    await gate(id).promise;
    events.push(`end:${id}`);
    return id;
  };
  return {
    events,
    executor,
    finish: (id: string) => gate(id).resolve(),
    control: (id: string) => controls.get(id)!,
    hang: (id: string) => hangs.add(id),
  };
}

function pool(
  work: ReturnType<typeof scripted>,
  options: { limit?: number; timeLimitMinutes?: number } = {},
) {
  return new CloudRunPool({
    resolveLimit: () => options.limit ?? 1,
    resolveTimeLimitMinutes: () => options.timeLimitMinutes ?? 60,
    killGraceMs: 5 * MINUTE,
    shutdownGraceMs: 4 * MINUTE,
    executor: work.executor,
  });
}

describe('CloudRunPool', () => {
  describe('the pool limit', () => {
    it('runs one Cloud run at a time by default, the next starting when the first ends', async () => {
      const work = scripted();
      const runs = pool(work);
      void runs.submit(run('a'));
      void runs.submit(run('b'));
      await flush();
      expect(work.events).toEqual(['start:a']);

      work.finish('a');
      await flush();
      expect(work.events).toEqual(['start:a', 'end:a', 'start:b']);
    });

    it('runs as many at once as the limit allows, read again on every tick', async () => {
      const work = scripted();
      let limit = 2;
      const runs = new CloudRunPool({
        resolveLimit: () => limit,
        resolveTimeLimitMinutes: () => 60,
        executor: work.executor,
      });
      for (const id of ['a', 'b', 'c', 'd']) void runs.submit(run(id));
      await flush();
      expect(work.events).toEqual(['start:a', 'start:b']);

      limit = 3;
      work.finish('a');
      await flush();
      expect(work.events.filter((e) => e.startsWith('start'))).toEqual([
        'start:a',
        'start:b',
        'start:c',
        'start:d',
      ]);
    });

    it('treats a limit below one as one', async () => {
      const work = scripted();
      const runs = pool(work, { limit: 0 });
      void runs.submit(run('a'));
      await flush();
      expect(work.events).toEqual(['start:a']);
    });
  });

  describe('per-Service ordering', () => {
    it('never overlaps two runs of one state, whatever the limit, and keeps them in order', async () => {
      const work = scripted();
      const runs = pool(work, { limit: 5 });
      void runs.submit(run('one', { stateKey: 'application:x' }));
      void runs.submit(run('two', { stateKey: 'application:x' }));
      void runs.submit(run('other', { stateKey: 'application:y' }));
      await flush();
      expect(work.events).toEqual(['start:one', 'start:other']);

      work.finish('one');
      await flush();
      expect(work.events).toContain('start:two');
    });
  });

  describe('per-Environment ordering', () => {
    it('starts a network run only once no other run of its Environment is running', async () => {
      const work = scripted();
      const runs = pool(work, { limit: 5 });
      void runs.submit(run('a'));
      void runs.submit(network('net'));
      await flush();
      expect(work.events).toEqual(['start:a']);

      work.finish('a');
      await flush();
      expect(work.events).toEqual(['start:a', 'end:a', 'start:net']);
    });

    it('holds back every other run of the Environment while the network run waits or runs, but not another Environment', async () => {
      const work = scripted();
      const runs = pool(work, { limit: 5 });
      void runs.submit(run('a'));
      void runs.submit(network('net'));
      void runs.submit(run('b'));
      void runs.submit(run('elsewhere', { environmentId: 'env-2' }));
      await flush();
      expect(work.events).toEqual(['start:a', 'start:elsewhere']);

      work.finish('a');
      await flush();
      expect(work.events).toContain('start:net');
      expect(work.events).not.toContain('start:b');

      work.finish('net');
      await flush();
      expect(work.events).toContain('start:b');
    });

    it('runs two network runs of one Environment one after the other', async () => {
      const work = scripted();
      const runs = pool(work, { limit: 5 });
      void runs.submit(network('n1'));
      void runs.submit(network('n2'));
      await flush();
      expect(work.events).toEqual(['start:n1']);
      work.finish('n1');
      await flush();
      expect(work.events).toContain('start:n2');
    });
  });

  describe('a link source first', () => {
    const pg = (id: string) =>
      run(id, { kind: 'database', stateKey: 'postgres:pg' });
    const web = (id: string) =>
      run(id, { stateKey: 'application:web', after: ['postgres:pg'] });

    it('starts a linked run only once the run of its source has ended, without holding a slot while it waits', async () => {
      const work = scripted();
      const runs = pool(work, { limit: 2 });
      void runs.submit(pg('pg-run'));
      void runs.submit(web('web-run'));
      void runs.submit(run('other'));
      await flush();
      expect(work.events).toEqual(['start:pg-run', 'start:other']);
      expect(runs.phaseOf('web-run')).toBe('waiting');

      work.finish('pg-run');
      await flush();
      expect(work.events).toEqual([
        'start:pg-run',
        'start:other',
        'end:pg-run',
        'start:web-run',
      ]);
    });

    it('lets the source start first even when the linked run was queued ahead of it', async () => {
      const work = scripted();
      const runs = pool(work, { limit: 1 });
      void runs.submit(run('busy'));
      void runs.submit(web('web-run'));
      void runs.submit(pg('pg-run'));
      await flush();
      work.finish('busy');
      await flush();
      expect(work.events).toEqual(['start:busy', 'end:busy', 'start:pg-run']);
      work.finish('pg-run');
      await flush();
      expect(work.events.at(-1)).toBe('start:web-run');
    });

    it('starts the linked run once its source failed, for the run itself to say why', async () => {
      const work = scripted();
      const runs = new CloudRunPool({
        resolveLimit: () => 2,
        resolveTimeLimitMinutes: () => 60,
        executor: (job, control) =>
          job.stateKey === 'postgres:pg'
            ? Promise.reject(new Error('RDS refused'))
            : work.executor(job, control),
      });
      const source = runs.submit(pg('pg-run'));
      void runs.submit(web('web-run'));
      await expect(source).resolves.toEqual({
        kind: 'failed',
        message: 'RDS refused',
      });
      await flush();
      expect(work.events).toEqual(['start:web-run']);
    });

    it('counts the linked run’s time limit from its own start, not from its wait', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      try {
        const work = scripted();
        const runs = pool(work, { limit: 2, timeLimitMinutes: 60 });
        void runs.submit(pg('pg-run'));
        const linked = runs.submit(web('web-run'));
        await flush();
        jest.advanceTimersByTime(50 * MINUTE);
        work.finish('pg-run');
        await flush();
        await flush();
        jest.advanceTimersByTime(30 * MINUTE);
        expect(work.events).toContain('start:web-run');
        expect(work.events).not.toContain('interrupt:web-run');
        work.finish('web-run');
        await expect(linked).resolves.toEqual({
          kind: 'finished',
          value: 'web-run',
        });
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('plan-only reads', () => {
    it('lets a waiting deploy go before a read queued ahead of it', async () => {
      const work = scripted();
      const runs = pool(work);
      void runs.submit(run('busy'));
      void runs.read(read('application:r'));
      void runs.submit(run('deploy'));
      await flush();

      work.finish('busy');
      await flush();
      expect(work.events.filter((e) => e.startsWith('start'))).toEqual([
        'start:busy',
        'start:deploy',
      ]);

      work.finish('deploy');
      await flush();
      expect(work.events).toContain('start:read:application:r');
    });

    it('joins a request for a state whose read is queued, and one whose read is running', async () => {
      const work = scripted();
      const runs = pool(work, { limit: 5 });
      const first = runs.read(read('application:r'));
      const queuedJoin = runs.read(read('application:r'));
      await flush();
      const runningJoin = runs.read(read('application:r'));
      await flush();

      work.finish('read:application:r');
      const endings = await Promise.all([first, queuedJoin, runningJoin]);
      expect(
        work.events.filter((e) => e === 'start:read:application:r'),
      ).toHaveLength(1);
      expect(endings).toEqual([
        { kind: 'finished', value: 'read:application:r' },
        { kind: 'finished', value: 'read:application:r' },
        { kind: 'finished', value: 'read:application:r' },
      ]);
    });

    it('starts a fresh read once the joined one has ended', async () => {
      const work = scripted();
      const runs = pool(work);
      const first = runs.read(read('application:r'));
      await flush();
      work.finish('read:application:r');
      await first;
      expect(runs.read(read('application:r'))).not.toBe(first);
    });
  });

  describe('Cancel', () => {
    it('takes a waiting run out of the pool; it never starts and ends cancelled', async () => {
      const work = scripted();
      const runs = pool(work);
      void runs.submit(run('a'));
      const b = runs.submit(run('b'));
      await flush();

      expect(runs.cancel('b')).toBe('cancelled');
      await expect(b).resolves.toEqual({ kind: 'cancelled' });
      work.finish('a');
      await flush();
      expect(work.events).not.toContain('start:b');
    });

    it('interrupts a run that is planning, which then ends cancelled', async () => {
      const work = scripted();
      const runs = pool(work);
      const a = runs.submit(run('a'));
      await flush();
      expect(runs.phaseOf('a')).toBe('planning');

      expect(runs.cancel('a')).toBe('cancelled');
      await expect(a).resolves.toEqual({ kind: 'cancelled' });
      expect(work.events).toEqual(['start:a', 'interrupt:a', 'end:a']);
    });

    it('is refused once the apply has begun', async () => {
      const work = scripted();
      const runs = pool(work);
      void runs.submit(run('a'));
      await flush();
      expect(work.control('a').beginApply()).toBe(true);
      expect(runs.phaseOf('a')).toBe('applying');

      expect(runs.cancel('a')).toBe('applying');
      expect(work.events).not.toContain('interrupt:a');
    });

    it('closes the apply to a run already asked to end', async () => {
      const work = scripted();
      work.hang('a');
      const runs = pool(work);
      void runs.submit(run('a'));
      await flush();
      runs.cancel('a');
      expect(work.control('a').beginApply()).toBe(false);
    });

    it('answers unknown for a run the pool does not hold', () => {
      expect(pool(scripted()).cancel('nope')).toBe('unknown');
    });
  });

  describe('Stop the run and the time limit', () => {
    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('Stop the run interrupts once, kills 5 minutes later, and the run ends stopped', async () => {
      const work = scripted();
      work.hang('a');
      const runs = pool(work);
      const a = runs.submit(run('a'));
      await flush();
      work.control('a').beginApply();

      expect(runs.stop('a', 'Ada')).toBe('stopping');
      expect(runs.stop('a', 'Ada')).toBe('stopping');
      expect(work.events).toEqual(['start:a', 'interrupt:a']);

      jest.advanceTimersByTime(5 * MINUTE - 1);
      expect(work.events).not.toContain('kill:a');
      jest.advanceTimersByTime(1);
      await expect(a).resolves.toEqual({ kind: 'stopped', by: 'Ada' });
      expect(work.events).toEqual([
        'start:a',
        'interrupt:a',
        'kill:a',
        'end:a',
      ]);
    });

    it('sends no kill to a run that ended on the interrupt', async () => {
      const work = scripted();
      const runs = pool(work);
      const a = runs.submit(run('a'));
      await flush();
      runs.stop('a', 'Ada');
      await a;
      jest.advanceTimersByTime(10 * MINUTE);
      expect(work.events).not.toContain('kill:a');
    });

    it('answers waiting for a run that has not started — that is Cancel’s', async () => {
      const work = scripted();
      const runs = pool(work);
      void runs.submit(run('a'));
      void runs.submit(run('b'));
      await flush();
      expect(runs.stop('b', 'Ada')).toBe('waiting');
      expect(runs.stop('nope', 'Ada')).toBe('unknown');
    });

    it('counts the time limit from the run’s start, not from when it was queued', async () => {
      const work = scripted();
      work.hang('b');
      const runs = pool(work, { timeLimitMinutes: 60 });
      void runs.submit(run('a'));
      const b = runs.submit(run('b'));
      await flush();

      jest.advanceTimersByTime(50 * MINUTE);
      work.finish('a');
      await flush();
      expect(work.events).toContain('start:b');

      jest.advanceTimersByTime(59 * MINUTE);
      expect(work.events).not.toContain('interrupt:b');
      jest.advanceTimersByTime(1 * MINUTE);
      expect(work.events).toContain('interrupt:b');

      jest.advanceTimersByTime(5 * MINUTE);
      await expect(b).resolves.toEqual({ kind: 'timed-out', minutes: 60 });
      expect(work.events.slice(-2)).toEqual(['kill:b', 'end:b']);
    });

    it('does not count the time a run holds the time limit, such as a build queued in its cloud', async () => {
      const work = scripted();
      work.hang('a');
      const runs = pool(work, { timeLimitMinutes: 60 });
      const a = runs.submit(run('a'));
      await flush();

      jest.advanceTimersByTime(10 * MINUTE);
      const release = work.control('a').holdTimeLimit();
      // Held well past the limit: nothing ends it.
      jest.advanceTimersByTime(120 * MINUTE);
      expect(work.events).not.toContain('interrupt:a');
      release();
      release(); // a second release changes nothing

      // 50 of its 60 minutes are left once it is released.
      jest.advanceTimersByTime(50 * MINUTE - 1);
      expect(work.events).not.toContain('interrupt:a');
      jest.advanceTimersByTime(1);
      expect(work.events).toContain('interrupt:a');
      jest.advanceTimersByTime(5 * MINUTE);
      await expect(a).resolves.toEqual({ kind: 'timed-out', minutes: 60 });
    });

    it('still lets Stop the run end a run that holds the time limit', async () => {
      const work = scripted();
      const runs = pool(work, { timeLimitMinutes: 60 });
      const a = runs.submit(run('a'));
      await flush();
      work.control('a').holdTimeLimit();
      expect(runs.stop('a', 'Ada')).toBe('stopping');
      await expect(a).resolves.toEqual({ kind: 'stopped', by: 'Ada' });
    });

    it('frees the slot for the next run once a timed-out run is killed', async () => {
      const work = scripted();
      work.hang('a');
      const runs = pool(work, { timeLimitMinutes: 1 });
      void runs.submit(run('a'));
      void runs.submit(run('b'));
      await flush();
      jest.advanceTimersByTime(6 * MINUTE);
      await flush();
      expect(work.events).toContain('start:b');
    });

    it('a run failing on its own ends failed with its message', async () => {
      const runs = new CloudRunPool({
        resolveLimit: () => 1,
        resolveTimeLimitMinutes: () => 1,
        executor: () =>
          Promise.reject(new Error('another run is using this state')),
      });
      await expect(runs.submit(run('a'))).resolves.toEqual({
        kind: 'failed',
        message: 'another run is using this state',
      });
    });
  });

  describe('shutdown', () => {
    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('interrupts every running run, waits for it, and leaves waiting runs unstarted', async () => {
      const work = scripted();
      const runs = pool(work);
      const a = runs.submit(run('a'));
      const b = runs.submit(run('b'));
      await flush();

      await runs.shutdown();
      await expect(a).resolves.toEqual({ kind: 'shutdown', started: true });
      await expect(b).resolves.toEqual({ kind: 'shutdown', started: false });
      expect(work.events).toEqual(['start:a', 'interrupt:a', 'end:a']);

      void runs.submit(run('c'));
      await flush();
      expect(work.events).not.toContain('start:c');
    });

    it('kills a run that does not end on the interrupt before systemd would', async () => {
      const work = scripted();
      work.hang('a');
      const runs = pool(work);
      const a = runs.submit(run('a'));
      await flush();

      const done = runs.shutdown();
      jest.advanceTimersByTime(4 * MINUTE);
      await done;
      await expect(a).resolves.toEqual({ kind: 'shutdown', started: true });
      expect(work.events).toContain('kill:a');
    });
  });

  it('reports a settled ending to onEnded, with the job', async () => {
    const work = scripted();
    const ended: [string | null, CloudRunEnding][] = [];
    const runs = new CloudRunPool({
      resolveLimit: () => 1,
      resolveTimeLimitMinutes: () => 1,
      executor: work.executor,
      onEnded: (job, ending) => {
        ended.push([job.deploymentId, ending]);
        return Promise.resolve();
      },
    });
    const a = runs.submit(run('a'));
    await flush();
    work.finish('a');
    await a;
    expect(ended).toEqual([['a', { kind: 'finished', value: 'a' }]]);
  });
});
