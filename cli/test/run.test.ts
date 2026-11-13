import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { writeLink } from '../src/folder-link.js';
import { loginStore } from '../src/logins.js';
import type { LoginStore } from '../src/logins.js';
import type { Prompter } from '../src/prompt.js';

import { run } from '../src/run.js';
import type { Invocation } from '../src/run.js';

/**
 * The CLI driven the way a person or a CI job drives it — arguments,
 * environment, terminal-or-not — against what it prints and how it exits.
 * The network is the one double: `fetch` answers as an Instance would. What
 * the built command does against a real Instance is the CLI e2e suite's job.
 */
function invoke(
  argv: string[],
  options: {
    env?: Record<string, string | undefined>;
    answer?: (url: string, init: RequestInit) => Response | Promise<Response>;
    /** The public answer at `/backend/settings/about`; a current Cloudgate's unless given. */
    about?: (url: string, init: RequestInit) => Response | Promise<Response>;
    terminal?: boolean;
    /** Defaults to a fresh empty folder, holding no Folder link. */
    cwd?: string;
    prompter?: Prompter;
    /** The saved logins; none unless given. */
    logins?: LoginStore;
  } = {},
) {
  const out = { stdout: '', stderr: '' };
  const terminal = options.terminal ?? false;
  const invocation: Invocation = {
    argv,
    env: options.env ?? {},
    cwd: options.cwd ?? mkdtempSync(join(tmpdir(), 'cloudgate-run-')),
    prompter: options.prompter ?? neverAsked,
    stdinIsTTY: terminal,
    stdoutIsTTY: terminal,
    stderrIsTTY: terminal,
    stdout: (text) => (out.stdout += text),
    stderr: (text) => (out.stderr += text),
    fetch: (input, init) => {
      const url = input as string;
      const answer = url.endsWith('/backend/settings/about')
        ? (options.about ?? (() => json(aboutAnswer)))
        : (options.answer ?? (() => new Response(null, { status: 599 })));
      return Promise.resolve(answer(url, init ?? {}));
    },
    now: () => new Date('2026-11-03T12:00:00Z'),
    sleep: () => Promise.resolve(),
    ...(options.logins ? { logins: options.logins } : {}),
  };
  return run(invocation).then((code) => ({ code, ...out }));
}

/** A prompter for runs that must never ask. */
const neverAsked: Prompter = {
  choose: () => Promise.reject(new Error('asked a question')),
  confirm: () => Promise.reject(new Error('asked a question')),
  secret: () => Promise.reject(new Error('asked a question')),
  text: () => Promise.reject(new Error('asked a question')),
};

const whoamiAnswer = {
  email: 'ci@shop.example',
  organization: { id: 'org_3kP', name: 'Shop Inc' },
  key: {
    id: 'key_1',
    name: 'ci',
    start: 'cg_ab',
    expiresAt: '2027-02-01T12:00:00.000Z',
  },
};

