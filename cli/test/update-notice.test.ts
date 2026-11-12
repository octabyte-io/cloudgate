import { describe, expect, it } from 'vitest';

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '../src/run.js';
import {
  fileUpdateStateStore,
  startUpdateCheck,
} from '../src/update-notice.js';
import type {
  UpdateCheckState,
  UpdateStateStore,
} from '../src/update-notice.js';

/**
 * The update notice's rule (CLI spec, Output conventions), through the one
 * call `run` makes: start a check when the run begins, finish it when the
 * command has. npm and the state file are the doubles; what is checked is what
 * a person sees on stderr, what is remembered, and whether npm was asked.
 */
const NOW = new Date('2026-11-03T12:00:00Z');
const hoursAgo = (hours: number) =>
  new Date(NOW.getTime() - hours * 3_600_000).toISOString();

function memoryStore(initial?: unknown) {
  const store = {
    state: initial as UpdateCheckState | undefined,
    read: () => Promise.resolve(store.state),
    write: (state: UpdateCheckState) => {
      store.state = state;
      return Promise.resolve();
    },
  };
  return store;
}

function npm(distTags: Record<string, string>) {
  const asked: string[] = [];
  const fetch = ((input: string) => {
    asked.push(String(input));
    return Promise.resolve(
      new Response(JSON.stringify(distTags), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

/** A command that takes a moment, so an answering npm has answered. */
const aMoment = () => new Promise((resolve) => setTimeout(resolve, 5));

async function check(options: {
  current?: string;
  env?: Record<string, string | undefined>;
  stdoutIsTTY?: boolean;
  stderrIsTTY?: boolean;
  store?: UpdateStateStore;
  fetch?: typeof globalThis.fetch;
}) {
  const handle = startUpdateCheck({
    current: options.current ?? '0.3.2',
    env: options.env ?? {},
    stdoutIsTTY: options.stdoutIsTTY ?? true,
    stderrIsTTY: options.stderrIsTTY ?? true,
    now: () => NOW,
    fetch: options.fetch ?? npm({ latest: '0.4.0' }).fetch,
    store: options.store ?? memoryStore(),
  });
  await aMoment();
  return handle.finish();
}

const NOTICE_0_4_0 =
  '\nA new version is out: 0.4.0 (you have 0.3.2).\nUpdate: npm install -g @octabyte-io/cloudgate@latest\n';

describe('the update notice', () => {
  it('names the newer version on npm and the exact command to get it', async () => {
    const store = memoryStore();
    const registry = npm({ latest: '0.4.0' });

    const notice = await check({ store, fetch: registry.fetch });

    expect(notice).toBe(NOTICE_0_4_0);
    expect(registry.asked).toEqual([
      'https://registry.npmjs.org/-/package/@octabyte-io/cloudgate/dist-tags',
    ]);
    expect(store.state).toEqual({
      checkedAt: NOW.toISOString(),
      newest: { version: '0.4.0', distTag: 'latest' },
      notifiedAt: NOW.toISOString(),
    });
  });

  it('says nothing when npm has the version already running, and remembers the check', async () => {
    const store = memoryStore();

    const notice = await check({
      current: '0.4.0',
      store,
      fetch: npm({ latest: '0.4.0' }).fetch,
    });

    expect(notice).toBeUndefined();
    expect(store.state).toEqual({
      checkedAt: NOW.toISOString(),
      newest: { version: '0.4.0', distTag: 'latest' },
    });
  });

  it('says nothing when the running version is newer than npm', async () => {
    expect(
      await check({ current: '0.5.0', fetch: npm({ latest: '0.4.0' }).fetch }),
    ).toBeUndefined();
  });

  it.each([
    ['0.10.0', '0.9.0'],
    ['1.0.0', '1.0.0-rc.1'],
    ['1.0.0-beta.10', '1.0.0-beta.2'],
    ['1.0.0-alpha.1', '1.0.0-alpha'],
    ['1.0.0-rc.1', '1.0.0-beta.11'],
    ['1.0.0-beta', '1.0.0-1'],
  ])('counts %s as newer than %s', async (newer, older) => {
    const registry = npm({ latest: newer, next: newer });
    expect(await check({ current: older, fetch: registry.fetch })).toContain(
      `A new version is out: ${newer} (you have ${older}).`,
    );
    expect(
      await check({ current: newer, fetch: npm({ latest: older }).fetch }),
    ).toBeUndefined();
  });

  describe('at most once a day', () => {
    it('does not ask npm again within 24 hours, and does not repeat the notice', async () => {
      const registry = npm({ latest: '0.5.0' });
      const state = {
        checkedAt: hoursAgo(23),
        newest: { version: '0.4.0', distTag: 'latest' },
        notifiedAt: hoursAgo(23),
      };
      const store = memoryStore(state);

      expect(await check({ store, fetch: registry.fetch })).toBeUndefined();
      expect(registry.asked).toEqual([]);
      expect(store.state).toEqual(state);
    });

    it('shows a remembered newer version without asking npm, when not shown today', async () => {
      const registry = npm({ latest: '0.5.0' });
      const store = memoryStore({
        checkedAt: hoursAgo(2),
        newest: { version: '0.4.0', distTag: 'latest' },
        notifiedAt: hoursAgo(30),
      });

      expect(await check({ store, fetch: registry.fetch })).toBe(NOTICE_0_4_0);
      expect(registry.asked).toEqual([]);
      expect(store.state?.notifiedAt).toBe(NOW.toISOString());
    });

    it('asks npm again after 24 hours', async () => {
      const registry = npm({ latest: '0.4.0' });
      const store = memoryStore({ checkedAt: hoursAgo(24) });

      expect(await check({ store, fetch: registry.fetch })).toBe(NOTICE_0_4_0);
      expect(registry.asked).toHaveLength(1);
    });

    it('keeps the notice to once a day even when npm is asked again', async () => {
      const store = memoryStore({
        checkedAt: hoursAgo(25),
        newest: { version: '0.4.0', distTag: 'latest' },
        notifiedAt: hoursAgo(20),
      });

      expect(
        await check({ store, fetch: npm({ latest: '0.4.1' }).fetch }),
      ).toBeUndefined();
      expect(store.state).toEqual({
        checkedAt: NOW.toISOString(),
        newest: { version: '0.4.1', distTag: 'latest' },
        notifiedAt: hoursAgo(20),
      });
    });

    it('treats a check stamped in the future as stale', async () => {
      const registry = npm({ latest: '0.4.0' });
      const store = memoryStore({
        checkedAt: '2027-01-01T00:00:00Z',
        notifiedAt: '2027-01-01T00:00:00Z',
      });

      expect(await check({ store, fetch: registry.fetch })).toBe(NOTICE_0_4_0);
    });

    it.each([
      ['a string', 'nonsense'],
      ['an array', []],
      ['bad dates', { checkedAt: 'yesterday', notifiedAt: 7 }],
      ['a bad version', { checkedAt: hoursAgo(1), newest: { version: 'x' } }],
    ])('reads a state file holding %s as never checked', async (_, state) => {
      const registry = npm({ latest: '0.4.0' });
      expect(
        await check({ store: memoryStore(state), fetch: registry.fetch }),
      ).toBe(NOTICE_0_4_0);
      expect(registry.asked).toHaveLength(1);
    });
  });

  describe('silent, without asking npm or touching the state file', () => {
    it.each<[string, Parameters<typeof check>[0]]>([
      ['CI is set', { env: { CI: 'true' } }],
      ['CI is 1', { env: { CI: '1' } }],
      [
        'CLOUDGATE_NO_UPDATE_NOTIFIER is set',
        { env: { CLOUDGATE_NO_UPDATE_NOTIFIER: '1' } },
      ],
      ['stdout is a pipe', { stdoutIsTTY: false }],
      ['stderr is a pipe', { stderrIsTTY: false }],
      ['both are pipes', { stdoutIsTTY: false, stderrIsTTY: false }],
    ])('when %s', async (_, options) => {
      const registry = npm({ latest: '0.4.0' });
      let touched = false;
      const store: UpdateStateStore = {
        read: () => {
          touched = true;
          return Promise.resolve(undefined);
        },
        write: () => {
          touched = true;
          return Promise.resolve();
        },
      };

      expect(
        await check({ ...options, store, fetch: registry.fetch }),
      ).toBeUndefined();
      expect(registry.asked).toEqual([]);
      expect(touched).toBe(false);
    });

    it('counts an empty CI or CLOUDGATE_NO_UPDATE_NOTIFIER as unset', async () => {
      expect(
        await check({ env: { CI: '', CLOUDGATE_NO_UPDATE_NOTIFIER: '' } }),
      ).toBe(NOTICE_0_4_0);
    });
  });

  describe('prereleases', () => {
    it('offers next to someone running a prerelease, when it is newer than latest', async () => {
      const notice = await check({
        current: '0.0.2-beta.1',
        fetch: npm({ latest: '0.0.1', next: '0.0.2-beta.2' }).fetch,
      });
      expect(notice).toBe(
        '\nA new version is out: 0.0.2-beta.2 (you have 0.0.2-beta.1).\nUpdate: npm install -g @octabyte-io/cloudgate@next\n',
      );
    });

    it('offers latest to someone running a prerelease once that version is out', async () => {
      const notice = await check({
        current: '0.1.0-beta.3',
        fetch: npm({ latest: '0.1.0', next: '0.1.0-beta.3' }).fetch,
      });
      expect(notice).toContain(
        'Update: npm install -g @octabyte-io/cloudgate@latest',
      );
    });

    it('never offers next to someone running a plain version', async () => {
      expect(
        await check({
          current: '0.1.0',
          fetch: npm({ latest: '0.1.0', next: '0.2.0-beta.1' }).fetch,
        }),
      ).toBeUndefined();
    });
  });

  describe('never in the way', () => {
    it('drops a question npm has not answered when the command is done, and asks again next run', async () => {
      let aborted = false;
      const silentNpm = ((_: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('aborted', 'AbortError'));
          });
        })) as typeof globalThis.fetch;
      const store = memoryStore();

      const handle = startUpdateCheck({
        current: '0.3.2',
        env: {},
        stdoutIsTTY: true,
        stderrIsTTY: true,
        now: () => NOW,
        fetch: silentNpm,
        store,
      });
      await aMoment();
      const started = Date.now();
      const notice = await handle.finish();

      expect(Date.now() - started).toBeLessThan(100);
      expect(notice).toBeUndefined();
      expect(aborted).toBe(true);
      expect(store.state?.checkedAt).toBeUndefined();
    });

    it('still shows a remembered notice when npm is dropped', async () => {
      const silentNpm = ((_: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        })) as typeof globalThis.fetch;
      const store = memoryStore({
        checkedAt: hoursAgo(30),
        newest: { version: '0.4.0', distTag: 'latest' },
      });

      expect(await check({ store, fetch: silentNpm })).toBe(NOTICE_0_4_0);
      expect(store.state?.checkedAt).toBe(hoursAgo(30));
    });

    it.each<[string, typeof globalThis.fetch]>([
      [
        'the network fails',
        () => Promise.reject(new TypeError('fetch failed')),
      ],
      [
        'npm answers 500',
        () => Promise.resolve(new Response('', { status: 500 })),
      ],
      [
        'npm answers 404',
        () => Promise.resolve(new Response('{}', { status: 404 })),
      ],
      [
        'npm answers HTML',
        () => Promise.resolve(new Response('<html>', { status: 200 })),
      ],
      [
        'npm names no latest',
        () => Promise.resolve(Response.json({ beta: '9.0.0' })),
      ],
      [
        'npm names a non-version',
        () => Promise.resolve(Response.json({ latest: 'soon' })),
      ],
    ])(
      'says nothing when %s, and does not ask again today',
      async (_, fetch) => {
        const store = memoryStore();
        expect(await check({ store, fetch })).toBeUndefined();
        expect(store.state).toEqual({ checkedAt: NOW.toISOString() });
      },
    );

    it('says nothing and does not fail when the state file cannot be read or written', async () => {
      const broken: UpdateStateStore = {
        read: () => Promise.reject(new Error('EACCES')),
        write: () => Promise.reject(new Error('EROFS')),
      };
      expect(await check({ store: broken })).toBe(NOTICE_0_4_0);
    });

    it('does not fail when the state file read throws outright', async () => {
      const throwing: UpdateStateStore = {
        read: () => {
          throw new Error('EACCES');
        },
        write: () => {
          throw new Error('EROFS');
        },
      };
      expect(await check({ store: throwing })).toBe(NOTICE_0_4_0);
    });
  });
});

