import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { Logger as NestLogger } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger as PinoNestLogger, LoggerModule } from 'nestjs-pino';
import type { Options } from 'pino-http';

import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import type { ErrorResponseBody } from '../../src/common/filters/all-exceptions.filter';
import type { BuildProgram } from '../../src/builders/build-strategy';
import { dockerfileStrategy } from '../../src/builders/strategies/dockerfile.strategy';
import { herokuStrategy } from '../../src/builders/strategies/heroku.strategy';
import { nixpacksStrategy } from '../../src/builders/strategies/nixpacks.strategy';
import { paketoStrategy } from '../../src/builders/strategies/paketo.strategy';
import { railpackStrategy } from '../../src/builders/strategies/railpack.strategy';
import { staticStrategy } from '../../src/builders/strategies/static.strategy';
import { loggerConfig } from '../../src/common/logging/logger.config';
import { getCreateFileCommand } from '../../src/docker/docker.utils';
import { dockerStrategy } from '../../src/git-providers/strategies/docker.strategy';
import { gitStrategy } from '../../src/git-providers/strategies/git.strategy';
import { githubStrategy } from '../../src/git-providers/strategies/github/github.strategy';
import { dockerLoginCommand } from '../../src/registries/registry.utils';
import { ExecError } from '../../src/remote/exec-error';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type {
  ServerConnection,
  ServerKeyProvider,
} from '../../src/remote/server-key.provider';
import { buildScriptMaterializationCommand } from '../../src/scheduling/schedules/schedule-commands';
import { unverifiedHostKey } from '../../src/remote/host-key';

/**
 * The original finding: `ExecError` captures the whole command, and a command
 * that materializes an operator's file body carries `base64(that body)`. The
 * exception filter hands the exception to pino, whose error serializer writes
 * every own property, so a failed write printed the body — `mount.content`,
 * `schedule.script`, `patch.content`, `compose.env`, a certificate's private
 * key — into the journal, base64-encoded and trivially decodable.
 *
 * The first two secrets below are a *credential inside a file body*, which is
 * the whole argument of ADR 0015: the platform cannot know which lines of an
 * operator's script are the secret, so the body is treated as one.
 *
 * The last two are the review's finding on top of that, and they are not file
 * bodies at all — they are credentials in their own right that a command
 * carries because the tool being driven takes them there:
 * `registry.password`, piped to `docker login --password-stdin`, and
 * `sshKey.privateKey`, written to a scratch file before a private clone. Both
 * columns are `encryptedText`, neither travelled in `echo <base64> | base64 -d`
 * — the one shape the first fix elided — and so both reached the journal in clear, the
 * exact class the change was written to close.
 */
const SCRIPT_SECRET = 'PGPASSWORD=hunter2-4f9c1ea7';
const SCHEDULE_SCRIPT = `#!/bin/sh\nset -e\n${SCRIPT_SECRET} pg_dump app > /tmp/app.sql\n`;

const MOUNT_SECRET = 'STRIPE_SECRET_KEY=sk_live_91b3d0c6f2a84e57';
const MOUNT_CONTENT = `NODE_ENV=production\n${MOUNT_SECRET}\n`;

const GITHUB_TOKEN = 'ghs_7c2f4b91e0a63d85f1c8';

const REGISTRY_PASSWORD = 'ghp_4d81c0a7f6b25e93a1d7';

