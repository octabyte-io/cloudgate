import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Prompter } from '../src/prompt.js';
import { run } from '../src/run.js';

/**
 * `cloudgate vars` driven as a person or a job drives it, against an
 * Instance faked at `fetch` that keeps one Service's variables: what changed
 * there, what was printed, and the exit code. That no value comes back is the
 * server's to hold and the CLI e2e walk's to check.
 */

const instance = 'https://cloud.acme.dev';
const env = { CLOUDGATE_KEY: 'cg_secret', CLOUDGATE_INSTANCE: instance };
const target = ['--org', 'Shop Inc', '--project', 'shop', '--env', 'staging'];

interface FakeInstance {
  /** The Service's own variables, by name. */
  variables: Record<string, string>;
  links: Record<string, { source: string; output: string }>;
  serviceType: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function names(state: FakeInstance) {
  const all = new Set([
    ...Object.keys(state.variables),
    ...Object.keys(state.links),
  ]);
  return {
    variables: [...all].sort().map((name) => ({
      name,
      linkedTo: state.links[name] ?? null,
    })),
  };
}

function answer(state: FakeInstance, url: string, init: RequestInit) {
  const path = url.slice(`${instance}/backend`.length);
  if (path === '/settings/about') {
    return json({ product: 'cloudgate', version: '9.9.9', apiUrl: null });
  }
  if (path === '/organizations')
    return json([{ id: 'org_1', name: 'Shop Inc' }]);
  if (path === '/projects') return json([{ projectId: 'prj_1', name: 'shop' }]);
  if (path === '/environments?projectId=prj_1') {
    return json([{ environmentId: 'env_s', name: 'staging' }]);
  }
  if (path === '/environments/env_s') {
    return json({
      environmentId: 'env_s',
      name: 'staging',
      services: [
        {
          serviceType: state.serviceType,
          serviceId: 'app_1',
          name: 'Shop API',
          configName: 'api',
        },
      ],
    });
  }
  if (path === '/applications/app_1/variables') {
    if (init.method === 'PATCH') {
      const body = JSON.parse(init.body as string) as {
        set?: Record<string, string>;
        unset?: string[];
      };
      Object.assign(state.variables, body.set ?? {});
      for (const name of body.unset ?? []) delete state.variables[name];
    }
    return json(names(state));
  }
  return json({ message: 'Not found' }, 404);
}

const neverAsked: Prompter = {
  choose: () => Promise.reject(new Error('asked a question')),
  confirm: () => Promise.reject(new Error('asked a question')),
  secret: () => Promise.reject(new Error('asked a question')),
  text: () => Promise.reject(new Error('asked a question')),
};

async function vars(
  args: string[],
  options: {
    state?: Partial<FakeInstance>;
    terminal?: boolean;
    stdin?: string;
    prompter?: Prompter;
  } = {},
) {
  const state: FakeInstance = {
    variables: {},
    links: {},
    serviceType: 'application',
    ...options.state,
  };
  const out = { stdout: '', stderr: '' };
  const terminal = options.terminal ?? false;
  const code = await run({
    argv: ['vars', ...args],
    env,
    cwd: mkdtempSync(join(tmpdir(), 'cloudgate-vars-')),
    prompter: options.prompter ?? neverAsked,
    stdinIsTTY: terminal,
    stdoutIsTTY: terminal,
    stderrIsTTY: terminal,
    stdout: (text) => (out.stdout += text),
    stderr: (text) => (out.stderr += text),
    readStdin: () => Promise.resolve(options.stdin ?? ''),
    fetch: (input, init) =>
      Promise.resolve(answer(state, input as string, init ?? {})),
    now: () => new Date('2026-11-03T12:00:00Z'),
  });
  return { code, ...out, state };
}

describe('cloudgate vars', () => {
  describe('set', () => {
    it('sets each KEY=VALUE, splitting at the first =, and says to deploy', async () => {
      const result = await vars(
        [
          'set',
          'A=1',
          'URL=https://x.example/?a=b',
          'EMPTY=',
          ...target,
          '--service',
          'api',
        ],
        { state: { variables: { KEEP: 'yes' } } },
      );

      expect(result.code).toBe(0);
      expect(result.state.variables).toEqual({
        KEEP: 'yes',
        A: '1',
        URL: 'https://x.example/?a=b',
        EMPTY: '',
      });
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        '✓ Set A, URL, EMPTY on api in staging. Run cloudgate deploy to pick it up.',
      );
    });

    it('reads a bare KEY from stdin when not in a terminal, without its last line break', async () => {
      const result = await vars(
        ['set', 'STRIPE_KEY', ...target, '--service', 'api'],
        {
          stdin: 'sk_live_1\n',
        },
      );

      expect(result.code).toBe(0);
      expect(result.state.variables).toEqual({ STRIPE_KEY: 'sk_live_1' });
      expect(result.stderr).not.toContain('sk_live_1');
    });

    it('refuses an empty stdin for a bare KEY with exit 2, setting nothing', async () => {
      const result = await vars([
        'set',
        'STRIPE_KEY',
        ...target,
        '--service',
        'api',
      ]);

      expect(result.code).toBe(2);
      expect(result.stderr).toContain('Error: no value for STRIPE_KEY');
      expect(result.state.variables).toEqual({});
    });

    it('asks for a bare KEY with hidden typing in a terminal', async () => {
      const asked: string[] = [];
      const result = await vars(
        ['set', 'STRIPE_KEY', ...target, '--service', 'api'],
        {
          terminal: true,
          prompter: {
            ...neverAsked,
            secret: (question) => {
              asked.push(question);
              return Promise.resolve('typed-secret');
            },
          },
        },
      );

      expect(result.code).toBe(0);
      expect(asked).toEqual(['Value for STRIPE_KEY (hidden): ']);
      expect(result.state.variables).toEqual({ STRIPE_KEY: 'typed-secret' });
    });

    it('refuses a bare KEY in a terminal with --no-input, exit 2, rather than wait on the keyboard', async () => {
      const result = await vars(
        ['set', 'STRIPE_KEY', '--no-input', ...target, '--service', 'api'],
        { terminal: true },
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toContain('Error: no value for STRIPE_KEY');
    });

    it.each([
      [['set'], 'cloudgate vars set needs KEY=VALUE'],
      [['set', '=1'], 'a KEY=VALUE with no KEY'],
      [['set', 'BAD NAME=1'], '"BAD NAME" is not a variable name'],
      [['set', 'A', 'B'], 'one KEY at a time'],
      [['set', 'A', 'B=1'], 'one KEY at a time'],
      [['set', 'A=1', 'A=2'], 'A is named twice'],
      [['set', 'A=1', '--json'], '--json'],
    ])(
      'refuses vars %j with exit 2 before any request',
      async (args, words) => {
        const result = await vars([...args, ...target, '--service', 'api']);

        expect(result.code).toBe(2);
        expect(result.stderr).toContain(words);
        expect(result.state.variables).toEqual({});
      },
    );
  });

  describe('unset', () => {
    it('removes each KEY and leaves the rest', async () => {
      const result = await vars(
        ['unset', 'A', 'B', ...target, '--service', 'api'],
        {
          state: { variables: { A: '1', B: '2', C: '3' } },
        },
      );

      expect(result.code).toBe(0);
      expect(result.state.variables).toEqual({ C: '3' });
      expect(result.stderr).toContain(
        '✓ Unset A, B on api in staging. Run cloudgate deploy to pick it up.',
      );
    });

    it.each([
      [['unset'], 'cloudgate vars unset needs KEY'],
      [['unset', 'A=1'], '"A=…" is not a variable name'],
    ])('refuses vars %j with exit 2', async (args, words) => {
      const result = await vars([...args, ...target, '--service', 'api']);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(words);
    });
  });

  describe('list', () => {
    const state = {
      variables: { LOG_LEVEL: 'debug', STRIPE_KEY: 'sk_live_1' },
      links: { DATABASE_URL: { source: 'db', output: 'url' } },
    };

    it('prints names with linked to <service>.<output> or set, and no value', async () => {
      const result = await vars(['list', ...target, '--service', 'api'], {
        state,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toBe(
        [
          'NAME          VALUE',
          'DATABASE_URL  linked to db.url',
          'LOG_LEVEL     set',
          'STRIPE_KEY    set',
          '',
        ].join('\n'),
      );
      expect(result.stderr).toContain('3 variables. Values are never shown.');
    });

    it('prints name and linkedTo entries with --json and nothing else on stdout', async () => {
      const result = await vars(
        ['list', '--json', ...target, '--service', 'api'],
        {
          state,
        },
      );

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([
        { name: 'DATABASE_URL', linkedTo: 'db.url' },
        { name: 'LOG_LEVEL', linkedTo: null },
        { name: 'STRIPE_KEY', linkedTo: null },
      ]);
    });
  });

  it('refuses a Service that is not an Application, naming its kind', async () => {
    const result = await vars(['list', ...target, '--service', 'api'], {
      state: { serviceType: 'postgres' },
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'Error: api is a Postgres database; cloudgate vars reaches the variables of Applications only',
    );
  });

  it('refuses no action, or an unknown one, with exit 2', async () => {
    expect((await vars([])).code).toBe(2);
    const unknown = await vars(['get', 'A']);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('unknown action "get"');
  });

  it.each([
    [['set', '=hunter2'], 'a KEY=VALUE with no KEY'],
    [['set', 'BAD NAME=hunter2'], '"BAD NAME" is not a variable name'],
    [['unset', 'A=hunter2'], '"A=…" is not a variable name'],
    [['list', 'A=hunter2'], 'takes no arguments, not "A=…"'],
    [['A=hunter2'], 'unknown action "A=…"'],
  ])('never prints what follows = in a misused %j', async (args, words) => {
    const result = await vars([...args, ...target, '--service', 'api']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(words);
    expect(result.stdout + result.stderr).not.toContain('hunter2');
  });
});
