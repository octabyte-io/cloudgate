import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Interrupts } from '../src/command.js';
import type { DockerResult, DockerRun } from '../src/docker.js';
import { run } from '../src/run.js';

/**
 * `cloudgate template try` through `run()`, with Docker and the network
 * replaced at their boundaries: the Docker runner records what it was asked
 * to run and what the stack folder held when `up` ran, and `fetch` answers
 * each Domain's probe. Which values, compose file and config files an
 * Instance would make is the backend's code, tested where it lives; this
 * proves `try` hands them to Docker in an Instance's layout, judges each
 * Domain, and always tears down.
 */

/** What the stack folder held when `docker compose up` ran. */
interface StackSeen {
  composeFile: string;
  env: string;
  /** By path below `files/`. */
  files: Record<string, string>;
}

interface Docker {
  calls: { args: string[]; cwd?: string }[];
  /** Filled in when `up` runs. */
  stack?: StackSeen;
  /** The folder `up` ran in. */
  upFolder?: string;
}

/** A Docker that has Compose v2 and starts whatever it is given. */
function fakeDocker(
  answer: (
    args: string[],
    signal?: AbortSignal,
  ) => DockerResult | Error | Promise<DockerResult> = () => ({
    code: 0,
    stdout: '',
    stderr: '',
  }),
): { docker: Docker; runner: DockerRun } {
  const docker: Docker = { calls: [] };
  const runner: DockerRun = async (args, options) => {
    docker.calls.push({ args, cwd: options?.cwd });
    if (args.join(' ') === 'compose version --short') {
      const answered = await answer(args);
      if (answered instanceof Error) throw answered;
      return answered.stdout === '' && answered.code === 0
        ? { code: 0, stdout: '2.29.1\n', stderr: '' }
        : answered;
    }
    if (args.includes('up') && options?.cwd) {
      docker.upFolder = options.cwd;
      docker.stack = {
        composeFile: readFileSync(
          join(options.cwd, 'docker-compose.yml'),
          'utf8',
        ),
        env: readFileSync(join(options.cwd, '.env'), 'utf8'),
        files: filesBelow(join(dirname(options.cwd), 'files')),
      };
    }
    const answered = await answer(args, options?.signal);
    if (answered instanceof Error) throw answered;
    return answered;
  };
  return { docker, runner };
}

/**
 * A `docker compose up` still pulling: it ends only when the run stops it,
 * as a killed `docker` would.
 */
function pullingUntilStopped(signal?: AbortSignal): Promise<DockerResult> {
  return new Promise((resolve) => {
    signal?.addEventListener('abort', () =>
      resolve({ code: 130, stdout: '', stderr: 'canceled\n' }),
    );
  });
}

/** What `ps --all` and `logs --no-color` say about the project. */
function composeState(args: string[]): DockerResult | undefined {
  if (args.includes('ps')) {
    return {
      code: 0,
      stdout:
        'NAME            STATUS\nghost-1   Restarting (1) 3 seconds ago\n',
      stderr: '',
    };
  }
  if (args.includes('logs')) {
    return {
      code: 0,
      stdout: 'ghost-1  | Error: database is not reachable\n',
      stderr: '',
    };
  }
  return undefined;
}

/** Ctrl-C, pressed by the test. */
function ctrlC(): { interrupts: Interrupts; press: () => void } {
  let listener: (() => void) | undefined;
  return {
    interrupts: {
      listen(listening) {
        listener = listening;
        return () => (listener = undefined);
      },
    },
    press: () => listener?.(),
  };
}

/** Every Domain answers `status`; records the URLs probed. */
function answering(status: number) {
  const probed: string[] = [];
  const fetch: typeof globalThis.fetch = (url, init) => {
    probed.push(url instanceof Request ? url.url : url.toString());
    expect(init?.redirect).toBe('manual');
    return Promise.resolve(new Response('', { status }));
  };
  return { probed, fetch };
}

/** When a test run starts, by its clock. */
const START = Date.parse('2026-11-12T12:00:00Z');