const SSH_KEY_SECRET = 'MIIEowIBAAKCAQEA9f3a2b71c0e845d6bAAAAAAA';
const SSH_PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----\n${SSH_KEY_SECRET}\n-----END RSA PRIVATE KEY-----`;

/** Every base64 run in a written log line, decoded. */
const decodedRuns = (line: string): string[] =>
  [...line.matchAll(/[A-Za-z0-9+/]{8,}={0,2}/g)].map((match) =>
    Buffer.from(match[0], 'base64').toString('utf8'),
  );

/**
 * The assertion the finding asks for, and the reason it is not `not.toContain`:
 * the payload is *never* in the line as a substring — it is base64 — so a
 * substring search over the plaintext passes against the leak. This decodes
 * every base64-alphabet run the line contains and asserts none of them yields
 * the secret, which is exactly what a person reading the journal would do.
 */
const expectNoDecodablePayload = (line: string, secret: string): void => {
  expect(line).not.toContain(secret);
  expect(line).not.toContain(Buffer.from(secret, 'utf-8').toString('base64'));
  for (const decoded of decodedRuns(line)) {
    expect(decoded).not.toContain(secret);
  }
};

// ssh2 is a system boundary — mocked, the way `remote-exec-remote.spec.ts`
// mocks it. Everything between the command builder and the journal line is the
// shipped code: the real RemoteExecService, the real ExecError, the real
// AllExceptionsFilter, the real nestjs-pino Logger built from the real
// loggerConfig.
const remoteFailure = { exitCode: 1, stderr: '' };

jest.mock('ssh2', () => {
  class Client extends EventEmitter {
    exec(
      _request: string,
      cb: (err: Error | undefined, stream: unknown) => void,
    ) {
      const stream = new EventEmitter() as EventEmitter & {
        stderr: EventEmitter;
        end: () => void;
      };
      stream.stderr = new EventEmitter();
      stream.end = () => {};
      cb(undefined, stream);
      process.nextTick(() => {
        if (remoteFailure.stderr)
          stream.stderr.emit('data', remoteFailure.stderr);
        stream.emit('close', remoteFailure.exitCode);
      });
    }

    connect() {
      process.nextTick(() => this.emit('ready'));
      return this;
    }

    end() {}
  }
  return { Client };
});

const CONNECTION: ServerConnection = {
  host: '203.0.113.10',
  port: 22,
  username: 'deploy',
  privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n',
  hostKey: unverifiedHostKey(),
};

const keyProvider: ServerKeyProvider = {
  getConnection: () => Promise.resolve(CONNECTION),
};

interface Journal {
  /** The one line the filter's `logger.error(exception)` wrote. */
  line: string;
  /** What the caller got on the wire. */
  body: ErrorResponseBody;
}

const written: string[] = [];
const sink = new Writable({
  write(chunk, _encoding, callback) {
    written.push(String(chunk));
    callback();
  },
});

/**
 * The real nestjs-pino logger, built once from the real `loggerConfig`.
 *
 * Once, because `LoggerModule.forRoot` assigns `PinoLogger.root` statically the
 * first time it initializes and a second module in the same process keeps
 * writing to the first one's destination — which silently produced an empty
 * journal for every test after the first.
 *
 * The two overrides on `loggerConfig` are `logger.config.spec.ts`'s and only
 * these two: the dev-console transport goes because pino refuses a transport
 * and a destination stream together, and the level is pinned so a `LOG_LEVEL`
 * in the environment cannot silence the line under test. The `serializers`
 * declaration this spec exists for is the shipped configuration verbatim.
 */
let closeLogger: () => Promise<void>;

beforeAll(async () => {
  const shipped = loggerConfig.pinoHttp as Options;
  const moduleRef = await Test.createTestingModule({
    imports: [
      LoggerModule.forRoot({
        pinoHttp: [{ ...shipped, transport: undefined, level: 'error' }, sink],
      }),
    ],
  }).compile();
  // `main.ts`'s `app.useLogger(logger)` in one call: the filter logs through
  // `@nestjs/common`'s Logger, which forwards to whatever the app installed.
  NestLogger.overrideLogger(moduleRef.get(PinoNestLogger));
  closeLogger = async () => {
    NestLogger.overrideLogger(false);
    await moduleRef.close();
  };
});

afterAll(async () => {
  await closeLogger();
});

/**
 * Drives a failed remote write all the way to the journal.
 *
 * `options` exists for never-carry: a build now hands `RemoteExecOptions.env` the
 * values its command used to carry, and the assertion that matters is made on
 * the journal line *with* that environment in flight — a fix that moved the
 * secret from the command into a field `ExecError` also captured would be no
 * fix at all.
 */
async function journalFailedWrite(
  command: string,
  options?: { env: Record<string, string> },
): Promise<Journal> {
  const service = new RemoteExecService(keyProvider);
  let thrown: unknown;
  try {
    await service.execAsyncRemote('srv_9f3a', command, undefined, options);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ExecError);

  written.length = 0;
  let body!: ErrorResponseBody;
  new AllExceptionsFilter().catch(thrown, {
    switchToHttp: () => ({
      getRequest: () => ({ url: '/api/mounts' }),
      getResponse: () => ({
        status: () => ({
          json: (payload: ErrorResponseBody) => {
            body = payload;
          },
        }),
      }),
    }),
  } as unknown as ArgumentsHost);

  expect(written).toHaveLength(1);
  return { line: written[0], body };
}

describe('RemoteExecService.execAsyncRemote, on a failed write that carried a file body', () => {
  beforeEach(() => {
    remoteFailure.exitCode = 1;
    remoteFailure.stderr = '';
  });

  it("elides a schedule's script from the journalled command", async () => {
    const command = buildScriptMaterializationCommand(
      { scheduleId: 'sch_2b71', appName: 'blog-app', script: SCHEDULE_SCRIPT },
      // The Server this write is journalled as having failed on — the builder
      // roots the script tree on it, and this file is about the
      // *body* the command carries rather than the path it names.
      'srv_1',
    );
    const { line } = await journalFailedWrite(command);

    expectNoDecodablePayload(line, SCRIPT_SECRET);
  });

  it("elides a file mount's content from the journalled command", async () => {
    const command = getCreateFileCommand(
      '/etc/cloudgate/applications/blog-app/files',
      '.env',
      MOUNT_CONTENT,
    );
    const { line } = await journalFailedWrite(command);

    expectNoDecodablePayload(line, MOUNT_SECRET);
  });

  it('elides the payload from every field pino writes, not just the command', async () => {
    const command = getCreateFileCommand('/srv/files', '.env', MOUNT_CONTENT);
    // The shell echoing the line it could not run: `stderr` reaches the journal
    // too, which is why `REDACTED_ERROR_FIELDS` covers it.
    remoteFailure.stderr = `sh: syntax error near unexpected token\n${command}`;
    const { line } = await journalFailedWrite(command);

    const entry = JSON.parse(line) as {
      err: Record<string, unknown> & {
        originalError?: Record<string, unknown>;
      };
    };
    for (const field of ['message', 'stack', 'command', 'stderr'] as const) {
      expect(typeof entry.err[field]).toBe('string');
    }
    expectNoDecodablePayload(line, MOUNT_SECRET);
  });

  it('keeps the shape of the command a reader needs to diagnose the failure', async () => {
    const command = buildScriptMaterializationCommand(
      { scheduleId: 'sch_2b71', appName: 'blog-app', script: SCHEDULE_SCRIPT },
      // The Server this write is journalled as having failed on — the builder
      // roots the script tree on it, and this file is about the
      // *body* the command carries rather than the path it names.
      'srv_1',
    );
    const { line } = await journalFailedWrite(command);
    const { err } = JSON.parse(line) as { err: Record<string, unknown> };

    // Which verbs, which paths, which host, which exit code — all still there.
    expect(err.command).toContain('mkdir -p /etc/cloudgate/schedules/blog-app');
    expect(err.command).toContain(
      '| base64 -d > /etc/cloudgate/schedules/blog-app/script.sh.tmp',
    );
    expect(err.command).toContain('chmod +x');
    expect(err.command).toContain('mv -f');
    expect(err.command).toContain('set -e');
    expect(err.serverId).toBe('srv_9f3a');
    expect(err.exitCode).toBe(1);
    // And the one thing about the body itself worth knowing: how big it was.
    expect(err.command).toContain(
      `[file body elided: ${Buffer.byteLength(
        `echo "PID: $$ | Schedule ID: sch_2b71"\n${SCHEDULE_SCRIPT}`,
      )} bytes]`,
    );
  });

  it('answers the caller a bare 500 — the leak was only ever into the journal', async () => {
    const { body } = await journalFailedWrite(
      getCreateFileCommand('/srv/files', '.env', MOUNT_CONTENT),
    );

    expect(body).toMatchObject({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Internal server error',
    });
  });

  it('elides the provider token from a clone URL in the journalled command', async () => {
    const { command } = githubStrategy.cloneProgram({
      owner: 'octabyte-io',
      repository: 'cloudgate',
      branch: 'main',
      outputPath: '/etc/cloudgate/applications/blog-app/code',
      githubToken: GITHUB_TOKEN,
    });
    const { line } = await journalFailedWrite(command);
    const { err } = JSON.parse(line) as { err: Record<string, string> };

    expect(line).not.toContain(GITHUB_TOKEN);
    // The scheme, the user that names *which* credential, the host and the repo
    // path survive: an operator still sees what was cloned from where. The
    // backslashes are `shell-quote`'s — this is what the wire shape looks like,
    // and a pattern written against the unescaped form matches nothing.
    expect(err.command).toContain(
      'https\\://oauth2\\:[credential elided]\\@github.com/octabyte-io/cloudgate.git',
    );
  });

  /**
   * The registry password, at the two sites that compose a login.
   *
   * `--password-stdin` is what keeps the password out of `docker`'s argv and
   * out of the host's process table, and it does nothing whatever about the
   * *command string*, which is what `ExecError` captures and pino writes six
   * times over. A refused login is also the likeliest of all these failures:
   * an expired PAT is an ordinary Tuesday, and it is the one that puts the
   * password in the journal.
   */
  it("never puts a registry's password in the push login, so the journal has none to elide", async () => {
    // The primary assertion is the first one, and it is deliberately about the
    // command *as constructed* rather than about the journal: the never-carry review
    // established that a journal assertion alone cannot tell never-carry from
    // a working mask, because a partial revert leaves the mask covering for the
    // leak. Absence before any error exists is the property only never-carry
    // has.
    const login = dockerLoginCommand(
      'registry.acme.dev',
      'pusher',
      'CG_REGISTRY_PASSWORD_0',
    );
    expect(login).not.toContain(REGISTRY_PASSWORD);

    const command = `${login} || { echo "❌ Registry login failed" ; exit 1; }`;
    const { line } = await journalFailedWrite(command);
    const { err } = JSON.parse(line) as { err: Record<string, string> };

    // Still asserted over the journal line, for the reason never-carry gives: a
    // builder assertion speaks for one string, and pino writes six fields.
    expectNoDecodablePayload(line, REGISTRY_PASSWORD);
    // Which registry, as which user, by which mechanism — the whole diagnosis
    // of a refused login is there, and so is the holder's *name*, which is what
    // tells a reader the value was environment-borne rather than lost.
    expect(err.command).toContain(
      `printf %s "$CG_REGISTRY_PASSWORD_0" | docker login 'registry.acme.dev' -u 'pusher' --password-stdin`,
    );
    expect(err.command).toContain('❌ Registry login failed');
  });

  it("never puts a docker-sourced application's pull password in the clone", async () => {
    const { command, env } = dockerStrategy.cloneProgram({
      outputPath: '/etc/cloudgate/applications/blog-app/code',
      dockerImage: 'ghcr.io/acme/api:1.2.3',
      registryUrl: 'ghcr.io',
      username: 'acme',
      password: REGISTRY_PASSWORD,
    });

    // As constructed, and carried — the pair, so this cannot pass by the
    // strategy having dropped the credential instead of moving it.
    expect(command).not.toContain(REGISTRY_PASSWORD);
    expect(env).toEqual({ CG_SOURCE_REGISTRY_PASSWORD: REGISTRY_PASSWORD });

    const { line } = await journalFailedWrite(command);
    const { err } = JSON.parse(line) as { err: Record<string, string> };

    expectNoDecodablePayload(line, REGISTRY_PASSWORD);
    expect(err.command).toContain(
      `if ! printf %s "$CG_SOURCE_REGISTRY_PASSWORD" | docker login 'ghcr.io' -u 'acme' --password-stdin; then`,
    );
    expect(err.command).toContain("docker pull 'ghcr.io/acme/api:1.2.3'");
  });

  /**
   * The sharpest of the two. `git.strategy.ts` materializes the operator's SSH
   * key before a private clone, and it used to do it as `echo <key> > <path>`
   * — the `echo` anchor without the `| base64 -d` one — so the whole PEM went
   * into `command`, `message`, `stack` and Node's `cmd`. It now travels in the
   * same base64 shape as every other file body in the tree, which is the shape
   * the elision recognises.
   */
  it('elides the custom-git ssh private key from the journalled clone', async () => {
    const { command } = gitStrategy.cloneProgram({
      url: 'git@github.com:octabyte-io/private.git',
      branch: 'main',
      outputPath: '/etc/cloudgate/applications/blog-app/code',
      sshKey: { privateKey: SSH_PRIVATE_KEY },
    });
    const { line } = await journalFailedWrite(command);
    const { err } = JSON.parse(line) as { err: Record<string, string> };

    expectNoDecodablePayload(line, SSH_KEY_SECRET);
    expect(line).not.toContain('BEGIN RSA PRIVATE KEY');
    // Every verb and every path of the setup a reader needs: the scratch dir,
    // the key path, the mode, the host that was trusted, the repo that was
    // cloned, and the key's decoded size.
    expect(err.command).toContain('CG_GIT_SSH=$(mktemp -d);');
    expect(err.command).toContain('| base64 -d > "$CG_GIT_SSH/id_rsa";');
    expect(err.command).toContain('chmod 600 "$CG_GIT_SSH/id_rsa";');
    expect(err.command).toContain('ssh-keyscan -p 22 github.com');
    expect(err.command).toContain(
      'git -c protocol.file.allow=never clone --branch main',
    );
    expect(err.command).toContain(
      `[file body elided: ${SSH_PRIVATE_KEY.length + 1} bytes]`,
    );
  });
});

/**
 * The build's own environment, at the six builders that used to put it on
 * a command line.
 *
 * This is the counterpart of the two `docker login` cases above and it comes
 * out the other way. There the credential is `docker`'s wire format and stays
 * in the command, elided on its shape; here the value never enters the string
 * at all, so there is nothing to elide and no pattern to keep correct — which
 * is what ADR 0015's last bullet asks for and what the error mask recorded as
 * unavailable from the login sites. It is available here because the values
 * originate in the deploy engine rather than in a clone command it cannot
 * change the return type of.
 *
 * Every case runs the *shipped* strategy and drives the whole path — the real
 * `RemoteExecService`, the real `ExecError`, the real `AllExceptionsFilter`,
 * the real nestjs-pino logger — with the declared environment in flight.
 */
describe('RemoteExecService.execAsyncRemote, on a failed build and the environment it was given', () => {
  const BUILD_SECRET = 'sk_live_91b3d0c6f2a84e57';
  const BUILD_ENV = `NODE_ENV=production\nSTRIPE_KEY=${BUILD_SECRET}`;

  const buildInput = {
    appName: 'blog-app',
    buildAppDirectory: '/etc/cloudgate/applications/blog-app/code',
    dockerfilePath: '/etc/cloudgate/applications/blog-app/code/Dockerfile',
    buildNonce: 'nonce123456',
  };

  const builders: [name: string, program: BuildProgram][] = [
    [
      'nixpacks',
      nixpacksStrategy.getProgram({ ...buildInput, env: BUILD_ENV }),
    ],
    ['heroku', herokuStrategy.getProgram({ ...buildInput, env: BUILD_ENV })],
    ['paketo', paketoStrategy.getProgram({ ...buildInput, env: BUILD_ENV })],
    [
      'railpack',
      railpackStrategy.getProgram({ ...buildInput, env: BUILD_ENV }),
    ],
    [
      'dockerfile',
      dockerfileStrategy.getProgram({
        ...buildInput,
        buildArgs: BUILD_ENV,
        buildSecrets: BUILD_ENV,
      }),
    ],
    [
      'static',
      staticStrategy.getProgram({
        ...buildInput,
        buildArgs: BUILD_ENV,
        buildSecrets: BUILD_ENV,
        publishDirectory: 'dist',
      }),
    ],
  ];

  beforeEach(() => {
    remoteFailure.exitCode = 1;
    remoteFailure.stderr = '';
  });

  for (const [name, program] of builders) {
    it(`journals no value out of the ${name} builder's own environment`, async () => {
      const { line } = await journalFailedWrite(program.command, {
        env: program.env,
      });

      expect(Object.values(program.env)).toContain(BUILD_SECRET);
      expectNoDecodablePayload(line, BUILD_SECRET);
      // The holder's *name* is in the journal and that is the point: a reader
      // sees that a variable was passed and which one, and not what it was.
      expect(line).toContain('CG_BUILD_');
    });
  }

  it('keeps the shape of the build a reader needs to diagnose the failure', async () => {
    const program = nixpacksStrategy.getProgram({
      ...buildInput,
      env: BUILD_ENV,
      cleanCache: true,
    });
    const { line } = await journalFailedWrite(program.command, {
      env: program.env,
    });
    const { err } = JSON.parse(line) as { err: Record<string, unknown> };

    expect(err.command).toContain(
      'nixpacks build /etc/cloudgate/applications/blog-app/code --name blog-app',
    );
    expect(err.command).toContain('--no-cache');
    expect(err.command).toContain('--env STRIPE_KEY"=$CG_BUILD_ENV_1"');
    expect(err.command).toContain('❌ Nixpacks build failed');
    expect(err.serverId).toBe('srv_9f3a');
    expect(err.exitCode).toBe(1);
  });

  /**
   * The one place a build's environment is still in the command string, and the
   * one place the answer is a mask rather than never-carry: with
   * `createEnvFile`, the operator's environment *is* a file body, so it travels
   * base64 through `getCreateFileCommand` like a mount's content and a
   * schedule's script, and the elision the mask shipped is what removes it.
   */
  it("journals no value out of a build's .env file either", async () => {
    const program = dockerfileStrategy.getProgram({
      ...buildInput,
      env: BUILD_ENV,
      createEnvFile: true,
    });
    const { line } = await journalFailedWrite(program.command);
    const { err } = JSON.parse(line) as { err: Record<string, string> };

    expectNoDecodablePayload(line, BUILD_SECRET);
    expect(err.command).toContain(
      '| base64 -d > "/etc/cloudgate/applications/blog-app/code/.env"',
    );
    expect(err.command).toContain(
      `[file body elided: ${Buffer.byteLength(BUILD_ENV)} bytes]`,
    );
  });
});

