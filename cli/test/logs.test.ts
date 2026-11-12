import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SocketLike } from '../src/deployment-log-stream.js';
import type { Prompter } from '../src/prompt.js';
import { run } from '../src/run.js';

/**
 * `cloudgate logs`, driven as a person or a CI job drives it, against an
 * Instance that `fetch` and a socket double answer. The built command against
 * the real backend is the CLI e2e suite's walk (`backend/test/cli/`).
 */

const neverAsked: Prompter = {
  choose: () => Promise.reject(new Error('asked a question')),
  confirm: () => Promise.reject(new Error('asked a question')),
  secret: () => Promise.reject(new Error('asked a question')),
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function text(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/plain' },
  });
}

const deployment = (status: string, extra: Record<string, unknown> = {}) => ({
  deploymentId: 'dpl_7Hq2Xc',
  status,
  createdAt: '2026-11-03T12:00:00.000Z',
  startedAt: '2026-11-03T12:00:05.000Z',
  finishedAt: null,
  ...extra,
});

/** Lines `first`..`last`, each `<prefix> <n>`. */
const numbered = (prefix: string, first: number, last: number) =>
  Array.from(
    { length: last - first + 1 },
    (_, index) => `${prefix} ${first + index}`,
  );

/**
 * A socket double: answers each socket it is asked to open with `frames`,
 * then a close with `closeCode` when there is one; with none it stays open
 * for ever, as `/listen-deployment` and a followed container log do.
 */
function socketDouble(
  answer: (url: string) => { frames: string[]; closeCode?: number },
) {
  const opened: string[] = [];
  let closedByCli = false;
  const open = (url: string): SocketLike => {
    opened.push(url);
    const { frames, closeCode } = answer(url);
    const listeners: Record<string, ((event: never) => void)[]> = {};
    setImmediate(() => {
      for (const data of frames)
        for (const listener of listeners.message ?? [])
          listener({ data } as never);
      if (closeCode !== undefined)
        for (const listener of listeners.close ?? [])
          listener({ code: closeCode, reason: '' } as never);
    });
    return {
      addEventListener: (type: string, listener: (event: never) => void) => {
        (listeners[type] ??= []).push(listener);
      },
      close: () => {
        closedByCli = true;
      },
    };
  };
  return { open, opened, closed: () => closedByCli };
}

/** `/listen-deployment`: `tail -f` of the log file, which never closes. */
const neverClosing = (frames: string[]) => socketDouble(() => ({ frames }));

/**
 * `/docker-container-logs` as the Instance serves it: through a pty (so
 * `\r\n`), `--tail` lines of each Swarm task in turn; asked not to follow,
 * closed with 4014 as the follower exits, and followed, open for ever.
 */
function containerLogs(tasks: string[][]) {
  return socketDouble((url) => {
    const query = new URL(url).searchParams;
    const tail = Number(query.get('tail'));
    const frames = tasks.map((lines) =>
      lines
        .slice(-tail)
        .map((line) => `${line}\r\n`)
        .join(''),
    );
    return query.get('follow') === 'false'
      ? { frames, closeCode: 4014 }
      : { frames };
  });
}

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'cloudgate-logs-'));
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

const TARGET = [
  '--org',
  'Shop Inc',
  '--project',
  'shop',
  '--env',
  'staging',
  '--service',
  'api',
];

interface RuntimeLogRead {
  lines: { id: string; at: number; task: string; message: string }[];
  next: number;
  more: boolean;
}

interface Options {
  /** Where the Application runs: a Server (the default) or a Cloud account. */
  place?: 'server' | 'cloud';
  /** What `GET /deployments/:id` answers, one per ask; the last repeats. */
  statuses?: Record<string, unknown>[];
  /** `GET /applications/app_1/deployments`, newest first. */
  deployments?: { deploymentId: string; status: string; createdAt: string }[];
  /** `GET /deployments/:id/logs`'s text. */
  deploymentLog?: string;
  socket?: ReturnType<typeof socketDouble>;
  /** `GET /applications/app_1/runtime-log`'s answers, one per read; the last repeats. */
  runtimeLog?: RuntimeLogRead[];
  /** Ctrl-C after this many sleeps. */
  interruptAfterSleeps?: number;
  /** Ctrl-C once stdout holds this. */
  interruptOnceShown?: string;
  /** The kind of Service `--service api` names. */
  kind?: string;
}