async function tryTemplate(
  folder: string,
  options: {
    runner: DockerRun;
    fetch?: typeof globalThis.fetch;
    flags?: string[];
    interrupts?: Interrupts;
  },
) {
  const out = { stdout: '', stderr: '' };
  let clock = START;
  const code = await run({
    argv: ['template', 'try', folder, ...(options.flags ?? [])],
    env: {},
    cwd: tmpdir(),
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stderrIsTTY: false,
    stdout: (text) => (out.stdout += text),
    stderr: (text) => (out.stderr += text),
    fetch:
      options.fetch ??
      (() => Promise.reject(new Error('this run probes nothing'))),
    docker: options.runner,
    interrupts: options.interrupts,
    prompter: {
      ask: () => Promise.reject(new Error('never asked')),
    } as never,
    now: () => new Date(clock),
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
  });
  return { code, ...out, elapsed: clock - START };
}

/** A template folder: `template.yaml`'s own lines below its header, and files. */
function templateFolder(
  templateYaml: string,
  files: Record<string, string> = {},
  needs = '0.1.0',
): string {
  const folder = join(mkdtempSync(join(tmpdir(), 'cloudgate-try-')), 'ghost');
  mkdirSync(folder);
  writeFileSync(
    join(folder, 'template.yaml'),
    `name: Ghost\ndescription: A publishing platform.\ntags: [blog]\ncloudgate: ${needs}\n${templateYaml}`,
  );
  writeFileSync(
    join(folder, 'logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"></svg>',
  );
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), text);
  }
  return folder;
}

const COMPOSE_ENTRY =
  'version: 1\nservices:\n  app: { kind: compose, managed: console }\n';

/** A one-service compose Template with one Domain, and `inputs`. */
function ghost(
  inputs = '  SITE_URL: { value: "{{domains.ghost.url}}" }\n',
  compose = '',
) {
  return templateFolder(
    `compose: app\n${inputs ? `inputs:\n${inputs}` : ''}domains:\n  - { service: ghost, port: 2368 }\n`,
    {
      'cloudgate.yaml': COMPOSE_ENTRY,
      'docker-compose.yml':
        compose ||
        'services:\n  ghost:\n    image: ghost:5.96.0\n    environment:\n      url: ${SITE_URL}\n',
    },
  );
}

/** The loopback port the compose file publishes container port `target` on. */
function publishedPort(composeFile: string, target: number): number {
  const match = new RegExp(`127\\.0\\.0\\.1:(\\d+):${target}`).exec(
    composeFile,
  );
  expect(match).not.toBeNull();
  return Number(match?.[1]);
}

function envOf(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .trimEnd()
      .split('\n')
      .map((line) => [
        line.slice(0, line.indexOf('=')),
        line.slice(line.indexOf('=') + 1),
      ]),
  );
}

