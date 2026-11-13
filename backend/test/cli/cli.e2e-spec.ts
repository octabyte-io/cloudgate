import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { parse } from 'dotenv';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { ApplicationsService } from '../../src/applications/applications.service';
import { cloudgateDirectoryOn } from '../../src/common/config/cloudgate-directory';
import { ComposeService } from '../../src/compose/compose.service';
import { PostgresService } from '../../src/databases/postgres/postgres.service';
import { ConfigLocations } from '../../src/project-config/config-locations.service';
import * as schema from '../../src/db/schema';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { PtyChannelService } from '../../src/realtime/channels/pty-channel.service';
import type { StreamChannel } from '../../src/realtime/channels/stream-channel';
import { PermissionService } from '../../src/rbac/permission.service';
import type {
  ExecOptions,
  ExecResult,
} from '../../src/remote/remote-exec.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { signUpMember, createOrganization } from '../utils/test-auth';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { buildZip } from '../utils/zip-archive';
import {
  buildCli,
  configFolderOf,
  emptyFolder,
  filesUnder,
  freePort,
  removeFolder,
  runCli,
  startCli,
  startConsoleStandIn,
  startOtherSite,
  testCertificate,
} from './cli-harness';
import type { TestCertificate } from './cli-harness';

jest.setTimeout(120_000);

/**
 * The one CLI e2e suite: the built `cloudgate`, run as a CI job
 * runs it, against the harness backend. Every later CLI ticket adds its walk
 * here rather than adding a suite, so the e2e run does not grow per command.
 *
 * A walk checks only what a person or a job can see — the exit code, stdout,
 * stderr, the files written, what changed on the Instance — and never which
 * requests the CLI made. Walks that do not need a browser login use a
 * Personal key the harness mints, passed as `CLOUDGATE_KEY`.
 */

const owner = {
  name: 'Sam Rivera',
  email: 'sam@shop.example',
  password: 'super-secret-password',
};