const aboutAnswer = {
  product: 'cloudgate',
  version: '9.9.9',
  apiUrl: 'https://api.cloud.acme.dev',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const withKey = { CLOUDGATE_KEY: 'cg_secret' };

describe('run', () => {
  describe('--version and --help', () => {
    it('prints the version alone on stdout', async () => {
      expect(await invoke(['--version'])).toEqual({
        code: 0,
        stdout: '0.0.0-test\n',
        stderr: '',
      });
    });

    it('has no -v', async () => {
      const result = await invoke(['-v']);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe('');
    });

    it('prints the overview on stdout for --help and for no command at all', async () => {
      for (const argv of [['--help'], ['-h'], []]) {
        const result = await invoke(argv);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('USAGE\n  cloudgate <command> [flags]');
        expect(result.stdout).toContain('whoami');
        expect(result.stdout).toContain('EXIT CODES');
      }
    });

    it("prints a command's own help for <command> --help, asking nothing of an Instance", async () => {
      const result = await invoke(['whoami', '--help'], { env: withKey });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('cloudgate whoami [--json]');
      expect(result.stderr).toBe('');
    });
  });

  describe('wrong use', () => {
    it('refuses an unknown command with exit 2', async () => {
      const result = await invoke(['deploi'], { env: withKey });
      expect(result).toMatchObject({ code: 2, stdout: '' });
      expect(result.stderr).toMatch(/^Error: unknown command "deploi"/);
    });

    it('refuses an unknown flag with exit 2, naming it', async () => {
      const result = await invoke(['whoami', '--jsno'], { env: withKey });
      expect(result).toMatchObject({ code: 2, stdout: '' });
      expect(result.stderr).toMatch(/^Error: unknown flag --jsno/);
    });

    it('refuses --instance with no address with exit 2', async () => {
      const result = await invoke(['whoami', '--instance'], { env: withKey });
      expect(result.code).toBe(2);
    });
  });

  describe('whoami', () => {
    it('prints the facts as aligned columns, and Using instance on stderr', async () => {
      const result = await invoke(
        ['whoami', '--instance', 'https://cloud.acme.dev'],
        {
          env: withKey,
          answer: () => json(whoamiAnswer),
        },
      );
      expect(result).toEqual({
        code: 0,
        stdout:
          'Instance      https://cloud.acme.dev\n' +
          'Logged in as  ci@shop.example\n' +
          'Organization  Shop Inc\n' +
          'Key ends      2027-02-01 (in 90 days)\n',
        stderr: 'Using instance https://cloud.acme.dev\n',
      });
    });

    it('prints JSON alone on stdout with --json, saying the key came from the environment', async () => {
      const result = await invoke(['whoami', '--json'], {
        env: { ...withKey, CLOUDGATE_INSTANCE: 'https://cloud.acme.dev' },
        answer: () => json(whoamiAnswer),
      });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        instance: 'https://cloud.acme.dev',
        email: 'ci@shop.example',
        organization: { id: 'org_3kP', name: 'Shop Inc' },
        keyFrom: 'env',
        keyEndsAt: '2027-02-01T12:00:00.000Z',
      });
      expect(result.stderr).toBe('Using instance https://cloud.acme.dev\n');
    });

    it('says a key that never ends never ends', async () => {
      const result = await invoke(['whoami'], {
        env: withKey,
        answer: () =>
          json({
            ...whoamiAnswer,
            key: { ...whoamiAnswer.key, expiresAt: null },
          }),
      });
      expect(result.stdout).toContain('Key ends      never\n');
    });

    it('asks the default Instance when nothing names one', async () => {
      const asked: string[] = [];
      const result = await invoke(['whoami'], {
        env: withKey,
        answer: (url) => {
          asked.push(new URL(url).origin);
          return json(whoamiAnswer);
        },
      });
      expect(result.stderr).toBe(
        'Using instance https://cloudgate.octabyte.app\n',
      );
      expect(asked).toEqual(['https://cloudgate.octabyte.app']);
    });

    it('refuses with exit 3 and asks nothing when there is no key', async () => {
      let asked = false;
      const result = await invoke(['whoami', '--json'], {
        answer: () => {
          asked = true;
          return json(whoamiAnswer);
        },
      });
      expect(result).toMatchObject({ code: 3, stdout: '' });
      expect(result.stderr).toContain(
        'Error: not logged in to https://cloudgate.octabyte.app',
      );
      expect(asked).toBe(false);
    });

    it('exits 3 on a refused key, with Error: on stderr and stdout empty under --json', async () => {
      const result = await invoke(['whoami', '--json'], {
        env: withKey,
        answer: () => json({ statusCode: 401, message: 'Unauthorized' }, 401),
      });
      expect(result).toEqual({
        code: 3,
        stdout: '',
        stderr:
          'Using instance https://cloudgate.octabyte.app\n' +
          'Error: Unauthorized\n' +
          'The Instance does not accept the key in CLOUDGATE_KEY; it may have ended or been deleted.\n',
      });
    });

    it('exits 1 on a 403, printing the error and the hint', async () => {
      const result = await invoke(['whoami'], {
        env: withKey,
        answer: () =>
          json({ statusCode: 403, message: 'Permission denied' }, 403),
      });
      expect(result).toMatchObject({ code: 1, stdout: '' });
      expect(result.stderr).toContain(
        'Error: Permission denied\nAsk an owner of the Organization for access.\n',
      );
    });

    it('exits 1 when the Instance cannot be reached', async () => {
      const result = await invoke(['whoami', '--json'], {
        env: withKey,
        answer: () => {
          throw new TypeError('fetch failed');
        },
      });
      expect(result).toMatchObject({ code: 1, stdout: '' });
      expect(result.stderr).toContain(
        'Error: could not reach https://cloudgate.octabyte.app',
      );
    });

    it('exits 1 when the answer is not one this CLI understands', async () => {
      const result = await invoke(['whoami', '--json'], {
        env: withKey,
        answer: () => new Response('<html>console</html>', { status: 200 }),
      });
      expect(result).toMatchObject({ code: 1, stdout: '' });
    });

    it('colours only in a terminal, and never with NO_COLOR or --no-color', async () => {
      const ask = (
        argv: string[],
        env: Record<string, string>,
        terminal: boolean,
      ) =>
        invoke(argv, {
          env: { ...withKey, ...env },
          terminal,
          answer: () => json(whoamiAnswer),
        });
      // eslint-disable-next-line no-control-regex
      const ansi = /\u001b\[/;

      expect((await ask(['whoami'], {}, true)).stdout).toMatch(ansi);
      for (const result of [
        await ask(['whoami'], {}, false),
        await ask(['whoami'], { NO_COLOR: '1' }, true),
        await ask(['whoami', '--no-color'], {}, true),
      ]) {
        expect(result.stdout).not.toMatch(ansi);
        expect(result.stdout).toContain('Logged in as  ci@shop.example');
      }
    });
  });
  describe('the Instance check', () => {
    /** Every request made, with whether it carried the key. */
    function recorder() {
      const requests: { url: string; withKey: boolean }[] = [];
      const record = (url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        requests.push({ url, withKey: headers.has('x-api-key') });
      };
      return { requests, record };
    }

    it('keeps only the origin of a pasted address, adding https://', async () => {
      const { requests, record } = recorder();
      const result = await invoke(
        ['whoami', '--instance', 'Cloud.Acme.dev/projects/p_1?tab=logs'],
        {
          env: withKey,
          about: (url, init) => {
            record(url, init);
            return json(aboutAnswer);
          },
          answer: (url, init) => {
            record(url, init);
            return json(whoamiAnswer);
          },
        },
      );
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('Using instance https://cloud.acme.dev\n');
      expect(requests).toEqual([
        {
          url: 'https://cloud.acme.dev/backend/settings/about',
          withKey: false,
        },
        {
          url: 'https://cloud.acme.dev/backend/users/me/whoami',
          withKey: true,
        },
      ]);
    });

    it('refuses an address that is not a Cloudgate with exit 1, and never sends the key', async () => {
      for (const notCloudgate of [
        () => new Response('<html>a shop</html>', { status: 200 }),
        () => new Response('Not found', { status: 404 }),
        () => json({ status: 'ok' }),
        () => json({ ...aboutAnswer, product: 'something-else' }),
      ]) {
        const { requests, record } = recorder();
        const result = await invoke(
          ['whoami', '--json', '--instance', 'https://example.com'],
          {
            env: withKey,
            about: (url, init) => {
              record(url, init);
              return notCloudgate();
            },
            answer: (url, init) => {
              record(url, init);
              return json(whoamiAnswer);
            },
          },
        );
        expect(result).toMatchObject({ code: 1, stdout: '' });
        expect(result.stderr).toContain(
          'Error: https://example.com is not a Cloudgate',
        );
        expect(requests.every((request) => !request.withKey)).toBe(true);
      }
    });

    it('refuses plain http:// to a non-local host with exit 2 before any request', async () => {
      const { requests, record } = recorder();
      const result = await invoke(
        ['whoami', '--instance', 'http://cloud.acme.dev'],
        {
          env: withKey,
          about: (url, init) => {
            record(url, init);
            return json(aboutAnswer);
          },
          answer: (url, init) => {
            record(url, init);
            return json(whoamiAnswer);
          },
        },
      );
      expect(result).toMatchObject({ code: 2, stdout: '' });
      expect(result.stderr).toMatch(
        /^Error: http:\/\/cloud\.acme\.dev is plain http:\/\//,
      );
      expect(result.stderr).toContain('--allow-http');
      expect(requests).toEqual([]);
    });

    it('takes plain http:// to any host with --allow-http, and to localhost without', async () => {
      for (const argv of [
        ['whoami', '--instance', 'http://cloud.acme.dev', '--allow-http'],
        ['whoami', '--instance', 'http://localhost:3000'],
      ]) {
        const result = await invoke(argv, {
          env: withKey,
          answer: () => json(whoamiAnswer),
        });
        expect(result.code).toBe(0);
      }
    });

    it('refuses an Instance older than the CLI supports with exit 1, naming both versions', async () => {
      // 0.0.1 is the server before device login, key self-delete and the
      // other routes this CLI's commands call.
      let keySent = false;
      const result = await invoke(['whoami', '--json'], {
        env: withKey,
        about: () => json({ ...aboutAnswer, version: '0.0.1' }),
        answer: () => {
          keySent = true;
          return json(whoamiAnswer);
        },
      });
      expect(result).toMatchObject({ code: 1, stdout: '' });
      expect(result.stderr).toContain(
        'Error: https://cloudgate.octabyte.app runs Cloudgate 0.0.1, and this CLI needs 0.1.0 or newer',
      );
      expect(keySent).toBe(false);
    });

    it('never follows a redirect with the key', async () => {
      let redirect: RequestInit['redirect'];
      await invoke(['whoami'], {
        env: withKey,
        answer: (_url, init) => {
          redirect = init.redirect;
          return json(whoamiAnswer);
        },
      });
      expect(redirect).toBe('error');
    });
  });

  describe('link and unlink', () => {
    const instance = 'https://cloud.acme.dev';
    const env = { ...withKey, CLOUDGATE_INSTANCE: instance };

    /** An Instance holding two Organizations; Shop Inc has Project shop. */
    function instanceAnswer(url: string): Response {
      const path = url.slice(`${instance}/backend`.length);
      if (path === '/organizations') {
        return json([
          { id: 'org_1', name: 'Shop Inc', member: { isDefault: true } },
          { id: 'org_2', name: 'Acme', member: { isDefault: false } },
        ]);
      }
      if (path === '/projects') {
        return json([{ projectId: 'prj_1', name: 'shop', env: 'SECRET=1' }]);
      }
      if (path === '/projects/prj_1/config') {
        return json({ projectId: 'prj_1', location: null });
      }
      if (path === '/environments?projectId=prj_1') {
        return json([{ environmentId: 'env_s', name: 'staging' }]);
      }
      if (path === '/environments/env_s') {
        return json({
          environmentId: 'env_s',
          name: 'staging',
          services: [
            {
              serviceType: 'application',
              serviceId: 'app_1',
              name: 'Shop API',
              configName: 'api',
            },
          ],
        });
      }
      return json({ message: 'Not found' }, 404);
    }

    const allFlags = [
      'link',
      '--org',
      'Shop Inc',
      '--project',
      'shop',
      '--env',
      'staging',
      '--service',
      'api',
    ];

    function folder(): string {
      return mkdtempSync(join(tmpdir(), 'cloudgate-link-run-'));
    }

    it('writes the link from flags alone, with no terminal', async () => {
      const cwd = folder();

      const result = await invoke(allFlags, {
        env,
        cwd,
        answer: instanceAnswer,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        '✓ Linked ./ to api in staging of Project shop on cloud.acme.dev',
      );
      const saved = JSON.parse(
        readFileSync(join(cwd, '.cloudgate', 'link.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(saved).toMatchObject({
        instance,
        organizationId: 'org_1',
        projectId: 'prj_1',
        environmentId: 'env_s',
        serviceConfigName: 'api',
      });
      // A Project's shared variables never reach the link.
      expect(JSON.stringify(saved)).not.toContain('SECRET');
    });

    it('with no terminal, refuses naming the first missing flag (exit 2) and writes nothing', async () => {
      const cwd = folder();

      const result = await invoke(['link', '--project', 'shop'], {
        env,
        cwd,
        answer: instanceAnswer,
      });

      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        'Error: no Organization. Pass --org or set CLOUDGATE_ORG.',
      );
      expect(existsSync(join(cwd, '.cloudgate'))).toBe(false);
    });

    it('with --yes in a terminal, still refuses rather than asks', async () => {
      const result = await invoke(
        [
          'link',
          '--org',
          'org_1',
          '--project',
          'shop',
          '--env',
          'staging',
          '--yes',
        ],
        { env, cwd: folder(), terminal: true, answer: instanceAnswer },
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        'Error: no Service. Pass --service or set CLOUDGATE_SERVICE.',
      );
    });

    it('asks in a terminal for what no flag answers, skipping the rest', async () => {
      const asked: string[] = [];
      const prompter: Prompter = {
        choose: (question) => {
          asked.push(question);
          return Promise.resolve(0);
        },
        confirm: () => Promise.reject(new Error('nothing to replace')),
        secret: () => Promise.reject(new Error('asked a question')),
        text: () => Promise.reject(new Error('asked a question')),
      };
      const cwd = folder();

      const result = await invoke(['link', '--org', 'org_1'], {
        env,
        cwd,
        terminal: true,
        prompter,
        answer: instanceAnswer,
      });

      expect(result.code).toBe(0);
      expect(asked).toEqual(['Project', 'Environment', 'Service']);
      expect(existsSync(join(cwd, '.cloudgate', 'link.json'))).toBe(true);
    });

    it('will not replace a link without --yes when it cannot ask, and does with it', async () => {
      const cwd = folder();
      await invoke(allFlags, { env, cwd, answer: instanceAnswer });
      const before = readFileSync(join(cwd, '.cloudgate', 'link.json'), 'utf8');

      const refused = await invoke(allFlags, {
        env,
        cwd,
        answer: instanceAnswer,
      });
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain('Error: this folder is already linked');
      expect(refused.stderr).toContain('--yes');

      const replaced = await invoke([...allFlags, '--yes'], {
        env,
        cwd,
        answer: instanceAnswer,
      });
      expect(replaced.code).toBe(0);
      expect(readFileSync(join(cwd, '.cloudgate', 'link.json'), 'utf8')).toBe(
        before,
      );
    });

    it('asks before replacing a link in a terminal, and keeps it on no', async () => {
      const cwd = folder();
      await invoke(allFlags, { env, cwd, answer: instanceAnswer });

      const kept = await invoke(allFlags, {
        env,
        cwd,
        terminal: true,
        prompter: { ...neverAsked, confirm: () => Promise.resolve(false) },
        answer: instanceAnswer,
      });

      expect(kept.code).toBe(0);
      expect(kept.stderr).toContain('Kept the link');
      expect(existsSync(join(cwd, '.cloudgate', 'link.json'))).toBe(true);
    });

    it('takes no target flags on a command that acts on no Service', async () => {
      const result = await invoke(['whoami', '--service', 'api'], { env });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('unknown flag --service');
    });

    it('unlink removes the nearest link and makes no request', async () => {
      const cwd = folder();
      await invoke(allFlags, { env, cwd, answer: instanceAnswer });
      const sub = join(cwd, 'src');
      mkdirSync(sub);

      const result = await invoke(['unlink'], {
        env: {},
        cwd: sub,
        answer: () => {
          throw new Error('unlink made a request');
        },
      });

      expect(result.code).toBe(0);
      expect(result.stderr).toContain('Nothing changed on the Instance.');
      expect(existsSync(join(cwd, '.cloudgate', 'link.json'))).toBe(false);

      const again = await invoke(['unlink'], { cwd: sub });
      expect(again.code).toBe(0);
      expect(again.stderr).toContain('not linked');
    });

    it('refuses CLOUDGATE_INSTANCE disagreeing with the link, naming both', async () => {
      const cwd = folder();
      await invoke(allFlags, { env, cwd, answer: instanceAnswer });

      const result = await invoke(['whoami'], {
        env: { ...withKey, CLOUDGATE_INSTANCE: 'https://cloud.other.io' },
        cwd,
        answer: () => json(whoamiAnswer),
      });

      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        'Error: CLOUDGATE_INSTANCE https://cloud.other.io is not the Instance this folder is linked to, https://cloud.acme.dev',
      );
    });
  });

  describe('saved logins', () => {
    /** A config folder on a machine with no keychain, so keys go to the file. */
    function savedLogins() {
      const dir = mkdtempSync(join(tmpdir(), 'cloudgate-config-'));
      return {
        dir,
        store: loginStore({
          configDir: dir,
          env: {},
          keychain: () => Promise.resolve(undefined),
        }),
      };
    }

    const acme = {
      instance: 'https://cloud.acme.dev',
      email: 'sam@acme.dev',
      keyId: 'key_acme',
      keyEndsAt: '2027-02-01T12:00:00.000Z',
    };
    const other = {
      instance: 'https://cloud.other.io',
      email: 'sam@other.io',
      keyId: 'key_other',
      keyEndsAt: '2027-02-02T12:00:00.000Z',
    };

    /** An Instance answering whoami for whichever key it is given. */
    function whoamiFor(keys: Record<string, string>) {
      return (url: string, init: RequestInit) => {
        const key = (init.headers as Record<string, string>)['x-api-key'];
        if (!url.endsWith('/users/me/whoami') || !(key in keys)) {
          return json({ statusCode: 401, message: 'Unauthorized' }, 401);
        }
        return json({ ...whoamiAnswer, email: keys[key] });
      };
    }

    it('lists the Instances logged in to, marking the current one', async () => {
      const { store } = savedLogins();
      await store.save(acme, 'cg_acme');
      await store.save(other, 'cg_other');

      const text = await invoke(['instance', 'list'], { logins: store });
      expect(text).toEqual({
        code: 0,
        stdout:
          '   INSTANCE                 LOGGED IN AS\n' +
          '   https://cloud.acme.dev   sam@acme.dev\n' +
          '*  https://cloud.other.io   sam@other.io\n',
        stderr: '',
      });

      const asJson = await invoke(['instance', 'list', '--json'], {
        logins: store,
      });
      expect(JSON.parse(asJson.stdout)).toEqual([
        {
          instance: acme.instance,
          email: acme.email,
          current: false,
          keyEndsAt: acme.keyEndsAt,
        },
        {
          instance: other.instance,
          email: other.email,
          current: true,
          keyEndsAt: other.keyEndsAt,
        },
      ]);
    });

    it('switches the current Instance with instance use, which whoami then asks', async () => {
      const { store } = savedLogins();
      await store.save(acme, 'cg_acme');
      await store.save(other, 'cg_other');

      const used = await invoke(['instance', 'use', 'cloud.acme.dev'], {
        logins: store,
      });
      expect(used).toEqual({
        code: 0,
        stdout: '',
        stderr: '✓ Now using https://cloud.acme.dev\n',
      });

      const whoami = await invoke(['whoami', '--json'], {
        logins: store,
        answer: whoamiFor({ cg_acme: acme.email, cg_other: other.email }),
      });
      expect(whoami.code).toBe(0);
      expect(JSON.parse(whoami.stdout)).toMatchObject({
        instance: acme.instance,
        email: acme.email,
        keyFrom: 'login',
      });
    });

    it('refuses instance use on an Instance with no login here, with exit 3', async () => {
      const { store } = savedLogins();
      await store.save(acme, 'cg_acme');
      const result = await invoke(['instance', 'use', 'cloud.nowhere.io'], {
        logins: store,
      });
      expect(result).toEqual({
        code: 3,
        stdout: '',
        stderr:
          'Error: you are not logged in to https://cloud.nowhere.io\n' +
          'Run: cloudgate login --instance https://cloud.nowhere.io\n',
      });
      expect(await store.current()).toBe(acme.instance);
    });

    it('takes CLOUDGATE_KEY over a saved login, and saves nothing', async () => {
      const { dir, store } = savedLogins();
      await store.save(acme, 'cg_acme');
      const before = readFileSync(join(dir, 'credentials.json'), 'utf8');

      const result = await invoke(
        ['whoami', '--json', '--instance', acme.instance],
        {
          logins: store,
          env: { CLOUDGATE_KEY: 'cg_env' },
          answer: whoamiFor({ cg_env: 'ci@acme.dev', cg_acme: acme.email }),
        },
      );
      expect(JSON.parse(result.stdout)).toMatchObject({
        email: 'ci@acme.dev',
        keyFrom: 'env',
      });
      expect(readFileSync(join(dir, 'credentials.json'), 'utf8')).toBe(before);
      expect(before).not.toContain('cg_env');
    });

    it('forgets a saved key the Instance refuses, saying the login has ended, with exit 3', async () => {
      const { store } = savedLogins();
      await store.save(acme, 'cg_revoked');

      const result = await invoke(['whoami'], {
        logins: store,
        answer: whoamiFor({}),
      });
      expect(result.code).toBe(3);
      expect(result.stderr).toContain(
        'Error: your login to https://cloud.acme.dev has ended\n' +
          'Run: cloudgate login --instance https://cloud.acme.dev\n',
      );
      expect(await store.list()).toEqual({ current: null, logins: [] });
    });

    describe('login', () => {
      /** An Instance running the device flow: pending `pending` times, then approved. */
      function deviceFlow(options: {
        pending?: number;
        finally?: 'approved' | 'ACCESS_DENIED' | 'EXPIRED_TOKEN';
      }) {
        const polls: Array<Record<string, unknown>> = [];
        let pending = options.pending ?? 0;
        const answer = (url: string, init: RequestInit) => {
          if (url.endsWith('/backend/auth/device/code')) {
            return json({
              deviceCode: 'dc_1',
              userCode: 'WDJBMJHT',
              interval: 5,
              expiresIn: 1800,
            });
          }
          if (url.endsWith('/backend/auth/device/token')) {
            polls.push(
              JSON.parse(init.body as string) as Record<string, unknown>,
            );
            if (pending-- > 0) {
              return json({ code: 'AUTHORIZATION_PENDING' }, 400);
            }
            if (options.finally && options.finally !== 'approved') {
              return json({ code: options.finally, message: 'no' }, 400);
            }
            return json({
              key: 'cg_new',
              keyId: 'key_new',
              expiresAt: '2027-02-01T12:00:00.000Z',
            });
          }
          return whoamiFor({ cg_new: 'sam@acme.dev' })(url, init);
        };
        return { polls, answer };
      }

      it('prints the link and code on stderr, polls until approved, saves the login and makes it current', async () => {
        const { dir, store } = savedLogins();
        const flow = deviceFlow({ pending: 2 });
        const result = await invoke(['login', '--instance', 'cloud.acme.dev'], {
          logins: store,
          answer: flow.answer,
        });

        const file = join(dir, 'credentials.json');
        expect(result).toEqual({
          code: 0,
          stdout: '',
          stderr:
            'Using instance https://cloud.acme.dev\n' +
            'Open https://cloud.acme.dev/device and enter the code  WDJB-MJHT\n' +
            'Waiting for you to approve…\n' +
            `No system keychain here, so the key is in ${file}, readable only by you.\n` +
            '✓ Logged in to https://cloud.acme.dev as sam@acme.dev\n' +
            '  Your key ends on 2027-02-01.\n',
        });
        expect(flow.polls).toHaveLength(3);
        expect(flow.polls[0]).not.toHaveProperty('replaces');
        expect(await store.list()).toEqual({
          current: 'https://cloud.acme.dev',
          logins: [{ ...acme, keyId: 'key_new' }],
        });
        expect(await store.keyFor(acme.instance)).toBe('cg_new');
      });

      it('names the key it replaces when logging in again on the same Instance', async () => {
        const { store } = savedLogins();
        await store.save(acme, 'cg_old');
        const flow = deviceFlow({});
        const result = await invoke(['login', '--instance', acme.instance], {
          logins: store,
          answer: flow.answer,
        });
        expect(result.code).toBe(0);
        expect(flow.polls[0]).toMatchObject({ replaces: 'key_acme' });
        expect(await store.keyFor(acme.instance)).toBe('cg_new');
      });

      it.each([
        [
          'ACCESS_DENIED',
          'Error: the login to https://cloud.acme.dev was denied',
        ],
        ['EXPIRED_TOKEN', 'Error: the code expired before it was approved'],
      ] as const)(
        'exits 3 and saves nothing on %s',
        async (refusal, message) => {
          const { store } = savedLogins();
          const result = await invoke(['login', '--instance', acme.instance], {
            logins: store,
            answer: deviceFlow({ finally: refusal }).answer,
          });
          expect(result.code).toBe(3);
          expect(result.stderr).toContain(message);
          expect(await store.list()).toEqual({ current: null, logins: [] });
        },
      );

      it('refuses before asking for a code when the address is not a Cloudgate', async () => {
        const { store } = savedLogins();
        const flow = deviceFlow({});
        const result = await invoke(['login', '--instance', acme.instance], {
          logins: store,
          answer: flow.answer,
          about: () => new Response('<html></html>', { status: 200 }),
        });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('is not a Cloudgate');
        expect(flow.polls).toHaveLength(0);
        expect(result.stderr).not.toContain('/device');
      });
    });

    describe('logout', () => {
      /**
       * Instances that hold keys by id and delete one only when asked with
       * that same key, as the server's self-delete rule does. `deleted` is
       * what changed there.
       */
      function keyHolders(keys: Record<string, string>) {
        const deleted: string[] = [];
        const answer = (url: string, init: RequestInit) => {
          const sent = (init.headers as Record<string, string>)['x-api-key'];
          const match = /\/backend\/users\/me\/api-keys\/([^/]+)$/.exec(url);
          if (!match || init.method !== 'DELETE') {
            return json({ message: 'Not found' }, 404);
          }
          if (!sent || !Object.values(keys).includes(sent)) {
            return json({ statusCode: 401, message: 'Unauthorized' }, 401);
          }
          if (keys[match[1]] !== sent) {
            return json({ message: 'a key may delete only itself' }, 403);
          }
          delete keys[match[1]];
          deleted.push(match[1]);
          return json({ success: true });
        };
        return { deleted, answer };
      }

      it('deletes the key on the current Instance and forgets it here, leaving other logins', async () => {
        const { store } = savedLogins();
        await store.save(other, 'cg_other');
        await store.save(acme, 'cg_acme');
        const instances = keyHolders({
          key_acme: 'cg_acme',
          key_other: 'cg_other',
        });

        const result = await invoke(['logout'], {
          logins: store,
          answer: instances.answer,
        });

        expect(result).toEqual({
          code: 0,
          stdout: '',
          stderr:
            'Using instance https://cloud.acme.dev\n' +
            '✓ Logged out of https://cloud.acme.dev\n',
        });
        expect(instances.deleted).toEqual(['key_acme']);
        expect(await store.list()).toEqual({ current: null, logins: [other] });
        expect(await store.keyFor(acme.instance)).toBeUndefined();
      });

      it('logs out of the Instance --instance names, even inside a folder linked elsewhere', async () => {
        const { store } = savedLogins();
        await store.save(other, 'cg_other');
        await store.save(acme, 'cg_acme');
        const instances = keyHolders({
          key_acme: 'cg_acme',
          key_other: 'cg_other',
        });

        const linked = mkdtempSync(join(tmpdir(), 'cloudgate-logout-'));
        writeLink(linked, {
          instance: acme.instance,
          organizationId: 'org_1',
          projectId: 'prj_1',
          environmentId: 'env_s',
          serviceConfigName: 'api',
          names: {
            organization: 'Shop Inc',
            project: 'shop',
            environment: 'staging',
            service: 'Shop API',
          },
        });

        const result = await invoke(
          ['logout', '--instance', 'cloud.other.io'],
          {
            logins: store,
            answer: instances.answer,
            cwd: linked,
          },
        );

        expect(result.code).toBe(0);
        expect(result.stderr).toContain(
          '✓ Logged out of https://cloud.other.io\n',
        );
        expect(instances.deleted).toEqual(['key_other']);
        expect(await store.list()).toEqual({
          current: acme.instance,
          logins: [acme],
        });
      });

      it('forgets the login when the Instance cannot be reached, saying its key was not deleted, exit 1', async () => {
        const { store } = savedLogins();
        await store.save(acme, 'cg_acme');

        const result = await invoke(['logout'], {
          logins: store,
          about: () => {
            throw Object.assign(new TypeError('fetch failed'), {
              cause: { code: 'ECONNREFUSED' },
            });
          },
        });

        expect(result).toEqual({
          code: 1,
          stdout: '',
          stderr:
            'Using instance https://cloud.acme.dev\n' +
            '✓ Logged out of https://cloud.acme.dev on this computer\n' +
            'Error: its key was not deleted on https://cloud.acme.dev: could not reach https://cloud.acme.dev (ECONNREFUSED)\n' +
            'Delete it in the console under Personal keys; until then it works until 2027-02-01.\n',
        });
        expect(await store.list()).toEqual({ current: null, logins: [] });
      });

      it('forgets a login whose key had already ended there, exit 0', async () => {
        const { store } = savedLogins();
        await store.save(acme, 'cg_revoked');

        const result = await invoke(['logout'], {
          logins: store,
          answer: keyHolders({}).answer,
        });

        expect(result).toEqual({
          code: 0,
          stdout: '',
          stderr:
            'Using instance https://cloud.acme.dev\n' +
            '✓ Logged out of https://cloud.acme.dev; its key had already ended there\n',
        });
        expect(await store.list()).toEqual({ current: null, logins: [] });
      });

      it('logs out of every saved Instance with --all', async () => {
        const { store } = savedLogins();
        await store.save(acme, 'cg_acme');
        await store.save(other, 'cg_other');
        const instances = keyHolders({
          key_acme: 'cg_acme',
          key_other: 'cg_other',
        });

        const result = await invoke(['logout', '--all'], {
          logins: store,
          answer: instances.answer,
        });

        expect(result).toEqual({
          code: 0,
          stdout: '',
          stderr:
            'Using instance https://cloud.acme.dev\n' +
            '✓ Logged out of https://cloud.acme.dev\n' +
            'Using instance https://cloud.other.io\n' +
            '✓ Logged out of https://cloud.other.io\n',
        });
        expect(instances.deleted.sort()).toEqual(['key_acme', 'key_other']);
        expect(await store.list()).toEqual({ current: null, logins: [] });
      });

      it('with --all, still logs out of the rest when one Instance cannot be reached, and exits 1', async () => {
        const { store } = savedLogins();
        await store.save(acme, 'cg_acme');
        await store.save(other, 'cg_other');
        const instances = keyHolders({
          key_acme: 'cg_acme',
          key_other: 'cg_other',
        });

        const result = await invoke(['logout', '--all'], {
          logins: store,
          answer: instances.answer,
          about: (url) => {
            if (url.startsWith(acme.instance)) {
              throw Object.assign(new TypeError('fetch failed'), {
                cause: { code: 'ENOTFOUND' },
              });
            }
            return json(aboutAnswer);
          },
        });

        expect(result.code).toBe(1);
        expect(result.stderr).toContain(
          'Error: its key was not deleted on https://cloud.acme.dev',
        );
        expect(result.stderr).toContain(
          '✓ Logged out of https://cloud.other.io\n',
        );
        expect(instances.deleted).toEqual(['key_other']);
        expect(await store.list()).toEqual({ current: null, logins: [] });
      });

      it('works against an Instance older than the CLI supports', async () => {
        const { store } = savedLogins();
        await store.save(acme, 'cg_acme');
        const instances = keyHolders({ key_acme: 'cg_acme' });

        const result = await invoke(['logout'], {
          logins: store,
          answer: instances.answer,
          about: () => json({ ...aboutAnswer, version: '0.0.0' }),
        });

        expect(result.code).toBe(0);
        expect(instances.deleted).toEqual(['key_acme']);
      });

      it('says there is nothing to do when not logged in to the Instance, exit 0', async () => {
        const { store } = savedLogins();
        await store.save(acme, 'cg_acme');

        const one = await invoke(['logout', '--instance', 'cloud.nowhere.io'], {
          logins: store,
        });
        expect(one).toEqual({
          code: 0,
          stdout: '',
          stderr:
            'You are not logged in to https://cloud.nowhere.io; nothing to do.\n',
        });

        const none = savedLogins();
        const all = await invoke(['logout', '--all'], { logins: none.store });
        expect(all).toEqual({
          code: 0,
          stdout: '',
          stderr: 'You are not logged in to any Instance; nothing to do.\n',
        });
        expect(await store.list()).toEqual({
          current: acme.instance,
          logins: [acme],
        });
      });

      it('refuses with CLOUDGATE_KEY set, exit 2, sending and forgetting nothing', async () => {
        const { store } = savedLogins();
        await store.save(acme, 'cg_acme');
        const requests: string[] = [];

        const result = await invoke(['logout'], {
          logins: store,
          env: { CLOUDGATE_KEY: 'cg_env' },
          answer: (url) => {
            requests.push(url);
            return json({}, 500);
          },
        });

        expect(result).toEqual({
          code: 2,
          stdout: '',
          stderr:
            'Error: logout forgets a saved login, and CLOUDGATE_KEY is set\n' +
            'The key in CLOUDGATE_KEY is never saved; delete it in the console under Personal keys, or unset CLOUDGATE_KEY to log out of a saved login.\n',
        });
        expect(requests).toEqual([]);
        expect(await store.list()).toEqual({
          current: acme.instance,
          logins: [acme],
        });
      });

      it('refuses --instance with --all, exit 2', async () => {
        const result = await invoke([
          'logout',
          '--all',
          '--instance',
          'cloud.acme.dev',
        ]);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain(
          'Error: use --instance or --all, not both\n',
        );
      });
    });
  });
});
