import { describe, expect, it } from 'vitest';

import { watchDeployment } from '../src/deployment-watch.js';
import type {
  DeploymentLog,
  DeploymentStatus,
  DeploymentView,
} from '../src/deployment-watch.js';

function view(status: DeploymentStatus): DeploymentView {
  return {
    deploymentId: 'dpl_1',
    status,
    createdAt: '2026-11-03T12:00:00.000Z',
    startedAt: null,
    finishedAt: null,
  };
}

/** The Instance's answers to `GET /deployments/:id`, one per read; the last repeats. */
function reads(...statuses: DeploymentStatus[]) {
  const asked: DeploymentStatus[] = [];
  return {
    asked,
    read: () => {
      const status = statuses[Math.min(asked.length, statuses.length - 1)];
      asked.push(status);
      return Promise.resolve(view(status));
    },
  };
}

/** A Deployment log stream the test writes to and may close; it never closes by itself. */
function stream() {
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
  const state = {
    write: (text: string): void => void text,
    closedByWatcher: false,
    endByItself: () => resolveClosed(),
  };
  const follow = (onText: (text: string) => void): DeploymentLog => {
    state.write = onText;
    return {
      closed,
      close: () => {
        state.closedByWatcher = true;
        resolveClosed();
      },
    };
  };
  return { state, follow };
}

const instant = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('watchDeployment', () => {
  it('ends when GET /deployments/:id says done though the stream never closes, closing it', async () => {
    const log = stream();
    const status = reads('pending', 'running', 'running', 'done');
    const printed: string[] = [];

    const watching = watchDeployment({
      read: status.read,
      follow: log.follow,
      onText: (text) => printed.push(text),
      sleep: instant,
      signal: new AbortController().signal,
    });
    log.state.write('[build] step 1\n');

    expect(await watching).toEqual({
      kind: 'finished',
      deployment: view('done'),
    });
    expect(status.asked).toEqual(['pending', 'running', 'running', 'done']);
    expect(printed).toEqual(['[build] step 1\n']);
    expect(log.state.closedByWatcher).toBe(true);
  });

  it('counts failed and cancelled as finished, and held as not', async () => {
    for (const last of ['error', 'cancelled'] as const) {
      const status = reads('held', 'running', last);
      const result = await watchDeployment({
        read: status.read,
        follow: stream().follow,
        onText: () => {},
        sleep: instant,
        signal: new AbortController().signal,
      });
      expect(result).toEqual({ kind: 'finished', deployment: view(last) });
      expect(status.asked).toEqual(['held', 'running', last]);
    }
  });

  it('goes on asking when the stream ends before the Deployment does', async () => {
    const log = stream();
    log.state.endByItself();
    const status = reads('running', 'running', 'running', 'done');

    const result = await watchDeployment({
      read: status.read,
      follow: log.follow,
      onText: () => {},
      sleep: instant,
      signal: new AbortController().signal,
    });

    expect(result.kind).toBe('finished');
    expect(status.asked).toHaveLength(4);
  });

  it('ends with no stream at all, by asking alone', async () => {
    const status = reads('running', 'done');

    const result = await watchDeployment({
      read: status.read,
      onText: () => {},
      sleep: instant,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ kind: 'finished', deployment: view('done') });
  });

  it('stops watching when interrupted, closing the stream and asking no more', async () => {
    const log = stream();
    const status = reads('running');
    const stop = new AbortController();
    let slept = 0;

    const result = await watchDeployment({
      read: status.read,
      follow: log.follow,
      onText: () => {},
      sleep: () => {
        slept += 1;
        if (slept === 1) return instant();
        stop.abort();
        // A long wait, which the interrupt cuts short.
        return new Promise((resolve) => setTimeout(resolve, 60_000).unref());
      },
      signal: stop.signal,
    });

    expect(result).toEqual({ kind: 'interrupted' });
    expect(log.state.closedByWatcher).toBe(true);
    expect(status.asked).toEqual(['running', 'running']);
  });
});