async function logs(argv: string[], options: Options = {}) {
  const out = { stdout: '', stderr: '' };
  const statuses = options.statuses ?? [deployment('running')];
  const requested: string[] = [];
  const runtimeReads = options.runtimeLog ?? [
    { lines: [], next: 0, more: false },
  ];
  let asked = 0;
  let read = 0;
  let slept = 0;
  let interrupt: (() => void) | undefined;
  const socket = options.socket ?? neverClosing([]);
  const respond = (url: string): Response => {
    const path = url.replace('https://cloud.acme.dev/backend', '');
    requested.push(path);
    if (path === '/settings/about') {
      return json({
        product: 'cloudgate',
        version: '9.9.9',
        apiUrl: 'https://api.cloud.acme.dev',
      });
    }
    if (path === '/organizations')
      return json([{ id: 'org_1', name: 'Shop Inc' }]);
    if (path === '/projects')
      return json([{ projectId: 'prj_1', name: 'shop' }]);
    if (path === '/environments?projectId=prj_1')
      return json([{ environmentId: 'env_1', name: 'staging' }]);
    if (path === '/environments/env_1') {
      return json({
        environmentId: 'env_1',
        name: 'staging',
        services: [
          {
            serviceType: options.kind ?? 'application',
            serviceId: 'app_1',
            name: 'Shop API',
            configName: 'api',
          },
        ],
      });
    }
    if (path === '/applications/app_1') {
      return json(
        options.place === 'cloud'
          ? {
              appName: 'shop-api',
              serverId: null,
              cloudAccountId: 'cla_1',
              env: 'S=1',
            }
          : {
              appName: 'shop-api',
              serverId: 'srv_1',
              cloudAccountId: null,
              env: 'S=1',
            },
      );
    }
    if (path === '/applications/app_1/deployments') {
      return json(options.deployments ?? []);
    }
    if (path.startsWith('/applications/app_1/runtime-log')) {
      const answer = runtimeReads[Math.min(read, runtimeReads.length - 1)];
      read += 1;
      return json(answer);
    }
    if (path.startsWith('/deployments/dpl_7Hq2Xc/logs')) {
      // `tail -n <tail>` of the log file, as the Instance answers it.
      const tail = Number(new URL(url).searchParams.get('tail') ?? '100');
      const lines = (options.deploymentLog ?? '').split('\n').slice(0, -1);
      return text(
        lines
          .slice(-tail)
          .map((line) => `${line}\n`)
          .join(''),
      );
    }
    if (path === '/deployments/dpl_7Hq2Xc') {
      const next = statuses[Math.min(asked, statuses.length - 1)];
      asked += 1;
      return json(next);
    }
    return json({ statusCode: 404, message: 'Not found' }, 404);
  };
  const code = await run({
    argv: ['logs', ...argv],
    env: { CLOUDGATE_KEY: 'cg_secret', CLOUDGATE_INSTANCE: 'cloud.acme.dev' },
    cwd: folder,
    prompter: neverAsked,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stderrIsTTY: false,
    stdout: (chunk) => {
      out.stdout += chunk;
      if (
        options.interruptOnceShown &&
        out.stdout.includes(options.interruptOnceShown)
      )
        setImmediate(() => interrupt?.());
    },
    stderr: (chunk) => (out.stderr += chunk),
    fetch: (input) => Promise.resolve(respond(input as string)),
    openSocket: socket.open,
    sleep: () => {
      slept += 1;
      if (slept === options.interruptAfterSleeps) interrupt?.();
      return new Promise((resolve) => setImmediate(resolve));
    },
    interrupts: {
      listen: (listener) => {
        interrupt = listener;
        return () => (interrupt = undefined);
      },
    },
    now: () => new Date('2026-11-03T12:00:00Z'),
  });
  return { code, ...out, requested, socket };
}