describe('the update notice in a whole run', () => {
  const whoami = {
    email: 'ci@shop.example',
    organization: { id: 'org_3kP', name: 'Shop Inc' },
    key: { id: 'key_1', name: 'ci', start: 'cg_ab', expiresAt: null },
  };

  function invoke(options: {
    dir: string;
    terminal: boolean;
    asked: string[];
  }) {
    const out = { stdout: '', stderr: '' };
    return run({
      argv: ['whoami', '--instance', 'https://cloud.acme.dev'],
      env: { CLOUDGATE_KEY: 'cg_secret', NO_COLOR: '1' },
      // The update-notice folder holds no Folder link; nothing is asked.
      cwd: options.dir,
      prompter: {
        choose: () => Promise.reject(new Error('asked a question')),
        confirm: () => Promise.reject(new Error('asked a question')),
        secret: () => Promise.reject(new Error('asked a question')),
      },
      stdinIsTTY: options.terminal,
      stdoutIsTTY: options.terminal,
      stderrIsTTY: options.terminal,
      stdout: (text) => (out.stdout += text),
      stderr: (text) => (out.stderr += text),
      fetch: async (input) => {
        const url = input as string;
        // The Instance check answers first, and is not what this test counts.
        if (url.endsWith('/backend/settings/about')) {
          return Response.json({
            product: 'cloudgate',
            version: '9.9.9',
            apiUrl: null,
          });
        }
        options.asked.push(new URL(url).origin);
        if (url.startsWith('https://registry.npmjs.org/')) {
          return Response.json({ latest: '0.4.0' });
        }
        // An Instance takes a moment to answer; npm, here, does not.
        await aMoment();
        return Response.json(whoami);
      },
      now: () => NOW,
      updateState: fileUpdateStateStore(options.dir),
    }).then((code) => ({ code, ...out }));
  }

  it('comes after the command on stderr, once a day, and never in a pipe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cloudgate-update-'));
    try {
      const piped: string[] = [];
      const pipedRun = await invoke({ dir, terminal: false, asked: piped });
      expect(pipedRun.stderr).toBe('Using instance https://cloud.acme.dev\n');
      expect(piped).toEqual(['https://cloud.acme.dev']);

      const asked: string[] = [];
      const first = await invoke({ dir, terminal: true, asked });
      expect(first.code).toBe(0);
      // In a terminal the spinner draws and erases itself in between.
      expect(first.stderr).toMatch(
        /^Using instance https:\/\/cloud\.acme\.dev\n/,
      );
      expect(first.stderr).toMatch(
        /\nA new version is out: 0\.4\.0 \(you have 0\.0\.0-test\)\.\nUpdate: npm install -g @octabyte-io\/cloudgate@latest\n$/,
      );
      expect(asked).toContain('https://registry.npmjs.org');
      expect(
        JSON.parse(readFileSync(join(dir, 'update-check.json'), 'utf8')),
      ).toMatchObject({ checkedAt: NOW.toISOString() });

      const again: string[] = [];
      const second = await invoke({ dir, terminal: true, asked: again });
      expect(second.stderr).not.toContain('A new version');
      expect(again).toEqual(['https://cloud.acme.dev']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates the config folder for its state file when there is none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cloudgate-update-'));
    try {
      const store = fileUpdateStateStore(join(dir, 'not', 'yet'));
      expect(await store.read()).toBeUndefined();
      await store.write({ checkedAt: NOW.toISOString() });
      expect(await store.read()).toEqual({ checkedAt: NOW.toISOString() });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