function filesBelow(folder: string): Record<string, string> {
  if (!existsSync(folder)) return {};
  const found: Record<string, string> = {};
  for (const entry of readdirSync(folder, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    found[full.slice(folder.length + 1)] = readFileSync(full, 'utf8');
  }
  return found;
}

/** The `docker` calls a run made, each as one line. */
function commands(docker: Docker): string[] {
  return docker.calls.map(({ args }) => args.join(' '));
}

describe('template try', () => {
  it("refuses a Template the check hides with the check's own reason, and starts nothing", async () => {
    const { docker, runner } = fakeDocker();
    const folder = templateFolder(
      'compose: app\n',
      {
        'cloudgate.yaml': COMPOSE_ENTRY,
        'docker-compose.yml': 'services:\n  ghost:\n    image: ghost:5.96.0\n',
      },
      '999.0.0',
    );

    const result = await tryTemplate(folder, { runner });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/ghost: needs Cloudgate 999\.0\.0 or newer/);
    expect(docker.calls).toEqual([]);
  });

  it('prints the note and exits 0 for a Template with no compose part', async () => {
    const { docker, runner } = fakeDocker();
    const folder = templateFolder('', {
      'cloudgate.yaml':
        'version: 1\nservices:\n  app:\n    kind: web\n    source: { image: "louislam/uptime-kuma:1.23" }\n',
    });

    const result = await tryTemplate(folder, { runner });

    expect(result).toMatchObject({
      code: 0,
      stdout: 'ghost: no compose part, nothing to try\n',
    });
    expect(docker.calls).toEqual([]);
  });

  it('prints ✓ for each Domain that answers, exits 0, and tears the stack down with its volumes', async () => {
    const { docker, runner } = fakeDocker();
    const { probed, fetch } = answering(302);

    const result = await tryTemplate(
      ghost('  SITE_URL: { value: "{{domains.ghost.url}}" }\n'),
      {
        runner,
        fetch,
      },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('✓ ghost:2368/\n');
    const project = /^cg-try-ghost-[a-z0-9]+$/;
    const [version, up, down] = docker.calls;
    expect(version.args).toEqual(['compose', 'version', '--short']);
    expect(up.args).toEqual([
      'compose',
      '-p',
      expect.stringMatching(project),
      'up',
      '--wait',
    ]);
    expect(down.args).toEqual([
      'compose',
      '-p',
      up.args[2],
      'down',
      '--volumes',
      '--remove-orphans',
    ]);
    expect(docker.calls).toHaveLength(3);
    const port = publishedPort(docker.stack?.composeFile ?? '', 2368);
    expect(probed).toEqual([`http://localhost:${port}/`]);
    // The temporary stack folder is gone with the stack.
    expect(existsSync(dirname(docker.upFolder ?? ''))).toBe(false);
  });

  it("hands Docker an Instance's stack layout: the compose file with the platform defaults, the .env and the filled-in config files", async () => {
    const { docker, runner } = fakeDocker();
    const folder = templateFolder(
      `compose: app
inputs:
  DB_PASSWORD: { generate: password }
  ADMIN_EMAIL: { ask: { label: Admin email, format: email } }
  TZ: { ask: { label: Time zone, default: Etc/UTC } }
  SITE: { ask: { label: Site, format: url } }
  WORKERS: { ask: { label: Workers, format: number } }
  TITLE: { ask: { label: Title } }
domains:
  - { service: ghost, port: 2368 }
files:
  - { path: config.production.json }
`,
      {
        'cloudgate.yaml': COMPOSE_ENTRY,
        'docker-compose.yml': `services:
  ghost:
    image: ghost:5.96.0
    environment:
      database__connection__password: \${DB_PASSWORD}
      mail: \${ADMIN_EMAIL}
      TZ: \${TZ}
      site: \${SITE}
      workers: \${WORKERS}
      title: \${TITLE}
    volumes:
      - ../files/config.production.json:/var/lib/ghost/config.production.json
`,
        'files/config.production.json':
          '{ "url": "{{domains.ghost.url}}", "mail": "{{ADMIN_EMAIL}}", "theme": "{{ theme }}" }',
      },
    );

    const result = await tryTemplate(folder, {
      runner,
      fetch: answering(200).fetch,
    });

    expect(result.code).toBe(0);
    const up = docker.calls.find(({ args }) => args.includes('up'));
    const project = up?.args[2] ?? '';
    expect(docker.upFolder?.endsWith('/code')).toBe(true);
    const stack = docker.stack as StackSeen;
    const port = publishedPort(stack.composeFile, 2368);

    const env = envOf(stack.env);
    expect(Object.keys(env)).toEqual([
      'APP_NAME',
      'COMPOSE_PROJECT_NAME',
      'DB_PASSWORD',
      'ADMIN_EMAIL',
      'TZ',
      'SITE',
      'WORKERS',
      'TITLE',
    ]);
    expect(env).toMatchObject({
      APP_NAME: project,
      COMPOSE_PROJECT_NAME: project,
      ADMIN_EMAIL: 'try@example.com',
      TZ: 'Etc/UTC',
      SITE: 'https://example.com',
      WORKERS: '1',
      TITLE: 'try',
    });
    expect(env.DB_PASSWORD).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(stack.env.endsWith('\n')).toBe(true);
    expect(stack.env).not.toContain('DOCKER_CONFIG');

    expect(stack.composeFile).toContain('restart: unless-stopped');
    expect(stack.composeFile).toContain('max-size: 10m');
    expect(stack.composeFile).not.toContain('traefik');
    expect(stack.composeFile).not.toContain('cloudgate-network');
    expect(stack.composeFile).toContain(
      '../files/config.production.json:/var/lib/ghost/config.production.json',
    );

    expect(stack.files).toEqual({
      'config.production.json': `{ "url": "http://localhost:${port}", "mail": "try@example.com", "theme": "{{ theme }}" }`,
    });
  });

  it("gives a value input's {{domains.<name>.url}} as http://localhost and the port published for it", async () => {
    const { docker, runner } = fakeDocker();

    await tryTemplate(
      ghost(
        '  SITE_URL: { value: "{{domains.ghost.url}}/blog" }\n  SITE_HOST: { value: "{{domains.ghost.host}}" }\n',
        'services:\n  ghost:\n    image: ghost:5.96.0\n    environment:\n      url: ${SITE_URL}\n      host: ${SITE_HOST}\n',
      ),
      { runner, fetch: answering(200).fetch },
    );

    const stack = docker.stack as StackSeen;
    const port = publishedPort(stack.composeFile, 2368);
    expect(envOf(stack.env)).toMatchObject({
      SITE_URL: `http://localhost:${port}/blog`,
      SITE_HOST: 'localhost',
    });
  });

  it('prints ✗ with the last status for a Domain answering 5xx, exits 1, and tears the stack down', async () => {
    const { docker, runner } = fakeDocker();

    const result = await tryTemplate(ghost(), {
      runner,
      fetch: answering(503).fetch,
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('✗ ghost:2368/: 503\n');
    expect(commands(docker).at(-1)).toMatch(
      /^compose -p cg-try-ghost-[a-z0-9]+ down --volumes --remove-orphans$/,
    );
    expect(existsSync(dirname(docker.upFolder ?? ''))).toBe(false);
  });

  it('prints ✗ no answer for a Domain that refuses every connection', async () => {
    const { runner } = fakeDocker();

    const result = await tryTemplate(ghost(), {
      runner,
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('✗ ghost:2368/: no answer\n');
  });

  it('passes a Domain that answers 5xx at first and then comes up', async () => {
    const { runner } = fakeDocker();
    const statuses = [502, 503, 200];
    const fetch = () =>
      Promise.resolve(new Response('', { status: statuses.shift() ?? 200 }));

    const result = await tryTemplate(ghost(), {
      runner,
      fetch: fetch,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('✓ ghost:2368/\n');
    expect(statuses).toEqual([]);
  });

  it('exits 1 when docker compose up fails, printing what it said, and still tears down', async () => {
    const { docker, runner } = fakeDocker((args) =>
      args.includes('up')
        ? {
            code: 1,
            stdout: '',
            stderr: 'manifest for ghost:5.96.0 not found\n',
          }
        : { code: 0, stdout: '', stderr: '' },
    );

    const result = await tryTemplate(ghost(), { runner });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('manifest for ghost:5.96.0 not found');
    expect(commands(docker).at(-1)).toMatch(
      / down --volumes --remove-orphans$/,
    );
    expect(existsSync(dirname(docker.upFolder ?? ''))).toBe(false);
  });

  it('gives a pattern ask with no default a sample that matches its pattern', async () => {
    const { docker, runner } = fakeDocker();

    const result = await tryTemplate(
      ghost(
        '  LICENCE: { ask: { label: Licence, pattern: "[A-Z]{4}-[0-9]{4}" } }\n',
        'services:\n  ghost:\n    image: ghost:5.96.0\n    environment:\n      licence: ${LICENCE}\n',
      ),
      { runner, fetch: answering(200).fetch },
    );

    expect(result.code).toBe(0);
    expect(envOf(docker.stack?.env ?? '').LICENCE).toMatch(
      /^[A-Z]{4}-[0-9]{4}$/,
    );
  });

  it('fails naming the input when no sample can satisfy its pattern, and starts nothing', async () => {
    const { docker, runner } = fakeDocker();

    const result = await tryTemplate(
      ghost(
        '  LICENCE: { ask: { label: Licence, pattern: "(?=x)y" } }\n',
        'services:\n  ghost:\n    image: ghost:5.96.0\n    environment:\n      licence: ${LICENCE}\n',
      ),
      { runner },
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('LICENCE');
    expect(result.stderr).toContain('must match its pattern, (?=x)y');
    expect(commands(docker).some((line) => line.includes(' up'))).toBe(false);
  });

  it('names an ask input with no acceptable value as one to add to test-values.yaml', async () => {
    const { runner } = fakeDocker();

    const result = await tryTemplate(
      ghost(
        '  LICENCE: { ask: { label: Licence, pattern: "(?=x)y" } }\n',
        'services:\n  ghost:\n    image: ghost:5.96.0\n    environment:\n      licence: ${LICENCE}\n',
      ),
      { runner },
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/LICENCE.*test-values\.yaml/s);
  });

  it('does not point at test-values.yaml for a value input it cannot fill, which no file can answer', async () => {
    const { docker, runner } = fakeDocker();
    // `site` is the Template's own web, whose Domain the compose part never
    // starts: `try` has no host for it, and test-values.yaml takes only asks.
    const folder = templateFolder(
      'compose: app\ninputs:\n  SITE_URL: { value: "{{domains.site.url}}" }\ndomains:\n  - { service: ghost, port: 2368 }\n',
      {
        'cloudgate.yaml':
          'version: 1\nservices:\n  app: { kind: compose, managed: console }\n  site:\n    kind: web\n    source: { image: "louislam/uptime-kuma:1.23" }\n',
        'docker-compose.yml':
          'services:\n  ghost:\n    image: ghost:5.96.0\n    environment:\n      url: ${SITE_URL}\n',
      },
    );

    const result = await tryTemplate(folder, { runner });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('SITE_URL');
    expect(result.stderr).toContain('{{domains.site.url}}');
    expect(result.stderr).not.toContain('test-values.yaml');
    expect(commands(docker).some((line) => line.includes(' up'))).toBe(false);
  });

  describe('test-values.yaml', () => {
    const ASKING =
      '  TZ: { ask: { label: Time zone, default: Etc/UTC } }\n' +
      '  LICENCE: { ask: { label: Licence, pattern: "[A-Z]{4}-[0-9]{4}" } }\n' +
      '  SITE_URL: { value: "{{domains.ghost.url}}" }\n';
    const READING =
      'services:\n  ghost:\n    image: ghost:5.96.0\n    environment:\n      TZ: ${TZ}\n      licence: ${LICENCE}\n      url: ${SITE_URL}\n';

    it('gives an ask input its value there over its default and over a sample', async () => {
      const { docker, runner } = fakeDocker();
      const folder = ghost(ASKING, READING);
      writeFileSync(
        join(folder, 'test-values.yaml'),
        'TZ: Europe/Paris\nLICENCE: WXYZ-9876\n',
      );

      const result = await tryTemplate(folder, {
        runner,
        fetch: answering(200).fetch,
      });

      expect(result.code).toBe(0);
      expect(envOf(docker.stack?.env ?? '')).toMatchObject({
        TZ: 'Europe/Paris',
        LICENCE: 'WXYZ-9876',
      });
    });

    it('fails naming each name there that is not an ask input, and starts nothing', async () => {
      const { docker, runner } = fakeDocker();
      const folder = ghost(ASKING, READING);
      writeFileSync(
        join(folder, 'test-values.yaml'),
        'TZ: Europe/Paris\nSITE_URL: http://example.com\nNOPE: x\n',
      );

      const result = await tryTemplate(folder, { runner });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('test-values.yaml');
      expect(result.stderr).toContain('SITE_URL, NOPE');
      expect(result.stderr).not.toContain('TZ');
      expect(docker.calls).toEqual([]);
    });

    it('refuses one that is not a map of names to text, and starts nothing', async () => {
      const { docker, runner } = fakeDocker();
      const folder = ghost(ASKING, READING);
      writeFileSync(
        join(folder, 'test-values.yaml'),
        'TZ:\n  - Europe/Paris\n',
      );

      const result = await tryTemplate(folder, { runner });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('test-values.yaml');
      expect(docker.calls).toEqual([]);
    });
  });

  it('exits 1 with an install hint when there is no Docker', async () => {
    const { runner } = fakeDocker(() =>
      Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }),
    );

    const result = await tryTemplate(ghost(), { runner });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Error: .*Docker/);
    expect(result.stderr).toMatch(/[Ii]nstall Docker/);
  });

  it('exits 1 naming Compose 2.1.1 when Docker has no compose command', async () => {
    const { docker, runner } = fakeDocker((args) =>
      args.includes('version')
        ? {
            code: 1,
            stdout: '',
            stderr: "docker: 'compose' is not a docker command.\n",
          }
        : { code: 0, stdout: '', stderr: '' },
    );

    const result = await tryTemplate(ghost(), { runner });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Compose 2\.1\.1 or newer/);
    expect(commands(docker)).toEqual(['compose version --short']);
  });

  it.each(['2.1.0', 'v2.0.1', '1.29.2', 'dev', ''])(
    'exits 1 naming Compose 2.1.1, the first with up --wait, when Compose says it is %j, and starts nothing',
    async (version) => {
      const { docker, runner } = fakeDocker((args) =>
        args.includes('version')
          ? { code: 0, stdout: `${version}\n`, stderr: '' }
          : { code: 0, stdout: '', stderr: '' },
      );

      const result = await tryTemplate(ghost(), { runner });

      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/Compose 2\.1\.1 or newer/);
      expect(result.stderr).toMatch(/Install .*Compose/);
      expect(commands(docker)).toEqual(['compose version --short']);
    },
  );

  it.each(['2.1.1', 'v2.29.1-desktop.1', '3.0.0'])(
    'starts the stack when Compose says it is %j',
    async (version) => {
      const { docker, runner } = fakeDocker((args) =>
        args.includes('version')
          ? { code: 0, stdout: `${version}\n`, stderr: '' }
          : { code: 0, stdout: '', stderr: '' },
      );

      const result = await tryTemplate(ghost(), {
        runner,
        fetch: answering(200).fetch,
      });

      expect(result.code).toBe(0);
      expect(commands(docker)[1]).toMatch(/ up --wait$/);
    },
  );

  it.each(['0', 'soon', '-5', ''])(
    'refuses --timeout %j as wrong use (exit 2), and starts nothing',
    async (minutes) => {
      const { docker, runner } = fakeDocker();

      const result = await tryTemplate(ghost(), {
        runner,
        flags: [`--timeout=${minutes}`],
      });

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(
        /Error: --timeout needs a number of minutes above 0/,
      );
      expect(docker.calls).toEqual([]);
    },
  );

  it('stops an up still pulling once --timeout minutes have passed, prints the compose status and logs, tears down and exits 1', async () => {
    const { docker, runner } = fakeDocker((args, signal) =>
      args.includes('up')
        ? pullingUntilStopped(signal)
        : (composeState(args) ?? { code: 0, stdout: '', stderr: '' }),
    );

    const result = await tryTemplate(ghost(), {
      runner,
      flags: ['--timeout', '3'],
    });

    expect(result.code).toBe(1);
    expect(result.elapsed).toBe(3 * 60_000);
    expect(result.stderr).toMatch(/3 minutes/);
    expect(result.stderr).toContain('ghost-1   Restarting (1) 3 seconds ago');
    expect(result.stderr).toContain(
      'ghost-1  | Error: database is not reachable',
    );
    expect(commands(docker).slice(1)).toEqual([
      expect.stringMatching(/^compose -p cg-try-ghost-[a-z0-9]+ up --wait$/),
      expect.stringMatching(/ ps --all$/),
      expect.stringMatching(/ logs --no-color$/),
      expect.stringMatching(/ down --volumes --remove-orphans$/),
    ]);
    expect(existsSync(dirname(docker.upFolder ?? ''))).toBe(false);
  });

  it('gives up on a Domain still answering 5xx once --timeout minutes have passed, prints ✗, the compose status and logs, and tears down', async () => {
    const { docker, runner } = fakeDocker(
      (args) => composeState(args) ?? { code: 0, stdout: '', stderr: '' },
    );

    const result = await tryTemplate(ghost(), {
      runner,
      fetch: answering(502).fetch,
      flags: ['--timeout', '1'],
    });

    expect(result.code).toBe(1);
    expect(result.elapsed).toBe(60_000);
    expect(result.stdout).toBe('✗ ghost:2368/: 502\n');
    expect(result.stderr).toContain('ghost-1   Restarting (1) 3 seconds ago');
    expect(result.stderr).toContain(
      'ghost-1  | Error: database is not reachable',
    );
    expect(commands(docker).slice(-3)).toEqual([
      expect.stringMatching(/ ps --all$/),
      expect.stringMatching(/ logs --no-color$/),
      expect.stringMatching(/ down --volumes --remove-orphans$/),
    ]);
  });

  describe('bounded waits', () => {
    // These hold a docker command or a probe that never answers, and let the
    // timer that bounds it fire. The run's own clock (`now`, `sleep`) is the
    // test's as everywhere else; only `setTimeout` is faked.
    afterEach(() => vi.useRealTimers());

    /** A docker command or a probe that answers only once it is stopped. */
    function hung<T>(signal: AbortSignal | undefined, stopped: T): Promise<T> {
      return new Promise((resolve) => {
        signal?.addEventListener('abort', () => resolve(stopped));
      });
    }
    const KILLED = { code: 143, stdout: '', stderr: '' };

    it('waits for a probe no longer than the time left before --timeout', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { runner } = fakeDocker();
      const stopped: boolean[] = [];
      let first = true;
      // --timeout 0.1 is 6 seconds in all, less than a probe's own 10: by
      // the time the whole run's time has passed, the probe has stopped.
      const fetch: typeof globalThis.fetch = (_url, init) => {
        if (first) {
          first = false;
          stopped.push(init?.signal?.aborted ?? false);
          vi.advanceTimersByTime(6_000);
          stopped.push(init?.signal?.aborted ?? false);
        }
        return Promise.reject(new TypeError('fetch failed'));
      };

      const result = await tryTemplate(ghost(), {
        runner,
        fetch,
        flags: ['--timeout', '0.1'],
      });

      expect(stopped).toEqual([false, true]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('✗ ghost:2368/: no answer\n');
    });

    it('gives up on a docker compose ps or logs that never answers, and still removes the stack', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { docker, runner } = fakeDocker((args, signal) => {
        if (args.includes('ps') || args.includes('logs')) {
          const answer = hung(signal, KILLED);
          vi.runOnlyPendingTimers();
          return answer;
        }
        return { code: 0, stdout: '', stderr: '' };
      });

      const result = await tryTemplate(ghost(), {
        runner,
        fetch: answering(503).fetch,
        flags: ['--timeout', '1'],
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(
        /docker compose ps --all:\n.*gave no answer within/,
      );
      expect(result.stderr).toMatch(
        /docker compose logs --no-color:\n.*gave no answer within/,
      );
      expect(commands(docker).at(-1)).toMatch(
        / down --volumes --remove-orphans$/,
      );
      expect(existsSync(dirname(docker.upFolder ?? ''))).toBe(false);
    });

    it('gives up on a docker compose down that never ends, deletes the folder and names the command that removes the stack', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { docker, runner } = fakeDocker((args, signal) => {
        if (args.includes('down')) {
          const answer = hung(signal, KILLED);
          vi.runOnlyPendingTimers();
          return answer;
        }
        return { code: 0, stdout: '', stderr: '' };
      });

      const result = await tryTemplate(ghost(), {
        runner,
        fetch: answering(200).fetch,
      });

      const project = /cg-try-ghost-[a-z0-9]+/.exec(commands(docker)[1])?.[0];
      expect(result.stdout).toBe('✓ ghost:2368/\n');
      expect(result.stderr).toContain(
        `docker compose -p ${project} down --volumes --remove-orphans`,
      );
      expect(result.stderr).toMatch(/did not finish within/);
      expect(existsSync(dirname(docker.upFolder ?? ''))).toBe(false);
    });
  });

  it('gives a Domain 10 minutes in all when no --timeout is given', async () => {
    const { runner } = fakeDocker();

    const result = await tryTemplate(ghost(), {
      runner,
      fetch: answering(500).fetch,
    });

    expect(result.code).toBe(1);
    expect(result.elapsed).toBe(10 * 60_000);
  });

  it('prints the compose status and logs when docker compose up fails, before tearing down', async () => {
    const { docker, runner } = fakeDocker((args) =>
      args.includes('up')
        ? {
            code: 1,
            stdout: '',
            stderr:
              'dependency failed to start: container ghost-1 exited (1)\n',
          }
        : (composeState(args) ?? { code: 0, stdout: '', stderr: '' }),
    );

    const result = await tryTemplate(ghost(), { runner });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('container ghost-1 exited (1)');
    expect(result.stderr).toContain('ghost-1   Restarting (1) 3 seconds ago');
    expect(result.stderr).toContain(
      'ghost-1  | Error: database is not reachable',
    );
    expect(commands(docker).slice(-4)).toEqual([
      expect.stringMatching(/ up --wait$/),
      expect.stringMatching(/ ps --all$/),
      expect.stringMatching(/ logs --no-color$/),
      expect.stringMatching(/ down --volumes --remove-orphans$/),
    ]);
  });

  it('stops an up still pulling on Ctrl-C, tears down with its volumes and exits 130', async () => {
    const ctrl = ctrlC();
    const { docker, runner } = fakeDocker((args, signal) => {
      if (!args.includes('up')) return { code: 0, stdout: '', stderr: '' };
      queueMicrotask(ctrl.press);
      return pullingUntilStopped(signal);
    });

    const result = await tryTemplate(ghost(), {
      runner,
      interrupts: ctrl.interrupts,
    });

    expect(result.code).toBe(130);
    expect(commands(docker).slice(1)).toEqual([
      expect.stringMatching(/ up --wait$/),
      expect.stringMatching(
        /^compose -p cg-try-ghost-[a-z0-9]+ down --volumes --remove-orphans$/,
      ),
    ]);
    expect(existsSync(dirname(docker.upFolder ?? ''))).toBe(false);
  });

  it('stops asking a Domain on Ctrl-C, tears down with its volumes and exits 130', async () => {
    const ctrl = ctrlC();
    const { docker, runner } = fakeDocker();
    let probes = 0;
    const fetch = () => {
      probes += 1;
      if (probes === 3) ctrl.press();
      return Promise.resolve(new Response('', { status: 503 }));
    };

    const result = await tryTemplate(ghost(), {
      runner,
      fetch,
      interrupts: ctrl.interrupts,
    });

    expect(result.code).toBe(130);
    expect(probes).toBe(3);
    expect(result.stdout).toBe('');
    expect(commands(docker).at(-1)).toMatch(
      / down --volumes --remove-orphans$/,
    );
    expect(existsSync(dirname(docker.upFolder ?? ''))).toBe(false);
  });
});
