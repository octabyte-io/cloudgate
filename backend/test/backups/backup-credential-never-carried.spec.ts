import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import { Logger as NestLogger } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger as PinoNestLogger, LoggerModule } from 'nestjs-pino';
import type { Options } from 'pino-http';

import {
  BACKUP_COMMANDS,
  DATABASE_PASSWORD_ENV,
  buildBackupScript,
} from '../../src/backups/commands';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import type { ErrorResponseBody } from '../../src/common/filters/all-exceptions.filter';
import { loggerConfig } from '../../src/common/logging/logger.config';
import {
  execRclone,
  rcloneFailureMessage,
} from '../../src/destinations/rclone-exec';
import type { S3Credentials } from '../../src/destinations/s3-credentials';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type {
  ServerConnection,
  ServerKeyProvider,
} from '../../src/remote/server-key.provider';
import { unverifiedHostKey } from '../../src/remote/host-key';
import { SELF_HOSTED } from '../utils/instance-mode-double';

/**
 * The never-carry change's backups half: the database password used to be a
 * **word of the dump and restore command lines** — `mysqldump … --password=<the
 * root password>`, `mariadb -p<the password>`, `mongodump -p <the password>` —
 * and those command lines are exactly what `ExecError` captures and pino writes
 * six times over. After the fix the same value is `encryptedJson` ciphertext in
 * `backup.metadata`, so the platform classified it as a secret at rest and then
 * printed it in clear on every failed run: the docblock lie ADR 0015 warns about.
 *
 * **This spec is about never-carry, not about a fourth elision pattern.** ADR
 * 0015's last bullet says so in as many words: a secret that never enters a
 * command string cannot be journalled, mis-elided, or leaked by the next tool
 * that reads the string, while a mask has to keep being right. So what is
 * asserted below is not that the password is redacted — it is that no layer of
 * the emitted command ever contained it, and that the value nonetheless
 * reaches the tool, which a proof of absence alone would not distinguish from a
 * backup that has quietly stopped authenticating.
 *
 * ---
 *
 * **Read this before you falsify anything here, because the obvious mutation
 * lies.** Whoever next doubts these tests will reach for the same one-line
 * revert, get a green suite, and conclude the spec proves nothing. It does
 * prove something; the mutation is what is wrong. Three findings, all measured:
 *
 * 1. **The error-payload elision is not a second layer over this value, and there is no
 *    "pair" here to prove.** It is tempting to read this change as one of two
 *    independent defences — `elidePayloadsInError` masks the journal, and
 *    never-carry keeps the value out of the string — and to falsify it by
 *    disabling both. That reading is false. `elideEncodedPayloads` has four
 *    patterns and *none* of them matches a password flag: measured, all six
 *    pre-fix command lines (`mysqldump --password=…`, `mysql -p…`,
 *    `mariadb-dump --password=…`, `mariadb -p…`, `mongodump -p …`,
 *    `mongorestore --password …`) come back from it **byte-identical**, still
 *    carrying the value. The change's own ticket says as much — "none of the mask's three
 *    patterns touches them" — and the journal test below reds on the plaintext
 *    with that mask fully in place. Never-carry is the only thing that ever
 *    covered this value.
 * 2. **What *is* downstream of never-carry is the change's own guard**, and it is a
 *    regression detector rather than a defence in depth:
 *    `rclone-exec.ts`'s `assertCredentialFreeCommand` refuses a command that
 *    contains a value the caller declared environment-borne, and `maskEnvValues`
 *    takes that value out of the refusal it is about to throw.
 * 3. **So the misleading mutation is the *partial* one.** Re-interpolate the
 *    password into the command but leave `engineShellCommand`'s `credentials`
 *    argument in place, and the builder still declares the value
 *    environment-borne — so the guard refuses the run, `maskEnvValues` elides
 *    the value out of the refusal, and the journal line below contains no
 *    password. **The leak assertion stays green against a command that carries
 *    the password.** That is the trap, and it is why the primary assertion in
 *    this spec is not the journal line. The journal tests now open by asserting
 *    the line is a failed *run* rather than a refusal, so this mutation reds on
 *    an assertion that names its own cause instead of on the diagnosability
 *    assertions further down — which is how it was found, and which was a
 *    confusing way to be told the password is back in the command.
 *
 * **What the assertions are, therefore, and in which order they matter.**
 *
 * - The load-bearing one is on the command **as constructed**, before any error
 *   exists: `expectNoDecodablePayload(command, PASSWORD)` over every direction
 *   of every engine. It is a property of never-carry *alone* — no mask can
 *   manufacture it, the guard's included, because there is no error for a mask
 *   to run on — and it is the assertion that reds under both mutations above.
 * - The journal line is asserted as well, for a narrower reason than "proving
 *   the pair": a builder assertion speaks for one string, and the mask's finding was
 *   that pino writes the command **six times over** across `message`, `stack`,
 *   `command`, `cmd`, `originalError.message` and `originalError.stack`. Only an
 *   end-to-end run through the real `buildBackupScript`, `execRclone`,
 *   `RemoteExecService`, `ExecError`, `AllExceptionsFilter` and `loggerConfig`
 *   can speak for all of them, and for the HTTP body beside them. Both of
 *   `execRclone`'s branches are driven, because they leak differently and only
 *   one of them is that shape: measured under the whole mutation, the remote
 *   branch puts the password on the line **once** and the local branch —
 *   `serverId === null`, a Service on the platform's own host, where
 *   `child_process` writes the failing command into the error it makes — puts it
 *   there **seven times**, which is the mask's six fields plus pino's own `msg`.
 * - And the credential is asserted to still **reach the tool**, because a proof
 *   of absence passes just as well against a backup that has silently stopped
 *   authenticating — which, for a backup, is a failure you discover at restore
 *   time.
 *
 * The honest whole-mutation, for whoever wants to watch this red: revert the
 * command string **and** drop the `credentials` argument, in all three
 * builders. That reproduces the world at 2e2356f and reds 27 of the 40 tests
 * here, the journal's leak assertions among them. The partial one — the command
 * string alone — reds 20, and none of the 20 is a leak assertion.
 */