describe('ExecError elides by shape, not by field name', () => {
  /**
   * The property that catches the field somebody forgets. The elision is in the
   * constructor, so no *call site* can forget it — but a fifth field on
   * `ExecErrorDetails` (a `script`, an `env`, a `stdin`) could, and would ship
   * green, because a new field has no test asserting it is masked. This drives
   * a payload through every string field there is and asserts none survives, so
   * it fails on the field rather than on someone remembering.
   */
  it('leaves no decodable payload in any string it carries', () => {
    const carrying = getCreateFileCommand('/srv/files', '.env', MOUNT_CONTENT);
    const error = new ExecError(`Command failed: ${carrying}`, {
      command: carrying,
      stdout: carrying,
      stderr: carrying,
      serverId: carrying,
      exitCode: 1,
      originalError: Object.assign(new Error(carrying), { cmd: carrying }),
    });

    const strings = [
      error.message,
      error.stack ?? '',
      ...Object.values(error as unknown as Record<string, unknown>).filter(
        (value): value is string => typeof value === 'string',
      ),
      ...Object.values(
        error.originalError as unknown as Record<string, unknown>,
      ).filter((value): value is string => typeof value === 'string'),
      error.originalError?.message ?? '',
      error.originalError?.stack ?? '',
    ];
    expect(strings.length).toBeGreaterThan(6);
    for (const text of strings) expectNoDecodablePayload(text, MOUNT_SECRET);
  });

  /**
   * The second layer under the shape change above. `git.strategy.ts` no longer
   * writes a bare PEM, but a private key is the one secret in this tree that
   * *says what it is* on the wire, so it is elided on its format wherever it
   * turns up rather than only in the shape one builder happened to use — which
   * is what makes the coverage claim in `error-payloads.ts` true for a
   * certificate key too, base64 or not.
   */
  it('elides a private key that reaches a command in no wire shape at all', () => {
    const carrying = `echo '${SSH_PRIVATE_KEY}' > /tmp/cloudgate/id_rsa; chmod 600 /tmp/cloudgate/id_rsa`;
    const error = new ExecError(`Command failed: ${carrying}`, {
      command: carrying,
      stderr: carrying,
      serverId: 'srv_9f3a',
      exitCode: 1,
    });

    for (const text of [
      error.message,
      error.stack ?? '',
      error.command,
      error.stderr ?? '',
    ]) {
      expectNoDecodablePayload(text, SSH_KEY_SECRET);
      expect(text).toContain('-----BEGIN RSA PRIVATE KEY-----');
    }
    expect(error.command).toContain('chmod 600 /tmp/cloudgate/id_rsa');
  });

  it('leaves a field that is not a payload exactly as it was', () => {
    const error = new ExecError('Remote command failed with exit code 1', {
      command: 'docker inspect blog-app-9f3a2b1c',
      serverId: 'srv_9f3a',
      exitCode: 1,
      stdout: 'no such object: blog-app-9f3a2b1c\n',
    });

    expect(error.name).toBe('ExecError');
    expect(error.serverId).toBe('srv_9f3a');
    expect(error.command).toBe('docker inspect blog-app-9f3a2b1c');
    expect(error.stdout).toBe('no such object: blog-app-9f3a2b1c\n');
    expect(error.message).toBe('Remote command failed with exit code 1');
  });
});

describe('RemoteExecService.execAsync, on a failed local exec that carried a file body', () => {
  it("elides the payload out of Node's own `Command failed: <cmd>` message", async () => {
    const service = new RemoteExecService();
    const command = `${getCreateFileCommand('/proc/nonexistent-dir', '.env', MOUNT_CONTENT)} exit 7`;
    let thrown!: ExecError;
    try {
      await service.execAsync(command);
    } catch (error) {
      thrown = error as ExecError;
    }

    // `child_process.exec` puts the whole failed line in `error.message` and
    // again in `error.cmd`, and `ExecError` wraps both.
    for (const text of [
      thrown.message,
      thrown.stack ?? '',
      thrown.command,
      (thrown.originalError as { cmd?: string } | undefined)?.cmd ?? '',
      thrown.originalError?.message ?? '',
      thrown.originalError?.stack ?? '',
    ]) {
      expectNoDecodablePayload(text, MOUNT_SECRET);
    }
    expect(thrown.command).toContain(
      'base64 -d > "/proc/nonexistent-dir/.env"',
    );
  });
});