describe('cloudgate logs --deployment', () => {
  it('prints the tail of a named Deployment log on stdout, -n lines of it, and exits 0', async () => {
    const log = numbered('[build] step', 1, 150);
    const result = await logs(
      [...TARGET, '--deployment', 'dpl_7Hq2Xc', '-n', '20'],
      { deploymentLog: `${log.join('\n')}\n` },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${log.slice(-20).join('\n')}\n`);

    const byDefault = await logs([...TARGET, '--deployment', 'dpl_7Hq2Xc'], {
      deploymentLog: `${log.join('\n')}\n`,
    });
    expect(byDefault.stdout).toBe(`${log.slice(-100).join('\n')}\n`);
  });

  it('reads the latest Deployment log when no id is given', async () => {
    const result = await logs([...TARGET, '--deployment'], {
      deployments: [
        {
          deploymentId: 'dpl_7Hq2Xc',
          status: 'error',
          createdAt: '2026-11-03T12:00:00.000Z',
        },
        {
          deploymentId: 'dpl_older',
          status: 'done',
          createdAt: '2026-11-02T12:00:00.000Z',
        },
      ],
      deploymentLog: '[build] the latest one\n',
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('[build] the latest one\n');
  });

  it('refuses with exit 1 when the Service has no Deployment yet', async () => {
    const result = await logs([...TARGET, '--deployment'], { deployments: [] });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Error: api has no Deployment yet');
    expect(result.stdout).toBe('');
  });

  it('with -f, follows a running Deployment from its first line and ends by itself when it finishes, though the stream never closes', async () => {
    const socket = neverClosing(['[build] step 1\n', '[build] step 2\n']);
    const result = await logs([...TARGET, '--deployment', 'dpl_7Hq2Xc', '-f'], {
      socket,
      statuses: [
        deployment('running'),
        deployment('running'),
        deployment('done', { finishedAt: '2026-11-03T12:01:47.000Z' }),
      ],
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('[build] step 1\n[build] step 2\n');
    expect(result.stderr).toContain('Deployment dpl_7Hq2Xc done\n');
    expect(socket.opened).toEqual([
      'wss://api.cloud.acme.dev/listen-deployment?deploymentId=dpl_7Hq2Xc',
    ]);
    expect(socket.closed()).toBe(true);
  });

  it('with -f, reads a failed Deployment to its end and still exits 0, saying it failed', async () => {
    const result = await logs([...TARGET, '--deployment', 'dpl_7Hq2Xc', '-f'], {
      socket: neverClosing(['[build] boom']),
      statuses: [deployment('error')],
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('[build] boom\n');
    expect(result.stderr).toContain('Deployment dpl_7Hq2Xc failed\n');
  });

  it('with -f, Ctrl-C stops following with exit 130', async () => {
    const socket = neverClosing(['[build] step 1\n']);
    const result = await logs([...TARGET, '--deployment', 'dpl_7Hq2Xc', '-f'], {
      socket,
      statuses: [deployment('running')],
      interruptAfterSleeps: 3,
    });

    expect(result.code).toBe(130);
    expect(socket.closed()).toBe(true);
  });
});

describe('cloudgate logs, on a Server', () => {
  const taskA = numbered('a: request', 1, 30);
  const taskB = numbered('b: request', 1, 30);

  it('prints the last 100 lines of the Runtime log and exits 0 once the backlog ends', async () => {
    const result = await logs(TARGET, {
      socket: containerLogs([numbered('line', 1, 150)]),
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${numbered('line', 51, 150).join('\n')}\n`);
  });

  it('with -n 20 prints at most 20 lines, though each Swarm task sends its own 20', async () => {
    const result = await logs([...TARGET, '-n', '20'], {
      socket: containerLogs([taskA, taskB]),
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${taskB.slice(-20).join('\n')}\n`);
  });

  it('with -f keeps printing until Ctrl-C, then exits 130', async () => {
    const socket = containerLogs([taskA]);
    const result = await logs([...TARGET, '-f', '-n', '5'], {
      socket,
      interruptOnceShown: 'a: request 30\n',
    });

    expect(result.code).toBe(130);
    expect(result.stdout).toBe(`${taskA.slice(-5).join('\n')}\n`);
    expect(socket.closed()).toBe(true);
  });

  it('exits 1 when the Instance refuses the stream', async () => {
    const result = await logs(TARGET, {
      socket: socketDouble(() => ({ frames: [], closeCode: 4003 })),
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Error: the Runtime log stream closed');
    expect(result.stdout).toBe('');
  });
});

describe('cloudgate logs, in a Cloud account', () => {
  const at = Date.parse('2026-11-03T11:58:00.000Z');
  const line = (index: number) => ({
    id: `evt_${index}`,
    at: at + index * 1000,
    task: 'task_a',
    message: `request ${index}`,
  });
  const shown = (index: number) =>
    `${new Date(at + index * 1000).toISOString()} request ${index}\n`;
  const range = (first: number, last: number) =>
    Array.from({ length: last - first + 1 }, (_, i) => first + i);

  it('with -n 20 prints the last 20 lines, reading on while lines were left', async () => {
    const result = await logs([...TARGET, '-n', '20'], {
      place: 'cloud',
      runtimeLog: [
        { lines: range(1, 30).map(line), next: at + 30_000, more: true },
        { lines: range(30, 45).map(line), next: at + 45_000, more: false },
      ],
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(range(26, 45).map(shown).join(''));
    expect(
      result.requested.filter((path) => path.includes('runtime-log')),
    ).toEqual([
      '/applications/app_1/runtime-log',
      `/applications/app_1/runtime-log?since=${at + 30_000}`,
    ]);
  });

  it('reads back as far as the Instance reads (since=0) when the last few minutes hold fewer than -n lines', async () => {
    const result = await logs([...TARGET, '-n', '20'], {
      place: 'cloud',
      runtimeLog: [
        { lines: range(41, 45).map(line), next: at + 45_000, more: false },
        { lines: range(1, 30).map(line), next: at + 30_000, more: true },
        { lines: range(30, 45).map(line), next: at + 45_000, more: false },
      ],
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(range(26, 45).map(shown).join(''));
    expect(
      result.requested.filter((path) => path.includes('runtime-log')),
    ).toEqual([
      '/applications/app_1/runtime-log',
      '/applications/app_1/runtime-log?since=0',
      `/applications/app_1/runtime-log?since=${at + 30_000}`,
    ]);
  });

  it('with -f prints each new line once, though reads overlap, until Ctrl-C (exit 130)', async () => {
    const result = await logs([...TARGET, '-f'], {
      place: 'cloud',
      runtimeLog: [
        { lines: range(1, 3).map(line), next: at + 3_000, more: false },
        // Fewer than 100, so read again from as far back as the Instance reads.
        { lines: range(1, 3).map(line), next: at + 3_000, more: false },
        { lines: range(2, 5).map(line), next: at + 5_000, more: false },
        { lines: range(4, 6).map(line), next: at + 6_000, more: false },
      ],
      interruptAfterSleeps: 3,
    });

    expect(result.code).toBe(130);
    expect(result.stdout).toBe(range(1, 6).map(shown).join(''));
  });
});

describe('cloudgate logs, wrong use', () => {
  it.each([['0'], ['abc'], ['10001'], ['2.5']])(
    'refuses -n %s with exit 2 before asking the Instance anything',
    async (lines) => {
      const result = await logs([...TARGET, '-n', lines]);

      expect(result.code).toBe(2);
      expect(result.stderr).toContain('Error: -n takes a number of lines');
    },
  );

  it('refuses an id without --deployment with exit 2', async () => {
    const result = await logs([...TARGET, 'dpl_7Hq2Xc']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('cloudgate logs --deployment dpl_7Hq2Xc');
  });

  it('refuses the Runtime log of a Compose stack with exit 1', async () => {
    const result = await logs(TARGET, { kind: 'compose' });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'Error: api is a Compose stack; cloudgate logs reads the Runtime log of Applications only',
    );
  });
});