const PASSWORD = 'r00t-4f9c1ea7b2d08356';

/** Every base64 run in a written line, decoded — `expectNoDecodablePayload`'s
 * oracle from `test/remote/exec-error-payloads.spec.ts`, and it is here for the
 * same reason: a substring search over the plaintext passes against a leak that
 * travelled encoded, and the shape a shell would echo back is not knowable in
 * advance. What a person reading the journal would do is decode every run. */
const decodedRuns = (line: string): string[] =>
  [...line.matchAll(/[A-Za-z0-9+/]{8,}={0,2}/g)].map((match) =>
    Buffer.from(match[0], 'base64').toString('utf8'),
  );

const expectNoDecodablePayload = (line: string, secret: string): void => {
  expect(line).not.toContain(secret);
  expect(line).not.toContain(Buffer.from(secret, 'utf-8').toString('base64'));
  for (const decoded of decodedRuns(line)) {
    expect(decoded).not.toContain(secret);
  }
};

/** The three engines whose tools authenticate, and the credential set each
 * builder is parameterized by. libsql needs none and postgres uses the
 * container's own peer authentication, so both are asserted separately. */
const CREDENTIALS = {
  database: 'shop',
  databaseUser: 'shop_user',
  databasePassword: PASSWORD,
};

const AUTHENTICATING = ['mysql', 'mariadb', 'mongo'] as const;
const DIRECTIONS = ['dump', 'restore'] as const;

describe('engineShellCommand, on the dump and restore of an engine that authenticates', () => {
  describe.each(AUTHENTICATING)('%s', (engine) => {
    describe.each(DIRECTIONS)('%s', (direction) => {
      it('carries no recoverable form of the password', () => {
        const { command } = BACKUP_COMMANDS[engine][direction](CREDENTIALS);

        expectNoDecodablePayload(command, PASSWORD);
      });

      it('names the variable it reads the password from, and only names it', () => {
        const { command, env } =
          BACKUP_COMMANDS[engine][direction](CREDENTIALS);

        // The `-e NAME` pass-through form, with no `=`: `docker` copies the
        // value out of its own client environment, so the value is not a word
        // of the *host's* `docker exec` either.
        expect(command).toContain(`docker exec -e ${DATABASE_PASSWORD_ENV} -i`);
        expect(command).not.toContain(`${DATABASE_PASSWORD_ENV}=`);
        expect(command).toContain(`"$${DATABASE_PASSWORD_ENV}"`);
        // And the value travels in the environment the command is executed
        // with, which is where `execRclone` already carries the S3 credentials.
        expect(env).toEqual({ [DATABASE_PASSWORD_ENV]: PASSWORD });
      });
    });
  });

  // Both directions, because a restore is as sensitive as a dump and the change
  // named `mysql.ts:20`, `mariadb.ts:17` and `mongo.ts:18` for exactly that.
  it('covers the restore direction with the same mechanism as the dump', () => {
    for (const engine of AUTHENTICATING) {
      const dump = BACKUP_COMMANDS[engine].dump(CREDENTIALS);
      const restore = BACKUP_COMMANDS[engine].restore(CREDENTIALS);

      expect(restore.env).toEqual(dump.env);
    }
  });
});