const NINETY_DAYS = 90 * 24 * 60 * 60;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[/;

describe('Cloudgate CLI (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  /** The API's own origin, which the public answer advertises. */
  let apiOrigin: string;
  let instance: string;
  let closeConsole: () => Promise<void>;
  /** The same console stand-in, over https:// with {@link certificate}. */
  let tlsInstance: string;
  let closeTlsConsole: () => Promise<void>;
  let certificateFolder: string;
  let certificate: TestCertificate;
  let home: string;
  /**
   * The platform host's root for this test, made fresh for each: an upload
   * is compared with the build host's files (spec #10), so a tree another
   * test or an earlier run left under a shared root would change what a
   * deploy sends.
   */
  let platformRoot: string;
  let originalPlatformRoot: string | undefined;
  /** What the harness's builder does with the next build: succeed, or fail. */
  let nextBuild: 'done' | 'fail' = 'done';
  /**
   * What each Swarm service on the platform host has written, by its name
   * (an Application's `appName`), one list of lines per task.
   */
  let swarmLogs = new Map<string, string[][]>();

  beforeAll(async () => {
    buildCli();
    // The backend's own address goes into its config before it boots, as
    // deploy/install.sh writes it, so the public answer advertises a real one.
    const apiPort = await freePort();
    apiOrigin = `http://127.0.0.1:${apiPort}`;
    const previousApiUrl = process.env.CLOUDGATE_API_URL;
    process.env.CLOUDGATE_API_URL = apiOrigin;
    try {
      ctx = await createTestApp();
    } finally {
      if (previousApiUrl === undefined) delete process.env.CLOUDGATE_API_URL;
      else process.env.CLOUDGATE_API_URL = previousApiUrl;
    }
    server = ctx.app.getHttpServer() as App;
    standInForTheBuilder();
    await ctx.app.listen(apiPort, '127.0.0.1');
    const standIn = await startConsoleStandIn(apiPort);
    instance = standIn.url;
    closeConsole = standIn.close;
    certificateFolder = emptyFolder('tls');
    certificate = testCertificate(certificateFolder);
    const tlsStandIn = await startConsoleStandIn(apiPort, {
      tls: certificate,
    });
    tlsInstance = tlsStandIn.url;
    closeTlsConsole = tlsStandIn.close;
  });

  afterAll(async () => {
    await closeConsole?.();
    await closeTlsConsole?.();
    if (certificateFolder) removeFolder(certificateFolder);
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    home = emptyFolder('home');
    platformRoot = emptyFolder('platform');
    originalPlatformRoot = process.env.CLOUDGATE_DIRECTORY;
    process.env.CLOUDGATE_DIRECTORY = platformRoot;
    nextBuild = 'done';
    swarmLogs = new Map();
  });

  afterEach(() => {
    removeFolder(home);
  });

  /**
   * The machine a `deploy` walk builds on, as close to the real one as this
   * box allows. Every shell program runs for real on the platform host — the
   * upload lands under {@link platformRoot}, made fresh for each test,
   * through the same `/bin/sh` whose 128 KiB cap on one argument an earlier
   * fix lifted, and the Deployment log is
   * a real file the real `tail -f` behind `/listen-deployment` follows — except
   * the builder's and Docker's, which this box has neither of: the build
   * program instead appends one line to the log (or fails, as {@link
   * nextBuild} says), and the Docker API answers as a Swarm with the new task
   * already running (the double `drop-deploy.e2e-spec.ts` uses).
   */
  function standInForTheBuilder(): void {
    const exec = ctx.app.get(RemoteExecService);
    const realExecAsync = (
      command: string,
      options?: ExecOptions,
    ): Promise<ExecResult> =>
      RemoteExecService.prototype.execAsync.call(
        exec,
        command,
        options,
      ) as Promise<ExecResult>;
    const realExecFileAsync = (
      command: string,
      args: string[],
      options?: Parameters<RemoteExecService['execFileAsync']>[2],
    ): Promise<ExecResult> =>
      RemoteExecService.prototype.execFileAsync.call(
        exec,
        command,
        args,
        options,
      ) as Promise<ExecResult>;
    const builds = /\b(nixpacks|railpack|docker|pack build|heroku)\b/;
    jest
      .spyOn(exec, 'execAsync')
      .mockImplementation(async (command: string, options?: ExecOptions) => {
        if (!builds.test(command)) return realExecAsync(command, options);
        const log = /(?:^|\)) >> ('[^']+'|\S+) 2>&1/.exec(command)?.[1];
        if (nextBuild === 'fail') {
          if (log)
            await realExecAsync(
              `echo '[build] the harness builder failed' >> ${log}`,
            );
          throw new Error('the harness builder failed');
        }
        if (log) {
          return realExecAsync(
            `echo '[build] built by the harness builder' >> ${log}`,
          );
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });
    jest
      .spyOn(exec, 'execFileAsync')
      .mockImplementation((command, args, options) => {
        // `docker inspect --type service <name>`: a Swarm service named by
        // {@link swarmLogs} is there, unlabelled, as the gateway asks it.
        const name = args[args.length - 1];
        if (
          command === 'docker' &&
          args[0] === 'inspect' &&
          args.includes('service') &&
          swarmLogs.has(name)
        ) {
          return Promise.resolve({
            stdout: `${name}|<no value>\n`,
            stderr: '',
            exitCode: 0,
          });
        }
        // `docker service ls --filter name=<name>`: still listed.
        const listed = args
          .find((arg) => arg.startsWith('name='))
          ?.slice('name='.length);
        if (
          command === 'docker' &&
          args[0] === 'service' &&
          args[1] === 'ls' &&
          listed &&
          swarmLogs.has(listed)
        ) {
          return Promise.resolve({
            stdout: `${listed}\n`,
            stderr: '',
            exitCode: 0,
          });
        }
        return builds.test(command)
          ? Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
          : realExecFileAsync(command, args, options);
      });
    // `docker service logs` in the pty `/docker-container-logs` runs on the
    // platform host: `--tail` lines of each task of {@link swarmLogs}, in
    // turn, with a pty's line endings; then, without `--follow`, the
    // follower exits, as Docker's does after the tail.
    jest
      .spyOn(ctx.app.get(PtyChannelService), 'spawn')
      .mockImplementation((_file, args): StreamChannel => {
        const command = args[args.length - 1];
        const name = command.trim().split(/\s+/).pop() ?? '';
        const tail = Number(/--tail (\d+)/.exec(command)?.[1] ?? '0');
        const emitter = new EventEmitter();
        setImmediate(() => {
          for (const lines of swarmLogs.get(name) ?? [])
            emitter.emit(
              'data',
              lines
                .slice(-tail)
                .map((line) => `${line}\r\n`)
                .join(''),
            );
          if (!/--follow/.test(command)) emitter.emit('close', 0);
        });
        return {
          write: () => undefined,
          close: () => undefined,
          onData: (listener) => void emitter.on('data', listener),
          onStderr: () => undefined,
          onClose: (listener) => void emitter.on('close', listener),
          onError: (listener) => void emitter.on('error', listener),
        };
      });
    const service = {
      inspect: () => Promise.reject(new Error('no such service')),
      update: () => Promise.resolve(undefined),
    };
    const docker = {
      getService: () => service,
      createService: () => Promise.resolve(undefined),
      listTasks: () =>
        Promise.resolve([
          { Status: { State: 'running', Timestamp: new Date().toISOString() } },
        ]),
    };
    jest
      .spyOn(ctx.app.get(RemoteDockerFactory), 'getRemoteDocker')
      .mockResolvedValue(docker as never);
  }

  afterEach(() => {
    removeFolder(home);
    if (originalPlatformRoot === undefined)
      delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = originalPlatformRoot;
    removeFolder(platformRoot);
  });

  /** The instance owner, and a Personal key of theirs that ends in 90 days. */
  async function ownerWithKey(): Promise<{
    cookie: string;
    keyId: string;
    key: string;
  }> {
    const signedUp = await request(server)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(signedUp.status).toBe(200);
    const cookie = (signedUp.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const created = await request(server)
      .post('/users/me/api-keys')
      .set('Cookie', cookie)
      .send({ name: 'ci', expiresIn: NINETY_DAYS });
    expect(created.status).toBe(201);
    const { id: keyId, key } = created.body as { id: string; key: string };
    return { cookie, keyId, key };
  }

  /**
   * `cloudgate login` against the harness, approved the way the
   * console's `/device` screen approves it: the code looked up, then approved,
   * with the person's session cookie.
   */
  async function loginAs(
    cookie: string,
    address: string,
    env: Record<string, string> = {},
  ) {
    const running = startCli(['login', '--instance', address], { home, env });
    const [, shown] = await running.stderrMatch(
      /enter the code\s+([A-Z0-9]{4}-[A-Z0-9]{4})/,
    );
    const looked = await request(server)
      .get('/api/auth/device')
      .query({ user_code: shown })
      .set('Cookie', cookie);
    expect(looked.status).toBe(200);
    const approved = await request(server)
      .post('/api/auth/device/approve')
      .set('Cookie', cookie)
      .send({ userCode: shown });
    expect(approved.status).toBe(200);
    return running.done;
  }

  /** The keys `credentials.json` holds, by Instance. */
  function savedKeys(): Record<string, string> {
    return JSON.parse(
      readFileSync(join(configFolderOf(home), 'credentials.json'), 'utf8'),
    ) as Record<string, string>;
  }

  describe('login and saved Instances', () => {
    it('logs in through a code approved in the console, and whoami then shows a key ending 90 days after login', async () => {
      const { cookie } = await ownerWithKey();
      const loggedInAt = Date.now();

      const login = await loginAs(cookie, instance);

      expect(login.code).toBe(0);
      expect(login.stdout).toBe('');
      expect(login.stderr).toContain(
        `Open ${instance}/device and enter the code`,
      );
      expect(login.stderr).toContain(
        `✓ Logged in to ${instance} as ${owner.email}`,
      );
      // No keychain in a walk, so the key is in a file only its owner reads,
      // and the run said so in one line.
      const credentials = join(configFolderOf(home), 'credentials.json');
      expect(login.stderr).toContain(
        `No system keychain here, so the key is in ${credentials}, readable only by you.\n`,
      );
      expect(statSync(credentials).mode & 0o777).toBe(0o600);

      // No --instance and no CLOUDGATE_KEY: the current Instance, and its
      // saved login.
      const whoami = await runCli(['whoami', '--json'], { home });
      expect(whoami.code).toBe(0);
      const facts = JSON.parse(whoami.stdout) as {
        instance: string;
        email: string;
        organization: { id: string; name: string };
        keyFrom: string;
        keyEndsAt: string;
      };
      expect(facts).toMatchObject({
        instance,
        email: owner.email,
        keyFrom: 'login',
        organization: { name: expect.any(String) as string },
      });
      const ninetyDays = loggedInAt + NINETY_DAYS * 1000;
      expect(
        Math.abs(new Date(facts.keyEndsAt).getTime() - ninetyDays),
      ).toBeLessThan(5 * 60 * 1000);

      // The key is one of the person's Personal keys, named for this computer.
      const keys = await request(server)
        .get('/users/me/api-keys')
        .set('Cookie', cookie);
      const listed = (
        keys.body as {
          apiKeys: Array<{ name: string; expiresAt: string }>;
        }
      ).apiKeys.filter((key) => key.name.startsWith('cloudgate on '));
      expect(listed).toHaveLength(1);
      expect(new Date(listed[0].expiresAt).toISOString()).toBe(facts.keyEndsAt);
    });

    it('deletes the previous key on the Instance when logging in there again', async () => {
      const { cookie } = await ownerWithKey();
      expect((await loginAs(cookie, instance)).code).toBe(0);
      const first = savedKeys()[instance];

      expect((await loginAs(cookie, instance)).code).toBe(0);
      const second = savedKeys()[instance];

      expect(second).not.toBe(first);
      const old = await request(server)
        .get('/users/me/whoami')
        .set('x-api-key', first);
      expect(old.status).toBe(401);
      const current = await request(server)
        .get('/users/me/whoami')
        .set('x-api-key', second);
      expect(current.status).toBe(200);
    });

    it('holds logins to two Instances at once; instance list marks the current one and instance use switches', async () => {
      const { cookie } = await ownerWithKey();
      const tls = { NODE_EXTRA_CA_CERTS: certificate.certFile };
      expect((await loginAs(cookie, instance)).code).toBe(0);
      expect((await loginAs(cookie, tlsInstance, tls)).code).toBe(0);

      const listed = await runCli(['instance', 'list', '--json'], { home });
      expect(listed.code).toBe(0);
      expect(
        (JSON.parse(listed.stdout) as Array<Record<string, unknown>>).map(
          ({ instance: address, email, current }) => ({
            address,
            email,
            current,
          }),
        ),
      ).toEqual([
        { address: instance, email: owner.email, current: false },
        { address: tlsInstance, email: owner.email, current: true },
      ]);

      const used = await runCli(['instance', 'use', instance], { home });
      expect(used).toMatchObject({ code: 0, stdout: '' });
      expect(used.stderr).toContain(`✓ Now using ${instance}`);
      const whoami = await runCli(['whoami', '--json'], { home, env: tls });
      expect(JSON.parse(whoami.stdout)).toMatchObject({ instance });

      const text = await runCli(['instance', 'list'], { home });
      expect(text.stdout).toContain(`*  ${instance} `);

      const nowhere = await runCli(
        ['instance', 'use', 'https://cloud.nowhere.example'],
        { home },
      );
      expect(nowhere.code).toBe(3);
      expect(nowhere.stderr).toContain(
        'Error: you are not logged in to https://cloud.nowhere.example\n' +
          'Run: cloudgate login --instance https://cloud.nowhere.example\n',
      );
    });

    it('lets CLOUDGATE_KEY beat a saved login, and never saves it', async () => {
      const { cookie, key } = await ownerWithKey();
      expect((await loginAs(cookie, instance)).code).toBe(0);
      const before = readFileSync(
        join(configFolderOf(home), 'credentials.json'),
        'utf8',
      );

      const whoami = await runCli(
        ['whoami', '--json', '--instance', instance],
        {
          home,
          env: { CLOUDGATE_KEY: key },
        },
      );
      expect(JSON.parse(whoami.stdout)).toMatchObject({ keyFrom: 'env' });
      const after = readFileSync(
        join(configFolderOf(home), 'credentials.json'),
        'utf8',
      );
      expect(after).toBe(before);
      expect(after).not.toContain(key);
    });

    it('logs out: the key is deleted on the Instance, which then answers it 401, and forgotten here', async () => {
      const { cookie, key: consoleKey } = await ownerWithKey();
      expect((await loginAs(cookie, instance)).code).toBe(0);
      const saved = savedKeys()[instance];

      const logout = await runCli(['logout'], { home });

      expect(logout).toMatchObject({ code: 0, stdout: '' });
      expect(logout.stderr).toContain(`✓ Logged out of ${instance}\n`);
      const after = await request(server)
        .get('/users/me/whoami')
        .set('x-api-key', saved);
      expect(after.status).toBe(401);
      expect(savedKeys()).toEqual({});
      const listed = await runCli(['instance', 'list', '--json'], { home });
      expect(JSON.parse(listed.stdout)).toEqual([]);
      // The person's other key, made in the console, is untouched.
      const other = await request(server)
        .get('/users/me/whoami')
        .set('x-api-key', consoleKey);
      expect(other.status).toBe(200);
    });

    it('forgets a saved key revoked in the console, saying the login has ended, exit 3', async () => {
      const { cookie } = await ownerWithKey();
      expect((await loginAs(cookie, instance)).code).toBe(0);
      const keys = await request(server)
        .get('/users/me/api-keys')
        .set('Cookie', cookie);
      const cliKey = (
        keys.body as { apiKeys: Array<{ id: string; name: string }> }
      ).apiKeys.find((key) => key.name.startsWith('cloudgate on '));
      const revoked = await request(server)
        .delete(`/users/me/api-keys/${cliKey?.id}`)
        .set('Cookie', cookie);
      expect(revoked.status).toBe(200);

      const whoami = await runCli(['whoami'], { home });
      expect(whoami.code).toBe(3);
      expect(whoami.stderr).toContain(
        `Error: your login to ${instance} has ended\n` +
          `Run: cloudgate login --instance ${instance}\n`,
      );
      expect(savedKeys()).toEqual({});
    });
  });

  describe('the package', () => {
    it('answers --version with the package version and --help with the commands', async () => {
      // The package's own manifest is the independent source of the version.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { version } = require('../../../cli/package.json') as {
        version: string;
      };

      const shown = await runCli(['--version'], { home });
      expect(shown).toEqual({ code: 0, stdout: `${version}\n`, stderr: '' });

      const help = await runCli(['--help'], { home });
      expect(help.code).toBe(0);
      expect(help.stdout).toContain('whoami');
      expect(help.stdout).toContain('EXIT CODES');

      const commandHelp = await runCli(['whoami', '--help'], { home });
      expect(commandHelp.code).toBe(0);
      expect(commandHelp.stdout).toContain('cloudgate whoami [--json]');
    });
  });

  describe('template try on the local Docker', () => {
    /** What Docker still holds of a Compose project, by kind. */
    const leftOf = (project: string) =>
      Object.fromEntries(
        (['container', 'network', 'volume'] as const).map((kind) => [
          kind,
          execFileSync(
            'docker',
            [
              kind,
              'ls',
              ...(kind === 'container' ? ['--all'] : []),
              '--quiet',
              '--filter',
              `label=com.docker.compose.project=${project}`,
            ],
            { encoding: 'utf8' },
          ).trim(),
        ]),
      );

    it('starts a pinned nginx Template, passes its Domain, exits 0 and leaves no container, network or volume of its project', async () => {
      const parent = emptyFolder('try');
      const folder = join(parent, 'hello');
      mkdirSync(folder);
      writeFileSync(
        join(folder, 'template.yaml'),
        'name: Hello\ndescription: A static page.\ntags: [web]\ncloudgate: 0.1.0\ncompose: app\ndomains:\n  - { service: web, port: 80 }\n',
      );
      writeFileSync(
        join(folder, 'cloudgate.yaml'),
        'version: 1\nservices:\n  app: { kind: compose, managed: console }\n',
      );
      writeFileSync(
        join(folder, 'docker-compose.yml'),
        'services:\n  web:\n    image: nginx:1.27.3-alpine\n    volumes:\n      - html:/usr/share/nginx/html\nvolumes:\n  html: {}\n',
      );
      writeFileSync(
        join(folder, 'logo.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"></svg>',
      );

      try {
        const result = await runCli(['template', 'try', folder], {
          home,
          env: process.env.DOCKER_HOST
            ? { DOCKER_HOST: process.env.DOCKER_HOST }
            : {},
        });

        expect(result.stdout).toBe('✓ web:80/\n');
        expect(result.code).toBe(0);
        const project = /Starting (cg-try-hello-[a-z0-9]+) /.exec(
          result.stderr,
        )?.[1];
        expect(project).toBeDefined();
        expect(leftOf(project as string)).toEqual({
          container: '',
          network: '',
          volume: '',
        });
      } finally {
        removeFolder(parent);
      }
    });
  });

  describe('whoami with CLOUDGATE_KEY', () => {
    it('prints the email, the default Organization and the key end as JSON, and writes nothing', async () => {
      const { cookie, keyId, key } = await ownerWithKey();
      const organizations = await request(server)
        .get('/organizations')
        .set('Cookie', cookie);
      const [defaultOrganization] = organizations.body as {
        id: string;
        name: string;
      }[];
      const [row] = await ctx.db
        .select({ expiresAt: schema.apikey.expiresAt })
        .from(schema.apikey)
        .where(eq(schema.apikey.id, keyId));

      const result = await runCli(
        ['whoami', '--json', '--instance', instance],
        { home, env: { CLOUDGATE_KEY: key } },
      );

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        instance,
        email: owner.email,
        organization: {
          id: defaultOrganization.id,
          name: defaultOrganization.name,
        },
        keyFrom: 'env',
        keyEndsAt: row.expiresAt?.toISOString(),
      });
      // One line of JSON and nothing else on stdout; the Instance on stderr.
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      expect(result.stderr).toBe(`Using instance ${instance}\n`);
      // Not a terminal: no colour, no spinner frame.
      expect(result.stdout + result.stderr).not.toMatch(ANSI);
      expect(result.stderr).not.toContain('\r');
      // The key is never saved: the home folder is as empty as it started.
      expect(filesUnder(home)).toEqual([]);
    });

    it('prints aligned columns without --json, the Instance named by CLOUDGATE_INSTANCE', async () => {
      const { key } = await ownerWithKey();

      const result = await runCli(['whoami'], {
        home,
        env: { CLOUDGATE_KEY: key, CLOUDGATE_INSTANCE: instance },
      });

      expect(result.code).toBe(0);
      const lines = result.stdout.split('\n');
      expect(lines[0]).toBe(`Instance      ${instance}`);
      expect(lines[1]).toBe(`Logged in as  ${owner.email}`);
      expect(lines[2]).toMatch(/^Organization {2}\S/);
      expect(lines[3]).toMatch(
        /^Key ends {6}\d{4}-\d{2}-\d{2} \(in 90 days\)$/,
      );
      expect(result.stderr).toBe(`Using instance ${instance}\n`);
    });

    it('exits 3 for a key the Instance does not accept, with Error: on stderr and stdout empty', async () => {
      await ownerWithKey();

      const result = await runCli(
        ['whoami', '--json', '--instance', instance],
        { home, env: { CLOUDGATE_KEY: 'cg_not-a-key-anyone-holds' } },
      );

      expect(result.code).toBe(3);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(
        new RegExp(`^Using instance ${instance}\\nError: Unauthorized\\n`),
      );
      // A refused key's value is never repeated back.
      expect(result.stderr).not.toContain('cg_not-a-key-anyone-holds');
    });

    it('exits 3 and asks nothing when there is no key at all', async () => {
      const result = await runCli(
        ['whoami', '--json', '--instance', instance],
        {
          home,
        },
      );

      expect(result.code).toBe(3);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(`Error: not logged in to ${instance}`);
    });

    it('exits 2 for an unknown flag, naming it', async () => {
      const { key } = await ownerWithKey();

      const result = await runCli(['whoami', '--jsno'], {
        home,
        env: { CLOUDGATE_KEY: key, CLOUDGATE_INSTANCE: instance },
      });

      expect(result.code).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/^Error: unknown flag --jsno/);
    });
  });
  describe('the public answer', () => {
    it('answers with no credential, naming Cloudgate, the server version and the API origin', async () => {
      // backend/package.json is the independent source of the version.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { version } = require('../../package.json') as { version: string };

      const direct = await request(server).get('/settings/about');
      expect(direct.status).toBe(200);
      expect(direct.body).toEqual({
        product: 'cloudgate',
        version,
        apiUrl: apiOrigin,
        mode: 'self-hosted',
      });

      // And through the console's /backend rewrite, which is where the CLI asks.
      const throughConsole = await fetch(`${instance}/backend/settings/about`);
      expect(throughConsole.status).toBe(200);
      expect(await throughConsole.json()).toEqual(direct.body);
    });
  });

  describe('the Instance check', () => {
    it('reaches the harness from an address with no scheme, which gets https://', async () => {
      const { key } = await ownerWithKey();
      const bare = tlsInstance.replace(/^https:\/\//, '');

      const result = await runCli(['whoami', '--json', '--instance', bare], {
        home,
        env: {
          CLOUDGATE_KEY: key,
          NODE_EXTRA_CA_CERTS: certificate.certFile,
        },
      });

      expect(result.code).toBe(0);
      expect(result.stderr).toBe(`Using instance ${tlsInstance}\n`);
      expect(JSON.parse(result.stdout)).toMatchObject({
        instance: tlsInstance,
        email: owner.email,
      });
    });

    it('reaches the harness from a pasted console URL, keeping only its origin', async () => {
      const { key } = await ownerWithKey();

      const result = await runCli(
        ['whoami', '--instance', `${instance}/projects/p_1?tab=logs#top`],
        { home, env: { CLOUDGATE_KEY: key } },
      );

      expect(result.code).toBe(0);
      expect(result.stderr).toBe(`Using instance ${instance}\n`);
      expect(result.stdout).toContain(`Instance      ${instance}\n`);
    });

    it('accepts plain http:// on localhost', async () => {
      const { key } = await ownerWithKey();
      const local = instance.replace('127.0.0.1', 'localhost');

      const result = await runCli(['whoami', '--instance', local], {
        home,
        env: { CLOUDGATE_KEY: key },
      });

      expect(result.code).toBe(0);
      expect(result.stderr).toBe(`Using instance ${local}\n`);
    });

    it('refuses plain http:// to any other host with exit 2, before asking anything', async () => {
      const result = await runCli(
        ['whoami', '--instance', 'http://cloud.acme.example'],
        { home, env: { CLOUDGATE_KEY: 'cg_never-sent' } },
      );

      expect(result.code).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(
        'Error: http://cloud.acme.example is plain http://, which sends your key unencrypted\n' +
          'Use https://cloud.acme.example, or pass --allow-http to use it anyway.\n',
      );
    });

    it('refuses a site that is not a Cloudgate with exit 1, and the site never sees the key', async () => {
      const site = await startOtherSite(() => ({
        status: 200,
        type: 'text/html',
        body: '<html>a shop</html>',
      }));
      try {
        const result = await runCli(
          ['whoami', '--json', '--instance', site.url],
          { home, env: { CLOUDGATE_KEY: 'cg_never-sent' } },
        );

        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain(
          `Error: ${site.url} is not a Cloudgate\n`,
        );
        expect(site.received.length).toBeGreaterThan(0);
        expect(site.received.filter((seen) => seen.apiKey)).toEqual([]);
      } finally {
        await site.close();
      }
    });

    it('refuses a Cloudgate older than the CLI supports with exit 1, naming both versions, and sends it no key', async () => {
      const older = await startOtherSite((path) =>
        path === '/backend/settings/about'
          ? {
              status: 200,
              type: 'application/json',
              body: JSON.stringify({
                product: 'cloudgate',
                version: '0.0.0',
                apiUrl: null,
              }),
            }
          : { status: 500, type: 'text/plain', body: 'not for this walk' },
      );
      try {
        const result = await runCli(['whoami', '--instance', older.url], {
          home,
          env: { CLOUDGATE_KEY: 'cg_never-sent' },
        });

        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toMatch(
          new RegExp(
            `Error: ${older.url} runs Cloudgate 0\\.0\\.0, and this CLI needs \\d+\\.\\d+\\.\\d+\\S* or newer\\n`,
          ),
        );
        expect(older.received.filter((seen) => seen.apiKey)).toEqual([]);
      } finally {
        await older.close();
      }
    });
  });

  describe('link and unlink with CLOUDGATE_KEY', () => {
    /**
     * The owner, a key, and a Service to link to — in a **second**
     * Organization, not the owner's default, so every read the link makes has
     * to name it with `x-organization-id` to find anything.
     */
    async function serviceInSecondOrganization() {
      const { cookie, key } = await ownerWithKey();
      const me = await request(server).get('/users/me').set('x-api-key', key);
      const userId = (me.body as { id: string }).id;
      const created = await createOrganization(server, ctx.db, cookie, {
        name: 'Second Org',
      });
      expect(created.status).toBe(201);
      const organizationId = (created.body as { id: string }).id;
      const ownerCtx = {
        user: { id: userId },
        session: { activeOrganizationId: organizationId },
      };
      const project = await ctx.app
        .get(ProjectsService)
        .create(ownerCtx, { name: 'shop' });
      const environments = ctx.app.get(EnvironmentsService);
      const staging = await environments.create(ownerCtx, {
        name: 'staging',
        projectId: project.projectId,
      });
      await environments.create(ownerCtx, {
        name: 'qa',
        projectId: project.projectId,
      });
      const application = await ctx.app
        .get(ApplicationsService)
        .create(ownerCtx, {
          name: 'Shop API',
          appName: 'shop-api',
          environmentId: staging.environmentId,
        });
      const [row] = await ctx.db
        .select({ configName: schema.application.configName })
        .from(schema.application)
        .where(eq(schema.application.applicationId, application.applicationId));
      return {
        key,
        organizationId,
        projectId: project.projectId,
        environmentId: staging.environmentId,
        configName: row.configName,
      };
    }

    it('links a folder from flags, which the nearest-link rule then applies from a subfolder, and unlink removes it without a request', async () => {
      const seeded = await serviceInSecondOrganization();
      const repo = emptyFolder('repo');
      try {
        writeFileSync(join(repo, '.gitignore'), 'node_modules\n');

        // Names, in the wrong case, for every level: ids are the other half.
        const linked = await runCli(
          [
            'link',
            '--org',
            'second org',
            '--project',
            'SHOP',
            '--env',
            'Staging',
            '--service',
            seeded.configName.toUpperCase(),
            '--yes',
          ],
          {
            home,
            cwd: repo,
            env: { CLOUDGATE_KEY: seeded.key, CLOUDGATE_INSTANCE: instance },
          },
        );

        expect(linked.code).toBe(0);
        expect(linked.stdout).toBe('');
        expect(linked.stderr).toContain(
          `✓ Linked ./ to ${seeded.configName} in staging of Project shop on ${instance.replace('http://', '')}`,
        );
        expect(
          JSON.parse(
            readFileSync(join(repo, '.cloudgate', 'link.json'), 'utf8'),
          ),
        ).toEqual({
          instance,
          organizationId: seeded.organizationId,
          projectId: seeded.projectId,
          environmentId: seeded.environmentId,
          serviceConfigName: seeded.configName,
          names: {
            organization: 'Second Org',
            project: 'shop',
            environment: 'staging',
            service: seeded.configName,
          },
        });
        expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe(
          'node_modules\n.cloudgate/\n',
        );

        // From a subfolder, with no --instance: the link's Instance is used.
        const sub = join(repo, 'src', 'routes');
        mkdirSync(sub, { recursive: true });
        const fromSub = await runCli(['whoami', '--json'], {
          home,
          cwd: sub,
          env: { CLOUDGATE_KEY: seeded.key },
        });
        expect(fromSub.code).toBe(0);
        expect(
          (JSON.parse(fromSub.stdout) as { instance: string }).instance,
        ).toBe(instance);

        // A CLOUDGATE_INSTANCE that disagrees with the link is refused, naming both.
        const disagreeing = await runCli(['whoami'], {
          home,
          cwd: sub,
          env: {
            CLOUDGATE_KEY: seeded.key,
            CLOUDGATE_INSTANCE: 'https://cloud.other.io',
          },
        });
        expect(disagreeing.code).toBe(2);
        expect(disagreeing.stderr).toContain(
          `Error: CLOUDGATE_INSTANCE https://cloud.other.io is not the Instance this folder is linked to, ${instance}`,
        );

        // unlink needs no key and no Instance: it makes no request.
        const unlinked = await runCli(['unlink'], { home, cwd: sub });
        expect(unlinked.code).toBe(0);
        expect(unlinked.stderr).toContain('Nothing changed on the Instance.');
        expect(existsSync(join(repo, '.cloudgate', 'link.json'))).toBe(false);
      } finally {
        removeFolder(repo);
      }
    });

    it('refuses an Environment where the Config name is missing, naming both', async () => {
      const seeded = await serviceInSecondOrganization();
      const repo = emptyFolder('repo');
      try {
        const result = await runCli(
          [
            'link',
            '--org',
            seeded.organizationId,
            '--project',
            seeded.projectId,
            '--env',
            'qa',
            '--service',
            seeded.configName,
          ],
          {
            home,
            cwd: repo,
            env: { CLOUDGATE_KEY: seeded.key, CLOUDGATE_INSTANCE: instance },
          },
        );

        expect(result.code).toBe(1);
        expect(result.stderr).toContain(
          `Error: no Service with Config name "${seeded.configName}" in Environment qa of Project shop`,
        );
        expect(filesUnder(repo)).toEqual([]);
      } finally {
        removeFolder(repo);
      }
    });

    it('with no terminal, refuses naming the first missing flag and exits 2', async () => {
      const seeded = await serviceInSecondOrganization();
      const repo = emptyFolder('repo');
      try {
        const result = await runCli(['link', '--org', 'Second Org'], {
          home,
          cwd: repo,
          env: { CLOUDGATE_KEY: seeded.key, CLOUDGATE_INSTANCE: instance },
        });

        expect(result.code).toBe(2);
        expect(result.stderr).toContain(
          'Error: no Project. Pass --project or set CLOUDGATE_PROJECT.',
        );
        expect(filesUnder(repo)).toEqual([]);
      } finally {
        removeFolder(repo);
      }
    });
  });

  describe('a Project folder with CLOUDGATE_KEY', () => {
    /**
     * The owner, a key, and Project shop in the owner's default
     * Organization: Environment staging holding one Application, whose
     * Config name the walk reads back. The Project's config is the empty
     * one every new Project gets, kept in Cloudgate.
     */
    async function seededProject() {
      const { cookie, key } = await ownerWithKey();
      const me = await request(server).get('/users/me').set('x-api-key', key);
      const userId = (me.body as { id: string }).id;
      const organizations = await request(server)
        .get('/organizations')
        .set('Cookie', cookie);
      const [organization] = organizations.body as {
        id: string;
        name: string;
      }[];
      const ownerCtx = {
        user: { id: userId },
        session: { activeOrganizationId: organization.id },
      };
      const project = await ctx.app
        .get(ProjectsService)
        .create(ownerCtx, { name: 'shop' });
      const staging = await ctx.app.get(EnvironmentsService).create(ownerCtx, {
        name: 'staging',
        projectId: project.projectId,
      });
      const application = await ctx.app
        .get(ApplicationsService)
        .create(ownerCtx, {
          name: 'Shop API',
          appName: 'shop-api',
          environmentId: staging.environmentId,
        });
      const [row] = await ctx.db
        .select({ configName: schema.application.configName })
        .from(schema.application)
        .where(eq(schema.application.applicationId, application.applicationId));
      return {
        key,
        organization,
        projectId: project.projectId,
        environmentId: staging.environmentId,
        configName: row.configName,
        ownerCtx,
        env: { CLOUDGATE_KEY: key, CLOUDGATE_INSTANCE: instance },
      };
    }

    /** The Project's config as `GET /projects/:id/config` answers it. */
    async function configOf(seeded: {
      key: string;
      organization: { id: string };
      projectId: string;
    }) {
      const answered = await request(server)
        .get(`/projects/${seeded.projectId}/config`)
        .set('x-api-key', seeded.key)
        .set('x-organization-id', seeded.organization.id);
      expect(answered.status).toBe(200);
      return (answered.body as { location: { text: string; version: number } })
        .location;
    }

    const sha256 = (text: string) =>
      createHash('sha256').update(text).digest('hex');

    const wholeProject = [
      'link',
      '--whole-project',
      '--project',
      'shop',
      '--env',
      'staging',
    ];

    it('links a folder as the whole Project: cloudgate.yaml is the config, the link holds no Service and the version, and git ignores both', async () => {
      const seeded = await seededProject();
      const config = await configOf(seeded);
      const repo = emptyFolder('monorepo');
      try {
        writeFileSync(join(repo, '.gitignore'), 'node_modules\n');

        const linked = await runCli(wholeProject, {
          home,
          cwd: repo,
          env: seeded.env,
        });

        expect(linked.stderr).not.toContain('Error');
        expect(linked.code).toBe(0);
        expect(linked.stderr).toContain(
          `✓ Linked ./ to the whole Project shop, staging by default, on ${instance.replace('http://', '')}`,
        );
        // The config as Cloudgate keeps it: Shop API's entry, written when
        // the Application was made.
        expect(config.text).toContain(
          `  ${seeded.configName}:\n    kind: web\n`,
        );
        expect(readFileSync(join(repo, 'cloudgate.yaml'), 'utf8')).toBe(
          config.text,
        );
        expect(
          JSON.parse(
            readFileSync(join(repo, '.cloudgate', 'link.json'), 'utf8'),
          ),
        ).toEqual({
          instance,
          organizationId: seeded.organization.id,
          projectId: seeded.projectId,
          environmentId: seeded.environmentId,
          workingCopy: {
            version: config.version,
            sha256: sha256(config.text),
          },
          names: {
            organization: seeded.organization.name,
            project: 'shop',
            environment: 'staging',
          },
        });
        expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe(
          'node_modules\n.cloudgate/\n/cloudgate.yaml\n',
        );
      } finally {
        removeFolder(repo);
      }
    });

    it("with no terminal, status, logs and vars in a Project folder refuse without --service, exit 2, and act on the one --service names; an app folder's own link still wins", async () => {
      const seeded = await seededProject();
      const repo = emptyFolder('monorepo');
      try {
        expect(
          (await runCli(wholeProject, { home, cwd: repo, env: seeded.env }))
            .code,
        ).toBe(0);
        const app = join(repo, 'apps', 'api');
        mkdirSync(app, { recursive: true });

        for (const command of [['status'], ['logs'], ['vars', 'list']]) {
          const refused = await runCli(command, {
            home,
            cwd: app,
            env: { CLOUDGATE_KEY: seeded.key },
          });
          expect(refused.code).toBe(2);
          expect(refused.stderr).toContain(
            'Error: no Service. Pass --service or set CLOUDGATE_SERVICE.',
          );
        }

        const named = await runCli(
          ['status', '--service', seeded.configName, '--json'],
          { home, cwd: app, env: { CLOUDGATE_KEY: seeded.key } },
        );
        expect(named.stderr).not.toContain('Error');
        expect(named.code).toBe(0);
        expect(
          (JSON.parse(named.stdout) as { service: { configName: string } })
            .service.configName,
        ).toBe(seeded.configName);

        // The app folder linked to its Service: the nearest link wins.
        expect(
          (
            await runCli(
              [
                'link',
                '--project',
                'shop',
                '--env',
                'staging',
                '--service',
                seeded.configName,
              ],
              { home, cwd: app, env: seeded.env },
            )
          ).code,
        ).toBe(0);
        const fromApp = await runCli(['status', '--json'], {
          home,
          cwd: app,
          env: { CLOUDGATE_KEY: seeded.key },
        });
        expect(fromApp.code).toBe(0);
        expect(
          (JSON.parse(fromApp.stdout) as { service: { configName: string } })
            .service.configName,
        ).toBe(seeded.configName);
      } finally {
        removeFolder(repo);
      }
    });

    it('config pull replaces the copy and the recorded version; with no terminal an edited copy is refused, exit 2, unless --yes', async () => {
      const seeded = await seededProject();
      const repo = emptyFolder('monorepo');
      try {
        expect(
          (await runCli(wholeProject, { home, cwd: repo, env: seeded.env }))
            .code,
        ).toBe(0);
        const downloaded = await configOf(seeded);
        // A teammate's change in the console moves the config on.
        const changed = `version: 1\nservices:\n  ${seeded.configName}:\n    kind: web\n`;
        await ctx.db
          .update(schema.projectConfigLocation)
          .set({ text: changed, version: downloaded.version + 1 })
          .where(eq(schema.projectConfigLocation.projectId, seeded.projectId));
        const linkFile = join(repo, '.cloudgate', 'link.json');
        const recorded = () =>
          (
            JSON.parse(readFileSync(linkFile, 'utf8')) as {
              workingCopy: { version: number };
            }
          ).workingCopy.version;

        const pulled = await runCli(['config', 'pull'], {
          home,
          cwd: repo,
          env: { CLOUDGATE_KEY: seeded.key },
        });
        expect(pulled.stderr).not.toContain('Error');
        expect(pulled.code).toBe(0);
        expect(readFileSync(join(repo, 'cloudgate.yaml'), 'utf8')).toBe(
          changed,
        );
        expect(recorded()).toBe(downloaded.version + 1);

        appendFileSync(join(repo, 'cloudgate.yaml'), '# my edit\n');
        await ctx.db
          .update(schema.projectConfigLocation)
          .set({
            text: 'version: 1\nservices: {}\n',
            version: downloaded.version + 2,
          })
          .where(eq(schema.projectConfigLocation.projectId, seeded.projectId));

        const refused = await runCli(['config', 'pull'], {
          home,
          cwd: repo,
          env: { CLOUDGATE_KEY: seeded.key },
        });
        expect(refused.code).toBe(2);
        expect(refused.stderr).toContain(
          'Error: cloudgate.yaml has edits not sent to Cloudgate',
        );
        expect(refused.stderr).toContain('Pass --yes');
        expect(readFileSync(join(repo, 'cloudgate.yaml'), 'utf8')).toBe(
          `${changed}# my edit\n`,
        );
        expect(recorded()).toBe(downloaded.version + 1);

        const forced = await runCli(['config', 'pull', '--yes'], {
          home,
          cwd: repo,
          env: { CLOUDGATE_KEY: seeded.key },
        });
        expect(forced.code).toBe(0);
        expect(readFileSync(join(repo, 'cloudgate.yaml'), 'utf8')).toBe(
          'version: 1\nservices: {}\n',
        );
        expect(recorded()).toBe(downloaded.version + 2);
      } finally {
        removeFolder(repo);
      }
    });

    it('refuses a Project whose config is kept in a repository, naming it, and writes nothing', async () => {
      const seeded = await seededProject();
      await ctx.db
        .update(schema.projectConfigLocation)
        .set({
          kind: 'repository',
          text: null,
          repository: 'octabyte-io/shop-config',
          path: 'deploy/cloudgate.yaml',
        })
        .where(eq(schema.projectConfigLocation.projectId, seeded.projectId));
      const repo = emptyFolder('monorepo');
      try {
        const refused = await runCli(wholeProject, {
          home,
          cwd: repo,
          env: seeded.env,
        });

        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain(
          "Error: Project shop's config is kept in the repository octabyte-io/shop-config at deploy/cloudgate.yaml",
        );
        expect(refused.stderr).toContain('Move into Cloudgate');
        expect(filesUnder(repo)).toEqual([]);
      } finally {
        removeFolder(repo);
      }
    });

    describe('config plan', () => {
      /** The Environment's plans, newest last, as Cloudgate records them. */
      const plansIn = (environmentId: string) =>
        ctx.db
          .select({
            status: schema.plan.status,
            steps: schema.plan.steps,
          })
          .from(schema.plan)
          .where(eq(schema.plan.environmentId, environmentId))
          .orderBy(schema.plan.createdAt);

      /** The copy with `command: node server.js` given to `configName`. */
      const withCommand = (text: string, configName: string) => {
        const entry = `  ${configName}:\n    kind: web\n`;
        expect(text).toContain(entry);
        return text.replace(entry, `${entry}    command: node server.js\n`);
      };

      const recordedVersion = (repo: string) =>
        (
          JSON.parse(
            readFileSync(join(repo, '.cloudgate', 'link.json'), 'utf8'),
          ) as { workingCopy: { version: number } }
        ).workingCopy.version;

      it("prints each Environment's plan and, with no terminal and no --yes, refuses with exit 2 and applies nothing", async () => {
        const seeded = await seededProject();
        const production = await ctx.app
          .get(EnvironmentsService)
          .create(seeded.ownerCtx, {
            name: 'production',
            projectId: seeded.projectId,
          });
        const repo = emptyFolder('monorepo');
        try {
          expect(
            (await runCli(wholeProject, { home, cwd: repo, env: seeded.env }))
              .code,
          ).toBe(0);
          const copy = join(repo, 'cloudgate.yaml');
          writeFileSync(
            copy,
            withCommand(readFileSync(copy, 'utf8'), seeded.configName),
          );

          const refused = await runCli(['config', 'plan'], {
            home,
            cwd: repo,
            env: { CLOUDGATE_KEY: seeded.key },
          });

          expect(refused.code).toBe(2);
          expect(refused.stdout).toContain(
            `staging: 0 to create, 1 to change, 0 to destroy\n  ~ ${seeded.configName} (web) change command\n`,
          );
          expect(refused.stdout).toContain(
            `production: 1 to create, 0 to change, 0 to destroy\n  + ${seeded.configName} (web) create\n`,
          );
          expect(refused.stderr).toContain(
            'Error: nothing was applied: applying the plan needs a yes',
          );
          expect(refused.stderr).toContain('Pass --yes');
          for (const environmentId of [
            seeded.environmentId,
            production.environmentId,
          ]) {
            // The plan this run made is still open, waiting for an Apply.
            expect((await plansIn(environmentId)).at(-1)?.status).toBe('open');
          }
          const [inProduction] = await ctx.db
            .select({ id: schema.application.applicationId })
            .from(schema.application)
            .where(
              eq(schema.application.environmentId, production.environmentId),
            );
          expect(inProduction).toBeUndefined();
        } finally {
          removeFolder(repo);
        }
      });

      it('with --yes applies a plan that destroys nothing, starting no build for a Service it does not touch; the recorded version is the new one, and a second run says nothing changed', async () => {
        const seeded = await seededProject();
        const untouched = await ctx.app
          .get(ApplicationsService)
          .create(seeded.ownerCtx, {
            name: 'Shop Admin',
            appName: 'shop-admin',
            environmentId: seeded.environmentId,
          });
        const repo = emptyFolder('monorepo');
        try {
          expect(
            (await runCli(wholeProject, { home, cwd: repo, env: seeded.env }))
              .code,
          ).toBe(0);
          const copy = join(repo, 'cloudgate.yaml');
          const edited = withCommand(
            readFileSync(copy, 'utf8'),
            seeded.configName,
          );
          writeFileSync(copy, edited);

          const applied = await runCli(['config', 'plan', '--yes'], {
            home,
            cwd: repo,
            env: { CLOUDGATE_KEY: seeded.key },
          });

          expect(applied.stderr).not.toContain('Error');
          expect(applied.code).toBe(0);
          expect(applied.stdout).toContain(
            `  ~ ${seeded.configName} (web) change command\n`,
          );
          expect(applied.stderr).toContain('✓ Applied the plan in staging');
          const kept = await configOf(seeded);
          expect(kept.text).toBe(edited);
          expect(recordedVersion(repo)).toBe(kept.version);
          expect(readFileSync(copy, 'utf8')).toBe(edited);
          expect(
            await ctx.db
              .select({ id: schema.deployment.deploymentId })
              .from(schema.deployment)
              .where(
                eq(schema.deployment.applicationId, untouched.applicationId),
              ),
          ).toEqual([]);

          const again = await runCli(['config', 'plan', '--yes'], {
            home,
            cwd: repo,
            env: { CLOUDGATE_KEY: seeded.key },
          });

          expect(again.stderr).not.toContain('Error');
          expect(again.code).toBe(0);
          expect(again.stdout).toBe('staging: no changes\n');
          expect(again.stderr).toContain('Nothing to change.');
        } finally {
          removeFolder(repo);
        }
      });

      it('with --yes refuses a plan that destroys a Service, naming it, exit 2, and applies nothing', async () => {
        const seeded = await seededProject();
        const repo = emptyFolder('monorepo');
        try {
          expect(
            (await runCli(wholeProject, { home, cwd: repo, env: seeded.env }))
              .code,
          ).toBe(0);
          const before = await configOf(seeded);
          writeFileSync(
            join(repo, 'cloudgate.yaml'),
            'version: 1\nservices: {}\n',
          );

          const refused = await runCli(['config', 'plan', '--yes'], {
            home,
            cwd: repo,
            env: { CLOUDGATE_KEY: seeded.key },
          });

          expect(refused.code).toBe(2);
          expect(refused.stdout).toContain(
            `  - ${seeded.configName} (web) destroy\n`,
          );
          expect(refused.stderr).toContain(
            `Error: the plan destroys ${seeded.configName} in staging, which --yes alone never does; nothing was applied`,
          );
          const [still] = await ctx.db
            .select({ configName: schema.application.configName })
            .from(schema.application)
            .where(eq(schema.application.environmentId, seeded.environmentId));
          expect(still?.configName).toBe(seeded.configName);
          expect(await configOf(seeded)).toEqual(before);
          expect(recordedVersion(repo)).toBe(before.version);
        } finally {
          removeFolder(repo);
        }
      });

      it('refuses a copy downloaded before the config last changed, pointing to config pull, exit 1, and sends nothing', async () => {
        const seeded = await seededProject();
        const repo = emptyFolder('monorepo');
        try {
          expect(
            (await runCli(wholeProject, { home, cwd: repo, env: seeded.env }))
              .code,
          ).toBe(0);
          const downloaded = await configOf(seeded);
          const copy = join(repo, 'cloudgate.yaml');
          writeFileSync(
            copy,
            withCommand(readFileSync(copy, 'utf8'), seeded.configName),
          );
          // A teammate's change in the console moves the config on.
          await ctx.db
            .update(schema.projectConfigLocation)
            .set({ version: downloaded.version + 1 })
            .where(
              eq(schema.projectConfigLocation.projectId, seeded.projectId),
            );
          const plansBefore = await plansIn(seeded.environmentId);

          const refused = await runCli(['config', 'plan', '--yes'], {
            home,
            cwd: repo,
            env: { CLOUDGATE_KEY: seeded.key },
          });

          expect(refused.code).toBe(1);
          expect(refused.stdout).toBe('');
          expect(refused.stderr).toContain(
            `Error: cloudgate.yaml is version ${downloaded.version} of the Project config, which has changed in Cloudgate since; nothing was sent`,
          );
          expect(refused.stderr).toContain('cloudgate config pull');
          expect(await plansIn(seeded.environmentId)).toEqual(plansBefore);
        } finally {
          removeFolder(repo);
        }
      });
    });
  });

  describe('status with CLOUDGATE_KEY', () => {
    /**
     * The owner's key and an uploaded Application that is stopped, whose last
     * Deployment failed, holding a variable value the CLI must never print.
     * Beside it a second Service, for the Member entitled to that one alone.
     */
    async function stoppedUploadedService() {
      const { cookie, key } = await ownerWithKey();
      const me = await request(server).get('/users/me').set('x-api-key', key);
      const userId = (me.body as { id: string }).id;
      const organizations = await request(server)
        .get('/organizations')
        .set('x-api-key', key);
      const organizationId = (organizations.body as { id: string }[])[0].id;
      const ownerCtx = {
        user: { id: userId },
        session: { activeOrganizationId: organizationId },
      };
      const project = await ctx.app
        .get(ProjectsService)
        .create(ownerCtx, { name: 'shop' });
      const staging = await ctx.app.get(EnvironmentsService).create(ownerCtx, {
        name: 'staging',
        projectId: project.projectId,
      });
      const applications = ctx.app.get(ApplicationsService);
      const api = await applications.create(ownerCtx, {
        name: 'Shop API',
        appName: 'shop-api',
        environmentId: staging.environmentId,
      });
      const worker = await applications.create(ownerCtx, {
        name: 'Shop Worker',
        appName: 'shop-worker',
        environmentId: staging.environmentId,
      });
      await ctx.db
        .update(schema.application)
        .set({
          sourceType: 'drop',
          applicationStatus: 'stopped',
          env: 'STRIPE_KEY=sk_live_status_e2e',
        })
        .where(eq(schema.application.applicationId, api.applicationId));
      const [failed] = await ctx.db
        .insert(schema.deployment)
        .values({
          title: 'Upload',
          status: 'error',
          logPath: '/tmp/status-e2e.log',
          applicationId: api.applicationId,
        })
        .returning();
      const configNameOf = async (applicationId: string) => {
        const [row] = await ctx.db
          .select({ configName: schema.application.configName })
          .from(schema.application)
          .where(eq(schema.application.applicationId, applicationId));
        return row.configName;
      };
      return {
        cookie,
        key,
        organizationId,
        projectId: project.projectId,
        environmentId: staging.environmentId,
        apiId: api.applicationId,
        apiConfigName: await configNameOf(api.applicationId),
        workerId: worker.applicationId,
        workerConfigName: await configNameOf(worker.applicationId),
        failedDeploymentId: failed.deploymentId,
      };
    }

    async function linkFolder(repo: string, key: string, configName: string) {
      const linked = await runCli(
        [
          'link',
          '--project',
          'shop',
          '--env',
          'staging',
          '--service',
          configName,
        ],
        {
          home,
          cwd: repo,
          env: { CLOUDGATE_KEY: key, CLOUDGATE_INSTANCE: instance },
        },
      );
      expect(linked.code).toBe(0);
    }

    it('in a linked folder, --json shows the Service, its kind, Environment, Project, Instance and source, and a stopped Service whose Deployment failed exits 0', async () => {
      const seeded = await stoppedUploadedService();
      const repo = emptyFolder('repo');
      try {
        await linkFolder(repo, seeded.key, seeded.apiConfigName);
        const sub = join(repo, 'src');
        mkdirSync(sub);

        const result = await runCli(['status', '--json'], {
          home,
          cwd: sub,
          env: { CLOUDGATE_KEY: seeded.key },
        });

        expect(result.code).toBe(0);
        expect(result.stderr).toContain(`Using instance ${instance}`);
        expect(JSON.parse(result.stdout)).toEqual({
          instance,
          organization: {
            id: seeded.organizationId,
            name: expect.any(String) as string,
          },
          project: { id: seeded.projectId, name: 'shop' },
          environment: { id: seeded.environmentId, name: 'staging' },
          service: {
            id: seeded.apiId,
            configName: seeded.apiConfigName,
            name: 'Shop API',
            kind: 'application',
          },
          state: 'stopped',
          source: { type: 'uploaded' },
          domains: [],
          latestDeployment: {
            id: seeded.failedDeploymentId,
            status: 'error',
            createdAt: expect.any(String) as string,
          },
        });

        const text = await runCli(['status'], {
          home,
          cwd: sub,
          env: { CLOUDGATE_KEY: seeded.key },
        });
        expect(text.code).toBe(0);
        expect(text.stdout).toContain(
          `Service      ${seeded.apiConfigName} (Application)\n`,
        );
        expect(text.stdout).toContain('State        stopped\n');
        expect(text.stdout).toContain('Source       uploaded files\n');
        expect(text.stdout).toContain(
          `Latest       Deployment ${seeded.failedDeploymentId}  error  just now\n`,
        );
        // The Application's variable values never reach the terminal.
        for (const output of [result, text]) {
          expect(output.stdout + output.stderr).not.toContain('sk_live');
        }
      } finally {
        removeFolder(repo);
      }
    });

    it('refuses a Service the key cannot read with the shared error and hint, and exit 1', async () => {
      const seeded = await stoppedUploadedService();
      const repo = emptyFolder('repo');
      try {
        await linkFolder(repo, seeded.key, seeded.apiConfigName);
        // A Member entitled to the worker alone, with a key of their own.
        const invitee = await signUpMember(server, seeded.cookie, {
          email: 'ida@shop.example',
        });
        const [memberRow] = await ctx.db
          .select()
          .from(schema.member)
          .where(eq(schema.member.userId, invitee.id));
        await ctx.app
          .get(PermissionService)
          .setMemberEntitlements(seeded.organizationId, memberRow.id, {
            accessedProjects: [seeded.projectId],
            accessedEnvironments: [seeded.environmentId],
            accessedServices: [seeded.workerId],
          });
        const minted = await request(server)
          .post('/users/me/api-keys')
          .set('Cookie', invitee.cookie)
          .send({ name: 'ci', expiresIn: NINETY_DAYS });
        expect(minted.status).toBe(201);

        const result = await runCli(['status', '--json'], {
          home,
          cwd: repo,
          env: { CLOUDGATE_KEY: (minted.body as { key: string }).key },
        });

        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain(
          `Error: no Service with Config name "${seeded.apiConfigName}" in Environment staging of Project shop\nIts Services: ${seeded.workerConfigName}.\n`,
        );
      } finally {
        removeFolder(repo);
      }
    });
  });

  describe('vars with CLOUDGATE_KEY', () => {
    /**
     * The owner's key and a Service in their default Organization holding
     * one variable of its own and one name wired to an Output, as a
     * Project config's link leaves it (ADR-0031).
     */
    async function serviceWithVariables() {
      const { key } = await ownerWithKey();
      const me = await request(server).get('/users/me').set('x-api-key', key);
      const userId = (me.body as { id: string }).id;
      const orgs = await request(server)
        .get('/organizations')
        .set('x-api-key', key);
      const organizationId = (orgs.body as { id: string }[])[0].id;
      const ownerCtx = {
        user: { id: userId },
        session: { activeOrganizationId: organizationId },
      };
      const project = await ctx.app
        .get(ProjectsService)
        .create(ownerCtx, { name: 'shop' });
      const staging = await ctx.app.get(EnvironmentsService).create(ownerCtx, {
        name: 'staging',
        projectId: project.projectId,
      });
      const created = await ctx.app.get(ApplicationsService).create(ownerCtx, {
        name: 'Shop API',
        appName: 'shop-api',
        environmentId: staging.environmentId,
      });
      await ctx.db
        .update(schema.application)
        .set({
          env: 'KEEP=kept-value-0417\n',
          configLinks: { DATABASE_URL: { source: 'db', output: 'url' } },
        })
        .where(eq(schema.application.applicationId, created.applicationId));
      const [row] = await ctx.db
        .select({ configName: schema.application.configName })
        .from(schema.application)
        .where(eq(schema.application.applicationId, created.applicationId));
      return {
        applicationId: created.applicationId,
        env: {
          CLOUDGATE_KEY: key,
          CLOUDGATE_INSTANCE: instance,
          CLOUDGATE_ORG: organizationId,
          CLOUDGATE_PROJECT: 'shop',
          CLOUDGATE_ENV: 'staging',
          CLOUDGATE_SERVICE: row.configName,
        },
      };
    }

    it('sets, lists and unsets named keys, leaving the others, and never prints a value', async () => {
      const seeded = await serviceWithVariables();
      const values = [
        'kept-value-0417',
        'set-value-a-7781',
        'piped-value-b-3390',
      ];
      const runs: { stdout: string; stderr: string }[] = [];
      const vars = async (args: string[], stdin?: string) => {
        const result = await runCli(['vars', ...args], {
          home,
          env: seeded.env,
          ...(stdin === undefined ? {} : { stdin }),
        });
        runs.push(result);
        return result;
      };
      const stored = async () => {
        const [row] = await ctx.db
          .select({ env: schema.application.env })
          .from(schema.application)
          .where(eq(schema.application.applicationId, seeded.applicationId));
        return parse(row.env ?? '');
      };
      const listed = async () => {
        const result = await vars(['list', '--json']);
        expect(result.code).toBe(0);
        return JSON.parse(result.stdout) as unknown;
      };

      const set = await vars(['set', 'A=set-value-a-7781']);
      expect(set.code).toBe(0);
      expect(set.stdout).toBe('');
      expect(set.stderr).toContain('Run cloudgate deploy to pick it up.');
      expect(await listed()).toEqual([
        { name: 'A', linkedTo: null },
        { name: 'DATABASE_URL', linkedTo: 'db.url' },
        { name: 'KEEP', linkedTo: null },
      ]);

      // printf piped-value-b-3390 | cloudgate vars set B
      const piped = await vars(['set', 'B'], 'piped-value-b-3390');
      expect(piped.code).toBe(0);
      expect(await stored()).toEqual({
        KEEP: 'kept-value-0417',
        A: 'set-value-a-7781',
        B: 'piped-value-b-3390',
      });

      const refused = await vars(['set', 'DATABASE_URL=postgres://typed']);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain(
        'Error: DATABASE_URL is linked to db.url',
      );
      expect(refused.stdout).toBe('');

      const unset = await vars(['unset', 'A']);
      expect(unset.code).toBe(0);
      expect(await listed()).toEqual([
        { name: 'B', linkedTo: null },
        { name: 'DATABASE_URL', linkedTo: 'db.url' },
        { name: 'KEEP', linkedTo: null },
      ]);
      expect(await stored()).toEqual({
        KEEP: 'kept-value-0417',
        B: 'piped-value-b-3390',
      });

      const table = await vars(['list']);
      expect(table.code).toBe(0);
      expect(table.stdout).toMatch(/^B +set$/m);
      expect(table.stdout).toMatch(/^DATABASE_URL +linked to db\.url$/m);

      for (const run of runs) {
        for (const value of values) {
          expect(run.stdout).not.toContain(value);
          expect(run.stderr).not.toContain(value);
        }
      }
      expect(filesUnder(home)).toEqual([]);
    });
  });

  describe('deploy with CLOUDGATE_KEY', () => {
    /**
     * The owner, a key, and the same Service (one display name, so one
     * Config name) in staging and qa of Project shop, in the owner's default
     * Organization. Both Applications are new: no source yet.
     */
    async function seededService() {
      const { cookie, key } = await ownerWithKey();
      const me = await request(server).get('/users/me').set('x-api-key', key);
      const userId = (me.body as { id: string }).id;
      const organizations = await request(server)
        .get('/organizations')
        .set('Cookie', cookie);
      const [organization] = organizations.body as {
        id: string;
        name: string;
      }[];
      const ownerCtx = {
        user: { id: userId },
        session: { activeOrganizationId: organization.id },
      };
      const project = await ctx.app
        .get(ProjectsService)
        .create(ownerCtx, { name: 'shop' });
      const environments = ctx.app.get(EnvironmentsService);
      const applications = ctx.app.get(ApplicationsService);
      const seeded = {} as Record<
        'staging' | 'qa',
        { environmentId: string; applicationId: string; appName: string }
      >;
      for (const name of ['staging', 'qa'] as const) {
        const environment = await environments.create(ownerCtx, {
          name,
          projectId: project.projectId,
        });
        const application = await applications.create(ownerCtx, {
          name: 'Shop API',
          appName: `shop-api-${name}`,
          environmentId: environment.environmentId,
        });
        const [row] = await ctx.db
          .select({ appName: schema.application.appName })
          .from(schema.application)
          .where(
            eq(schema.application.applicationId, application.applicationId),
          );
        seeded[name] = {
          environmentId: environment.environmentId,
          applicationId: application.applicationId,
          appName: row.appName,
        };
      }
      const configNames = await ctx.db
        .select({ configName: schema.application.configName })
        .from(schema.application);
      const [{ configName }] = configNames;
      expect(configNames).toEqual([{ configName }, { configName }]);
      return {
        cookie,
        key,
        organization,
        projectId: project.projectId,
        configName,
        ...seeded,
      };
    }

    /** The Deployments of an Application, as the Instance holds them. */
    async function deploymentsOf(applicationId: string) {
      return ctx.db
        .select({
          deploymentId: schema.deployment.deploymentId,
          status: schema.deployment.status,
        })
        .from(schema.deployment)
        .where(eq(schema.deployment.applicationId, applicationId));
    }

    /** Where an upload lands for an Application on the platform host. */
    const codeOf = (appName: string) =>
      join(cloudgateDirectoryOn(null), 'applications', appName, 'code');

    /** A folder with a bit of everything an upload leaves out or keeps. */
    function projectFolder(repo: string): void {
      const files: Record<string, string | Buffer> = {
        'package.json': '{"name":"shop-api"}\n',
        'index.js': 'console.log("shop");\n',
        'src/routes/orders.js': 'module.exports = {};\n',
        // Incompressible and over 96 KiB, so its base64 alone passes the
        // 128 KiB one argument used to be capped at.
        'assets/blob.bin': randomBytes(150 * 1024),
        '.gitignore': 'node_modules\n*.log\n',
        '.cloudgateignore': 'tests/\n!keep.log\n',
        'node_modules/left-pad/index.js': '',
        'debug.log': 'left out',
        'keep.log': 'brought back',
        'tests/orders.test.js': '',
        '.env': 'STRIPE_KEY=sk_live_secret\n',
        '.env.example': 'STRIPE_KEY=\n',
        '.git/HEAD': 'ref: refs/heads/main\n',
      };
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(repo, path, '..'), { recursive: true });
        writeFileSync(join(repo, path), content);
      }
      symlinkSync(join(repo, 'index.js'), join(repo, 'main.js'));
    }

    const linkArgs = (configName: string) => [
      'link',
      '--project',
      'shop',
      '--env',
      'staging',
      '--service',
      configName,
    ];

    it('links, then deploys the folder from a subfolder: the upload leaves out what it should, and the Deployment ends done with exit 0', async () => {
      const seeded = await seededService();
      const repo = emptyFolder('repo');
      try {
        projectFolder(repo);
        const linked = await runCli(linkArgs(seeded.configName), {
          home,
          cwd: repo,
          env: { CLOUDGATE_KEY: seeded.key, CLOUDGATE_INSTANCE: instance },
        });
        expect(linked.code).toBe(0);

        const deployed = await runCli(['deploy'], {
          home,
          cwd: join(repo, 'src', 'routes'),
          env: { CLOUDGATE_KEY: seeded.key },
        });

        expect(deployed.stderr).toContain(
          `Deploying ../../ to ${seeded.configName} in staging of Project shop on ${instance.replace('http://', '')}\n`,
        );
        expect(deployed.code).toBe(0);
        expect(deployed.stderr).toContain(
          'Left out .env. Use cloudgate vars set for secrets.\n',
        );
        expect(deployed.stderr).toContain(
          'Warning: left out main.js, a symlink; an upload keeps no symlinks.\n',
        );
        // A new Application's build host holds nothing, so all 8 are sent;
        // `assets/blob.bin` is 150 KiB that no zip can shrink.
        expect(deployed.stderr).toMatch(
          /Uploading 8 changed files, 15\d\.\d kB \(0 unchanged\)…\n/,
        );
        const [recorded] = await deploymentsOf(seeded.staging.applicationId);
        expect(recorded.status).toBe('done');
        expect(deployed.stderr).toContain(
          `Deployment ${recorded.deploymentId} queued\n`,
        );
        expect(deployed.stderr).toMatch(
          new RegExp(`✓ Deployment ${recorded.deploymentId} done in \\d+s\\n`),
        );
        // The Deployment log, followed on stdout.
        expect(deployed.stdout).toContain(
          '[build] built by the harness builder',
        );
        // The tree the Instance holds: the folder holding the link, whole,
        // less what is left out.
        expect(filesUnder(codeOf(seeded.staging.appName)).sort()).toEqual(
          [
            '.cloudgateignore',
            '.env.example',
            '.gitignore',
            'assets',
            'assets/blob.bin',
            'index.js',
            'keep.log',
            'package.json',
            'src',
            'src/routes',
            'src/routes/orders.js',
          ].sort(),
        );
        expect(
          readFileSync(join(codeOf(seeded.staging.appName), 'assets/blob.bin')),
        ).toEqual(readFileSync(join(repo, 'assets/blob.bin')));
      } finally {
        removeFolder(repo);
      }
    });

    it('deploys again sending only the changed file, and a file deleted locally is gone from the build host', async () => {
      const seeded = await seededService();
      const repo = emptyFolder('repo');
      try {
        projectFolder(repo);
        const env = {
          CLOUDGATE_KEY: seeded.key,
          CLOUDGATE_INSTANCE: instance,
        };
        const linked = await runCli(linkArgs(seeded.configName), {
          home,
          cwd: repo,
          env,
        });
        expect(linked.code).toBe(0);
        const first = await runCli(['deploy'], { home, cwd: repo, env });
        expect(first.code).toBe(0);

        writeFileSync(join(repo, 'index.js'), 'console.log("shop v2");\n');
        rmSync(join(repo, 'keep.log'));
        const again = await runCli(['deploy'], { home, cwd: repo, env });

        expect(again.code).toBe(0);
        // Of the 7 files kept, 6 are as the build host holds them, and
        // keep.log is gone. The size is the zip sent, not the file's 24
        // bytes: the zip's fixed 98 bytes of headers (30 local, 46 central,
        // 22 end), the name `index.js` twice, and the deflated contents.
        const sent =
          98 +
          2 * 'index.js'.length +
          deflateRawSync('console.log("shop v2");\n').length;
        expect(again.stderr).toContain(
          `Uploading 1 changed file, ${sent} B (6 unchanged, 1 deleted)…\n`,
        );
        const code = codeOf(seeded.staging.appName);
        expect(filesUnder(code)).not.toContain('keep.log');
        expect(readFileSync(join(code, 'index.js'), 'utf8')).toBe(
          'console.log("shop v2");\n',
        );
        expect(readFileSync(join(code, 'assets/blob.bin'))).toEqual(
          readFileSync(join(repo, 'assets/blob.bin')),
        );
        const deployments = await deploymentsOf(seeded.staging.applicationId);
        expect(deployments.map((row) => row.status)).toEqual(['done', 'done']);
      } finally {
        removeFolder(repo);
      }
    });

    it('after a deploy, logs --deployment prints that Deployment log and exits 0', async () => {
      const seeded = await seededService();
      const repo = emptyFolder('repo');
      try {
        writeFileSync(join(repo, 'index.js'), '1');
        const linked = await runCli(linkArgs(seeded.configName), {
          home,
          cwd: repo,
          env: { CLOUDGATE_KEY: seeded.key, CLOUDGATE_INSTANCE: instance },
        });
        expect(linked.code).toBe(0);
        const deployed = await runCli(['deploy'], {
          home,
          cwd: repo,
          env: { CLOUDGATE_KEY: seeded.key },
        });
        expect(deployed.code).toBe(0);

        const read = await runCli(['logs', '--deployment'], {
          home,
          cwd: repo,
          env: { CLOUDGATE_KEY: seeded.key },
        });

        expect(read.code).toBe(0);
        expect(read.stdout).toContain('[build] built by the harness builder\n');
        // The log and nothing else on stdout.
        expect(read.stdout).not.toContain('Using instance');
      } finally {
        removeFolder(repo);
      }
    });

    it('exits 1 when the build fails', async () => {
      const seeded = await seededService();
      const repo = emptyFolder('repo');
      try {
        writeFileSync(join(repo, 'index.js'), '1');
        nextBuild = 'fail';

        const deployed = await runCli(
          ['deploy', ...linkArgs(seeded.configName).slice(1)],
          {
            home,
            cwd: repo,
            env: { CLOUDGATE_KEY: seeded.key, CLOUDGATE_INSTANCE: instance },
          },
        );

        const [recorded] = await deploymentsOf(seeded.staging.applicationId);
        expect(recorded.status).toBe('error');
        expect(deployed.code).toBe(1);
        expect(deployed.stderr).toContain(
          `Error: Deployment ${recorded.deploymentId} failed`,
        );
      } finally {
        removeFolder(repo);
      }
    });

    it('with --env and --detach --json, deploys the same Config name in that Environment and exits 0 once queued', async () => {
      const seeded = await seededService();
      const repo = emptyFolder('repo');
      try {
        writeFileSync(join(repo, 'index.js'), '1');
        const linked = await runCli(linkArgs(seeded.configName), {
          home,
          cwd: repo,
          env: { CLOUDGATE_KEY: seeded.key, CLOUDGATE_INSTANCE: instance },
        });
        expect(linked.code).toBe(0);

        const detached = await runCli(
          ['deploy', '--env', 'qa', '--detach', '--json'],
          { home, cwd: repo, env: { CLOUDGATE_KEY: seeded.key } },
        );

        expect(detached.code).toBe(0);
        const [queued] = await deploymentsOf(seeded.qa.applicationId);
        expect(JSON.parse(detached.stdout)).toEqual({
          deploymentId: queued.deploymentId,
          status: 'pending',
          consoleUrl: `${instance}/applications/${seeded.qa.applicationId}/deployments`,
        });
        expect(detached.stderr).toContain(
          `Deploying ./ to ${seeded.configName} in qa of Project shop`,
        );
        // Nothing went to the linked Environment.
        expect(await deploymentsOf(seeded.staging.applicationId)).toEqual([]);
      } finally {
        removeFolder(repo);
      }
    });

    it('gives a member whose role cannot deploy the shared 403 error and hint, exit 1', async () => {
      const seeded = await seededService();
      const member = await signUpMember(server, seeded.cookie, {
        email: 'ida@shop.example',
      });
      // A licensed custom role that may read and change the Service, and
      // read its Deployments, but not start one.
      await ctx.db.insert(schema.licenseKey).values({
        organizationId: seeded.organization.id,
        key: 'test-license-key',
        status: 'active',
        enableEnterpriseFeatures: true,
      });
      await ctx.db.insert(schema.organizationRole).values({
        organizationId: seeded.organization.id,
        role: 'reviewer',
        permission: {
          project: ['read'],
          environment: ['read'],
          service: ['read', 'update'],
          deployment: ['read'],
        },
      });
      await ctx.db
        .update(schema.member)
        .set({
          role: 'reviewer',
          accessedProjects: [seeded.projectId],
          accessedEnvironments: [seeded.staging.environmentId],
          accessedServices: [seeded.staging.applicationId],
        })
        .where(eq(schema.member.userId, member.id));
      const minted = await request(server)
        .post('/users/me/api-keys')
        .set('Cookie', member.cookie)
        .send({ name: 'ci' });
      expect(minted.status).toBe(201);
      const repo = emptyFolder('repo');
      try {
        writeFileSync(join(repo, 'index.js'), '1');

        const refused = await runCli(
          [
            'deploy',
            '--org',
            seeded.organization.id,
            ...linkArgs(seeded.configName).slice(1),
          ],
          {
            home,
            cwd: repo,
            env: {
              CLOUDGATE_KEY: (minted.body as { key: string }).key,
              CLOUDGATE_INSTANCE: instance,
            },
          },
        );

        expect(refused.stderr).toMatch(/\nError: .+\n/);
        expect(refused.stderr).toContain(
          `Ask an owner of ${seeded.organization.name} for access.\n`,
        );
        expect(refused.code).toBe(1);
        expect(await deploymentsOf(seeded.staging.applicationId)).toEqual([]);
      } finally {
        removeFolder(repo);
      }
    });

    describe('its guards', () => {
      const env = (key: string) => ({
        CLOUDGATE_KEY: key,
        CLOUDGATE_INSTANCE: instance,
      });
      const deployArgs = (configName: string) => [
        'deploy',
        ...linkArgs(configName).slice(1),
      ];
      const minutesAgo = (minutes: number) =>
        new Date(Date.now() - minutes * 60_000).toISOString();

      /** A Deployment of the Application someone else started, as the Instance holds it. */
      async function buildInProgress(applicationId: string, createdAt: string) {
        const [row] = await ctx.db
          .insert(schema.deployment)
          .values({
            title: 'from the console',
            logPath: join(home, 'console-build.log'),
            applicationId,
            status: 'running',
            createdAt,
            startedAt: createdAt,
          })
          .returning();
        return row.deploymentId;
      }

      const sourceOf = async (applicationId: string) => {
        const [row] = await ctx.db
          .select({ sourceType: schema.application.sourceType })
          .from(schema.application)
          .where(eq(schema.application.applicationId, applicationId));
        return row.sourceType;
      };

      it('waits for a Deployment already running, while an upload from elsewhere gets 409, then deploys once it has finished', async () => {
        const seeded = await seededService();
        const repo = emptyFolder('repo');
        try {
          writeFileSync(join(repo, 'index.js'), '1');
          const running = await buildInProgress(
            seeded.staging.applicationId,
            minutesAgo(2),
          );

          const deploying = startCli(deployArgs(seeded.configName), {
            home,
            cwd: repo,
            env: env(seeded.key),
          });
          await deploying.stderrMatch(
            new RegExp(`waiting for Deployment ${running} to finish\\n`),
          );

          // The console, or a second terminal, uploading meanwhile.
          const meanwhile = await request(server)
            .post(`/applications/${seeded.staging.applicationId}/drop`)
            .set('x-api-key', seeded.key)
            .attach(
              'zip',
              buildZip([{ name: 'index.js', content: 'x\n' }]),
              'b.zip',
            );
          expect(meanwhile.status).toBe(409);
          expect((meanwhile.body as { code: string }).code).toBe(
            'DEPLOYMENT_IN_PROGRESS',
          );
          expect(await sourceOf(seeded.staging.applicationId)).toBe('github');

          await ctx.db
            .update(schema.deployment)
            .set({ status: 'done', finishedAt: new Date().toISOString() })
            .where(eq(schema.deployment.deploymentId, running));
          const deployed = await deploying.done;

          expect(deployed.code).toBe(0);
          const recorded = await deploymentsOf(seeded.staging.applicationId);
          expect(recorded).toHaveLength(2);
          expect(recorded.map((row) => row.status)).toEqual(['done', 'done']);
          expect(await sourceOf(seeded.staging.applicationId)).toBe('drop');
        } finally {
          removeFolder(repo);
        }
      });

      it('goes ahead with a warning past a Deployment running for more than 60 minutes', async () => {
        const seeded = await seededService();
        const repo = emptyFolder('repo');
        try {
          writeFileSync(join(repo, 'index.js'), '1');
          // Its clock faked by its start: it began 75 minutes ago.
          const stuck = await buildInProgress(
            seeded.staging.applicationId,
            minutesAgo(75),
          );

          const deployed = await runCli(
            [...deployArgs(seeded.configName), '--detach'],
            { home, cwd: repo, env: env(seeded.key) },
          );

          expect(deployed.code).toBe(0);
          expect(deployed.stderr).toMatch(
            new RegExp(
              `Warning: Deployment ${stuck} has been running for 1h 1[56]m; deploying without waiting for it\\.\\n`,
            ),
          );
          expect(deployed.stderr).not.toContain('waiting for Deployment');
          expect(await sourceOf(seeded.staging.applicationId)).toBe('drop');
        } finally {
          removeFolder(repo);
        }
      });

      it('refuses a Compose stack and a Database, naming the kind, and uploads nothing', async () => {
        const seeded = await seededService();
        const me = await request(server)
          .get('/users/me')
          .set('x-api-key', seeded.key);
        const ownerCtx = {
          user: { id: (me.body as { id: string }).id },
          session: { activeOrganizationId: seeded.organization.id },
        };
        await ctx.app.get(ComposeService).create(ownerCtx, {
          name: 'Shop Stack',
          appName: 'shop-stack',
          environmentId: seeded.staging.environmentId,
        });
        await ctx.app.get(PostgresService).create(ownerCtx, {
          name: 'Main DB',
          appName: 'main-db',
          databaseName: 'shop',
          databaseUser: 'shop_user',
          databasePassword: 'sup3rS3cret',
          environmentId: seeded.staging.environmentId,
        });
        const configNameOf = async (name: string) => {
          const environment = await request(server)
            .get(`/environments/${seeded.staging.environmentId}`)
            .set('x-api-key', seeded.key);
          return (
            environment.body as {
              services: { name: string; configName: string }[];
            }
          ).services.find((service) => service.name === name)!.configName;
        };
        const repo = emptyFolder('repo');
        try {
          writeFileSync(join(repo, 'index.js'), '1');
          for (const [name, words] of [
            ['Shop Stack', 'a Compose stack'],
            ['Main DB', 'a Postgres database'],
          ]) {
            const configName = await configNameOf(name);
            const refused = await runCli(deployArgs(configName), {
              home,
              cwd: repo,
              env: env(seeded.key),
            });

            expect(refused.code).toBe(1);
            expect(refused.stderr).toContain(
              `Error: ${configName} is ${words}; cloudgate deploy uploads to Applications only\n`,
            );
            expect(refused.stderr).not.toContain('Uploading');
          }
        } finally {
          removeFolder(repo);
        }
      });

      it('refuses a Service whose source the Project config kept in a repository names as a repository, even with --switch-source', async () => {
        const seeded = await seededService();
        // The Project's config moved into a repository, whose file names
        // the Service's source; this box reaches no git provider, so the
        // copy on the Config branch is the one the reader would answer.
        await ctx.db
          .update(schema.projectConfigLocation)
          .set({
            kind: 'repository',
            text: null,
            repository: 'octabyte-io/shop-config',
            path: 'cloudgate.yaml',
          })
          .where(eq(schema.projectConfigLocation.projectId, seeded.projectId));
        const readCopy = jest
          .spyOn(ctx.app.get(ConfigLocations), 'readCopy')
          .mockResolvedValue({
            ok: true,
            text: `version: 1\nservices:\n  ${seeded.configName}:\n    kind: web\n    source:\n      github: octabyte-io/shop\n`,
            commitSha: 'a'.repeat(40),
            branch: 'main',
            fileUrl:
              'https://github.com/octabyte-io/shop-config/blob/main/cloudgate.yaml',
          });
        const repo = emptyFolder('repo');
        try {
          writeFileSync(join(repo, 'index.js'), '1');

          const refused = await runCli(
            [...deployArgs(seeded.configName), '--switch-source'],
            { home, cwd: repo, env: env(seeded.key) },
          );

          expect(refused.code).toBe(1);
          expect(refused.stderr).toContain(
            `Error: the Project config names github octabyte-io/shop as ${seeded.configName}'s source, and it is kept in a repository, so its next plan would undo an upload\n` +
              `List ${seeded.configName} as managed: console in the Project config first, then deploy again.\n`,
          );
          expect(await sourceOf(seeded.staging.applicationId)).toBe('github');
          expect(await deploymentsOf(seeded.staging.applicationId)).toEqual([]);
        } finally {
          readCopy.mockRestore();
          removeFolder(repo);
        }
      });

      it('with no terminal, refuses to switch a git-sourced Service without --switch-source (exit 2), and switches it with, its Cloudgate-kept config entry following', async () => {
        const seeded = await seededService();
        await ctx.db
          .update(schema.application)
          .set({
            sourceType: 'github',
            owner: 'octabyte-io',
            repository: 'shop',
          })
          .where(
            eq(schema.application.applicationId, seeded.staging.applicationId),
          );
        // The Project's own Cloudgate-kept config names it too, as a console
        // Save of that source writes it: the upload rewrites that entry
        // itself, so this is the git source asked about, not refused.
        const stated = `version: 1\nservices:\n  ${seeded.configName}:\n    kind: web\n    source:\n      github: octabyte-io/shop\n`;
        await ctx.db
          .update(schema.projectConfigLocation)
          .set({ text: stated })
          .where(eq(schema.projectConfigLocation.projectId, seeded.projectId));
        const repo = emptyFolder('repo');
        try {
          writeFileSync(join(repo, 'index.js'), '1');

          const refused = await runCli(deployArgs(seeded.configName), {
            home,
            cwd: repo,
            env: env(seeded.key),
          });
          expect(refused.code).toBe(2);
          expect(refused.stderr).toContain(
            `Error: ${seeded.configName} builds from github octabyte-io/shop, and deploying this folder switches it to uploaded files\n` +
              'Pass --switch-source to switch it.\n',
          );
          expect(await sourceOf(seeded.staging.applicationId)).toBe('github');

          const switched = await runCli(
            [...deployArgs(seeded.configName), '--switch-source'],
            { home, cwd: repo, env: env(seeded.key) },
          );
          expect(switched.code).toBe(0);
          expect(await sourceOf(seeded.staging.applicationId)).toBe('drop');
          const [kept] = await ctx.db
            .select({ text: schema.projectConfigLocation.text })
            .from(schema.projectConfigLocation)
            .where(
              eq(schema.projectConfigLocation.projectId, seeded.projectId),
            );
          expect(kept.text).toContain('managed: console');
          expect(kept.text).not.toContain('octabyte-io/shop');
        } finally {
          removeFolder(repo);
        }
      });

      it('in an unlinked folder with no terminal, refuses naming the first missing flag, exit 2', async () => {
        const seeded = await seededService();
        const repo = emptyFolder('repo');
        try {
          writeFileSync(join(repo, 'index.js'), '1');

          const refused = await runCli(['deploy', '--project', 'shop'], {
            home,
            cwd: repo,
            env: env(seeded.key),
          });

          expect(refused.code).toBe(2);
          expect(refused.stderr).toMatch(/Error: .*--env/);
          expect(existsSync(join(repo, '.cloudgate'))).toBe(false);
        } finally {
          removeFolder(repo);
        }
      });
    });
  });

  describe('logs with CLOUDGATE_KEY', () => {
    const TASK = '0a0a0a0a0a0a4a0a8a0a0a0a0a0a0a0a';

    /**
     * The owner's key and one Application, Shop API in staging of Project
     * shop, running on the platform host (a Server of this Instance's own);
     * `inCloudAccount` moves it to a Cloud account, as an Apply does.
     */
    async function runningService(options: { inCloudAccount?: boolean } = {}) {
      const { key } = await ownerWithKey();
      const me = await request(server).get('/users/me').set('x-api-key', key);
      const userId = (me.body as { id: string }).id;
      const organizations = await request(server)
        .get('/organizations')
        .set('x-api-key', key);
      const organizationId = (organizations.body as { id: string }[])[0].id;
      const ownerCtx = {
        user: { id: userId },
        session: { activeOrganizationId: organizationId },
      };
      const project = await ctx.app
        .get(ProjectsService)
        .create(ownerCtx, { name: 'shop' });
      const staging = await ctx.app.get(EnvironmentsService).create(ownerCtx, {
        name: 'staging',
        projectId: project.projectId,
      });
      const api = await ctx.app.get(ApplicationsService).create(ownerCtx, {
        name: 'Shop API',
        appName: 'shop-api',
        environmentId: staging.environmentId,
      });
      const [row] = await ctx.db
        .select({
          appName: schema.application.appName,
          configName: schema.application.configName,
        })
        .from(schema.application)
        .where(eq(schema.application.applicationId, api.applicationId));
      if (options.inCloudAccount) {
        const account = '123456789012';
        const [cloud] = await ctx.db
          .insert(schema.cloudAccount)
          .values({
            organizationId,
            name: 'Production AWS',
            cloud: 'aws',
            cloudId: account,
            accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
            secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
            deployRoleArn: `arn:aws:iam::${account}:role/cloudgate-deploy`,
            taskExecutionRoleArn: `arn:aws:iam::${account}:role/cloudgate-task-execution`,
            externalId: 'external-id-made-by-cloudgate',
            policyVersion: 1,
            lastCheckedAt: new Date().toISOString(),
            lastCheckResult: 'passed',
          })
          .returning();
        await ctx.db
          .update(schema.application)
          .set({
            serverId: null,
            cloudAccountId: cloud.cloudAccountId,
            region: 'eu-central-1',
          })
          .where(eq(schema.application.applicationId, api.applicationId));
      }
      const target = [
        '--project',
        'shop',
        '--env',
        'staging',
        '--service',
        row.configName,
      ];
      return {
        key,
        appName: row.appName,
        applicationId: api.applicationId,
        environmentId: staging.environmentId,
        target,
        env: { CLOUDGATE_KEY: key, CLOUDGATE_INSTANCE: instance },
      };
    }

    const numbered = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);

    it('on a Server, logs -n 20 prints at most 20 Runtime-log lines, though each Swarm task sends 20, and exits 0', async () => {
      const service = await runningService();
      const taskA = numbered('a: GET /orders', 30);
      const taskB = numbered('b: GET /health', 30);
      swarmLogs.set(service.appName, [taskA, taskB]);

      const read = await runCli(['logs', '-n', '20', ...service.target], {
        home,
        env: service.env,
      });

      expect(read.stderr).not.toContain('Error');
      expect(read.code).toBe(0);
      const lines = read.stdout.split('\n').slice(0, -1);
      expect(lines).toEqual(taskB.slice(-20));
    });

    it('on a Server, logs -f keeps printing until Ctrl-C, then exits 130', async () => {
      const service = await runningService();
      swarmLogs.set(service.appName, [numbered('a: GET /orders', 5)]);

      const following = startCli(['logs', '-f', ...service.target], {
        home,
        env: service.env,
      });
      await following.stdoutMatch(/a: GET \/orders 5\n/);
      // Still following: nothing ended it, so only Ctrl-C does.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      following.interrupt();
      const ended = await following.done;

      expect(ended.code).toBe(130);
      expect(ended.stdout).toBe(
        `${numbered('a: GET /orders', 5).join('\n')}\n`,
      );
    });

    it('in a Cloud account, logs -n 20 prints the last 20 Runtime-log lines and exits 0, reading back past the last few minutes for them', async () => {
      const service = await runningService({ inCloudAccount: true });
      const now = Date.now();
      const written = numbered('GET /orders', 30);
      // One a minute over the last half hour: the Instance's opening window
      // of five minutes holds only the last few.
      ctx.cloud.writeLog(
        `/cloudgate/${service.environmentId}/${service.applicationId}`,
        TASK,
        written.map((message, index) => ({
          timestamp: now - 30 * 60_000 + index * 60_000,
          message,
        })),
      );

      const read = await runCli(['logs', '-n', '20', ...service.target], {
        home,
        env: service.env,
      });

      expect(read.stderr).not.toContain('Error');
      expect(read.code).toBe(0);
      const lines = read.stdout.split('\n').slice(0, -1);
      expect(lines).toHaveLength(20);
      expect(lines.map((line) => line.replace(/^\S+ /, ''))).toEqual(
        written.slice(-20),
      );
    });

    it('logs --deployment <id> -f follows a running Deployment and ends by itself when it finishes, though the stream stays open', async () => {
      const service = await runningService();
      const [running] = await ctx.db
        .insert(schema.deployment)
        .values({
          title: 'Upload',
          status: 'running',
          logPath: '/pending',
          applicationId: service.applicationId,
        })
        .returning();
      const logPath = join(
        cloudgateDirectoryOn(null),
        'logs',
        service.appName,
        `${running.deploymentId}.log`,
      );
      mkdirSync(join(logPath, '..'), { recursive: true });
      writeFileSync(logPath, '[build] step 1\n');
      await ctx.db
        .update(schema.deployment)
        .set({ logPath })
        .where(eq(schema.deployment.deploymentId, running.deploymentId));

      const following = startCli(
        ['logs', '--deployment', running.deploymentId, '-f', ...service.target],
        { home, env: service.env },
      );
      await following.stdoutMatch(/\[build\] step 1\n/);
      appendFileSync(logPath, '[build] step 2\n');
      await following.stdoutMatch(/\[build\] step 2\n/);
      await ctx.db
        .update(schema.deployment)
        .set({ status: 'done' })
        .where(eq(schema.deployment.deploymentId, running.deploymentId));
      const ended = await following.done;

      expect(ended.code).toBe(0);
      expect(ended.stdout).toBe('[build] step 1\n[build] step 2\n');
      expect(ended.stderr).toContain(
        `Deployment ${running.deploymentId} done\n`,
      );
    });
  });
});