describe('engineShellCommand, on the engines that need no password', () => {
  // The ticket claimed these carry none, and they do not: `pg_dump` is given
  // `--no-password` and authenticates as the container's own superuser over the
  // local socket, `pg_restore` likewise, and libsql has no dump tool at all —
  // its "dump" is `tar` over the sqld data directory.
  it.each([
    ['postgres', 'dump'],
    ['postgres', 'restore'],
    ['libsql', 'dump'],
    ['libsql', 'restore'],
  ] as const)('%s %s asks for no environment', (engine, direction) => {
    const { command, env } = BACKUP_COMMANDS[engine][direction](CREDENTIALS);

    expect(env).toEqual({});
    expect(command).not.toContain('docker exec -e');
    expect(command).not.toContain(DATABASE_PASSWORD_ENV);
    expectNoDecodablePayload(command, PASSWORD);
  });
});

/**
 * The sharp end: a failed dump, all the way to the line pino writes.
 *
 * Everything between the command builder and the journal is the shipped code —
 * the real `BACKUP_COMMANDS`, the real `buildBackupScript`, the real
 * `execRclone`, the real `RemoteExecService`, the real `ExecError`, the real
 * `AllExceptionsFilter` and the real `loggerConfig`. Only ssh2 is mocked,
 * because it is the system boundary, exactly as
 * `test/remote/exec-error-payloads.spec.ts` mocks it.
 */
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

const DESTINATION: S3Credentials = {
  endpoint: 'https://s3.example.com',
  region: 'us-east-1',
  accessKey: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  provider: null,
};

const written: string[] = [];
const sink = new Writable({
  write(chunk, _encoding, callback) {
    written.push(String(chunk));
    callback();
  },
});

let closeLogger: () => Promise<void>;

beforeAll(async () => {
  // The two overrides are `logger.config.spec.ts`'s and only these two: pino
  // refuses a transport and a destination stream together, and the level is
  // pinned so a `LOG_LEVEL` in the environment cannot silence the line.
  const shipped = loggerConfig.pinoHttp as Options;
  const moduleRef = await Test.createTestingModule({
    imports: [
      LoggerModule.forRoot({
        pinoHttp: [{ ...shipped, transport: undefined, level: 'error' }, sink],
      }),
    ],
  }).compile();
  NestLogger.overrideLogger(moduleRef.get(PinoNestLogger));
  closeLogger = async () => {
    NestLogger.overrideLogger(false);
    await moduleRef.close();
  };
});

afterAll(async () => {
  await closeLogger();
});

interface Journal {
  line: string;
  body: ErrorResponseBody;
  /** The thrown error's own message — what `BackupsService.notifyRun` hands the
   * notification channels as `errorMessage`, so it leaves the instance. */
  message: string;
  /** The thrown error itself, for the projections that read its other fields. */
  error: Record<string, unknown>;
}

/**
 * Drives a failed backup run to the journal line the exception filter writes.
 *
 * `serverId` picks which of `execRclone`'s two branches fails, and they are not
 * the same leak. On the remote branch `ExecError.message` is this tree's own
 * `Remote command failed with exit code 1` and the script is in `command`
 * alone. On the **local** branch it is `child_process`'s, so the whole script
 * comes back inside the message as `Command failed: …` — which is the mask's
 * measured six-field shape (`message`, `stack`, `command`, `cmd`,
 * `originalError.message`, `originalError.stack`) and is also the string
 * `BackupsService.notifyRun` builds an operator's email out of. A `null`
 * `serverId` is the platform host's own Services, so this is a live route, and
 * `logPath` is what makes the run fail there without a docker or an rclone:
 * `set -eo pipefail` and a redirect into a directory that does not exist end
 * the script on its first line.
 */
async function journalFailedRun(
  engine: 'mysql' | 'mariadb' | 'mongo',
  {
    serverId = 'srv_9f3a',
    logPath = '/etc/cloudgate/logs/blog-app/dep_1.log',
  }: { serverId?: string | null; logPath?: string } = {},
) {
  const dump = BACKUP_COMMANDS[engine].dump(CREDENTIALS);
  const script = buildBackupScript({
    containerSearch: 'docker ps -q --filter status=running | head -n 1',
    dumpCommand: dump.command,
    rcloneCommand: 'rclone rcat :s3:dumps/blog-app/daily/now.sql.gz',
    logPath,
    uploadTarget: ':s3:dumps/blog-app/daily/now.sql.gz',
  });
  const service = new RemoteExecService(keyProvider);

  let thrown: unknown;
  try {
    await execRclone(service, script, {
      destination: DESTINATION,
      serverId,
      platformHost: SELF_HOSTED,
      shell: '/bin/bash',
      env: dump.env,
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);

  written.length = 0;
  let body!: ErrorResponseBody;
  new AllExceptionsFilter().catch(thrown, {
    switchToHttp: () => ({
      getRequest: () => ({ url: '/api/backups/run' }),
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
  return {
    line: written[0],
    body,
    message: (thrown as { message?: string }).message ?? '',
    error: thrown as Record<string, unknown>,
  } satisfies Journal;
}

describe("buildBackupScript, on a failed run's journal line", () => {
  beforeEach(() => {
    remoteFailure.exitCode = 1;
    remoteFailure.stderr = '';
  });

  it.each(AUTHENTICATING)(
    'carries no recoverable password for %s',
    async (engine) => {
      const { line } = await journalFailedRun(engine);

      // **First**, that this line is a failed *run* — the dump reached the host
      // and the host said no. Asserted before the elision assertion because it
      // is what makes that one mean anything: a command that carried the
      // password would be stopped at `execRclone`'s guard instead, and the
      // guard's `maskEnvValues` would take the value out of its own refusal, so
      // a leak assertion on that line passes while the command is wrong. See
      // the trap in this file's header. Without this the partial regression
      // reds only on the diagnosability assertions below, which is a confusing
      // way to be told the password is back in the command.
      expect(line).toContain('Remote command failed with exit code 1');
      expect(line).not.toContain('Refusing to run');

      expectNoDecodablePayload(line, PASSWORD);
      // Not a blank line: the failure is still diagnosable, which is the whole
      // reason never-carry beats eliding after the fact.
      expect(line).toContain('srv_9f3a');
      expect(line).toContain('docker exec');
    },
  );

  // The other branch, and the worse one. `serverId === null` is a Service on
  // the platform's own host, `execRclone` runs the script through
  // `RemoteExecService.execAsync`, and `child_process` puts the entire failing
  // command inside the error it makes — so this is where the "the command
  // appeared six times on one line" was measured, and where `notifyRun`'s
  // `errorMessage` comes from. The remote tests above cannot speak for it: on
  // that branch the message is this tree's own and names an exit code.
  it.each(AUTHENTICATING)(
    'carries no recoverable password for %s on the platform host either',
    async (engine) => {
      const logPath = path.join(
        os.tmpdir(),
        'cloudgate-no-such-directory',
        'blog-app',
        'dep_1.log',
      );
      expect(fs.existsSync(path.dirname(logPath))).toBe(false);

      const { line, message, body } = await journalFailedRun(engine, {
        serverId: null,
        logPath,
      });

      // The leaky shape really is the one under test: the whole script is in
      // the message, not just in `command`. Without this the test could pass
      // because the branch never ran.
      expect(message).toContain('Command failed');
      expect(message).toContain('docker exec');

      expectNoDecodablePayload(line, PASSWORD);
      expectNoDecodablePayload(message, PASSWORD);
      expectNoDecodablePayload(JSON.stringify(body), PASSWORD);
      // And every field pino wrote, individually — the six-field count is the
      // reason `REDACTED_ERROR_FIELDS` exists, and a whole-line search would
      // pass if one of them were absent for the wrong reason.
      const err = (JSON.parse(line) as { err: Record<string, unknown> }).err;
      for (const field of ['message', 'stack', 'command', 'cmd']) {
        if (typeof err[field] === 'string')
          expectNoDecodablePayload(err[field], PASSWORD);
      }
      expect(typeof err.command).toBe('string');
    },
  );

  /**
   * The *other* projection of that same error, and the only one that leaves the
   * instance over HTTP: `BackupsService.restoreBackup` catches and rethrows
   * `rcloneFailureMessage(error, …)` as the caller's 400 body.
   *
   * It prefers a refusal on stdout, then stderr, and **falls back to
   * `message`** — which on the local branch is `child_process`'s whole failing
   * script, the 4.6 KB of source `FAILURE_ON_STDOUT`'s docblock records having
   * been answered with once already. So the fallback is forced here rather than
   * waited for: a real failure usually has something on stderr, which is why
   * this is the branch that would go unnoticed, and a silent non-zero exit is
   * not hypothetical — `mysql` fed an empty stream is the pipefail fix's whole finding.
   */
  it('answers a restore caller without the password when the failure is silent', async () => {
    const { error, message } = await journalFailedRun('mysql', {
      serverId: null,
      logPath: path.join(os.tmpdir(), 'cloudgate-no-such-directory', 'x.log'),
    });
    // `message` is spelled out rather than spread: V8 makes an `Error`'s own
    // `message` non-enumerable, so `{ ...error }` silently drops the very field
    // this asserts on and `rcloneFailureMessage` would answer the `fallback` —
    // green, and about nothing. `elideEveryString`'s docblock records the same
    // property from the other side.
    const silent = { ...error, message, stdout: '', stderr: '' };

    const answered = rcloneFailureMessage(silent, 'Failed to restore');

    // The fallback really is what won, so this is the leaky candidate and not
    // an incidental pass on a short stderr.
    expect(answered).toContain('Command failed');
    expectNoDecodablePayload(answered, PASSWORD);
  });

  it('carries no password when the shell echoes the line back on stderr', async () => {
    // The shape that defeats a mask written for the command alone: whatever the
    // remote shell says about the line it could not run reaches `stderr`, which
    // `REDACTED_ERROR_FIELDS` covers and pino writes. Here there is nothing to
    // redact, because the line the shell is echoing never had the value in it.
    const dump = BACKUP_COMMANDS.mysql.dump(CREDENTIALS);
    remoteFailure.stderr = `sh: 1: syntax error near unexpected token: ${dump.command}`;
    const { line } = await journalFailedRun('mysql');

    expectNoDecodablePayload(line, PASSWORD);
  });

  it('answers the caller without the password either', async () => {
    const { body } = await journalFailedRun('mongo');

    expectNoDecodablePayload(JSON.stringify(body), PASSWORD);
  });
});

/**
 * And the other half of the property: the credential still reaches the tool.
 *
 * A proof of absence on its own passes just as well against a backup that has
 * silently stopped authenticating, which for a *backup* system is the failure
 * you discover at restore time. So this runs the emitted command for real,
 * against a `docker` that is faithful about the one thing under test — the
 * `-e NAME` pass-through copies a variable out of the client's environment and
 * nothing else crosses into the container.
 */
describe('DATABASE_PASSWORD_ENV, the credential the command does not carry', () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-backup-credential-')),
  );
  const binDir = path.join(root, 'bin');
  const stubLog = path.join(root, 'stub.log');
  let bash: string;

  /**
   * Stands in for `docker exec [-e NAME]… -i $CONTAINER_ID <shell> -c <program>`
   * and is faithful about the boundary: the program runs in a **fresh**
   * environment holding only the variables the command named with `-e`, so a
   * command that forgot the pass-through gets an unset variable here exactly as
   * it would on a real host. `PATH` and the log path are added back because
   * they are the harness, not the container.
   */
  const DOCKER_STUB = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const argv = process.argv.slice(2);
if (argv.shift() !== 'exec') process.exit(2);
const names = [];
while (argv[0] === '-e' || argv[0] === '-i') {
  if (argv.shift() === '-e') names.push(argv.shift());
}
argv.shift();
const shell = argv.shift();
if (argv.shift() !== '-c') process.exit(2);
const program = argv.shift();
const env = { PATH: process.env.PATH, STUB_LOG: process.env.STUB_LOG };
for (const name of names) {
  if (process.env[name] !== undefined) env[name] = process.env[name];
}
const { status } = spawnSync(process.env.STUB_SHELL, ['-c', program], {
  stdio: 'inherit',
  env,
});
process.exit(status === null ? 1 : status);
`;

  /** Records the argv it was handed and the pass-through variable it can see. */
  const TOOL_STUB = `#!/bin/sh
printf 'tool=%s\\n' "\${0##*/}" >> "$STUB_LOG"
for arg in "$@"; do printf 'arg=%s\\n' "$arg" >> "$STUB_LOG"; done
printf 'env=%s\\n' "\${${DATABASE_PASSWORD_ENV}-<unset>}" >> "$STUB_LOG"
exit 0
`;

  beforeAll(() => {
    fs.mkdirSync(binDir);
    const resolve = (name: string) =>
      spawnSync('/bin/sh', ['-c', `command -v ${name}`], {
        encoding: 'utf8',
      }).stdout.trim();
    bash = resolve('bash');
    // `set -o pipefail` is not POSIX, and the dump programs open with it.
    if (!bash) throw new Error('the executed shell needs bash');
    for (const name of ['gzip', 'node']) {
      const resolved = resolve(name);
      if (!resolved) throw new Error(`the executed shell needs ${name}`);
      fs.symlinkSync(resolved, path.join(binDir, name));
    }
    fs.writeFileSync(path.join(binDir, 'docker'), DOCKER_STUB, { mode: 0o755 });
    for (const tool of [
      'mysqldump',
      'mysql',
      'mariadb-dump',
      'mariadb',
      'mongodump',
      'mongorestore',
    ]) {
      fs.writeFileSync(path.join(binDir, tool), TOOL_STUB, { mode: 0o755 });
    }
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(stubLog, { force: true });
    fs.rmSync(path.join(root, 'pwned'), { force: true });
  });

  /** Runs a command the way the local branch of `execRclone` does — the
   * environment on the spawn, nothing of the value in the command. */
  const run = (command: string, env: Record<string, string>): string[] => {
    spawnSync('/bin/sh', ['-c', command], {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: binDir,
        STUB_LOG: stubLog,
        STUB_SHELL: bash,
        // What `buildBackupScript`/`buildRestoreScript` set from the container
        // search. Unset it and `$CONTAINER_ID` collapses to nothing, which
        // silently shifts the shell name into the container-id position.
        CONTAINER_ID: 'container-1',
        ...env,
      },
    });
    return fs.existsSync(stubLog)
      ? fs.readFileSync(stubLog, 'utf8').split('\n').filter(Boolean)
      : [];
  };

  describe.each(AUTHENTICATING)('%s', (engine) => {
    it.each(DIRECTIONS)('hands the tool the password on a %s', (direction) => {
      const { command, env } = BACKUP_COMMANDS[engine][direction](CREDENTIALS);

      const recorded = run(command, env);

      // The tool ran at all, and it was handed the credential. `endsWith`
      // rather than equality because two of the three flags take their value
      // attached — `--password=<value>`, `-p<value>` — and only mongo's is a
      // separate word.
      expect(recorded.some((line) => line.startsWith('tool='))).toBe(true);
      expect(
        recorded.some(
          (line) => line.startsWith('arg=') && line.endsWith(PASSWORD),
        ),
      ).toBe(true);
      // And it crossed the boundary the way the command asked it to.
      expect(recorded).toContain(`env=${PASSWORD}`);
    });

    it.each(DIRECTIONS)(
      'gets nothing on a %s when the pass-through is dropped',
      (direction) => {
        // The `-e` is what carries it across, and this is the falsification of
        // the test above: without the flag the variable is simply unset in the
        // container and the tool authenticates with an empty password.
        const { command, env } =
          BACKUP_COMMANDS[engine][direction](CREDENTIALS);

        const recorded = run(
          command.replace(`-e ${DATABASE_PASSWORD_ENV} `, ''),
          env,
        );

        expect(recorded).toContain('env=<unset>');
        expect(recorded).not.toContain(`arg=${PASSWORD}`);
      },
    );
  });

  it.each(AUTHENTICATING)(
    'hands %s a password a shell would otherwise interpret, unchanged',
    (engine) => {
      // The quoting proof H-37 made for the password's old home moves here with
      // it: the value now crosses two boundaries as data — the exec environment
      // and `docker exec -e` — and is expanded inside `"…"` by the container's
      // shell, which does not re-scan an expansion for substitutions.
      const payload = 'a$(touch pwned)`touch pwned`;touch pwned #';
      const { command, env } = BACKUP_COMMANDS[engine].dump({
        ...CREDENTIALS,
        databasePassword: payload,
      });

      const recorded = run(command, env);

      expect(fs.existsSync(path.join(root, 'pwned'))).toBe(false);
      expect(
        recorded.some(
          (line) => line.startsWith('arg=') && line.endsWith(payload),
        ),
      ).toBe(true);
    },
  );
});
