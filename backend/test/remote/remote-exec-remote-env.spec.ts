import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { ExecError } from '../../src/remote/exec-error';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type {
  ServerConnection,
  ServerKeyProvider,
} from '../../src/remote/server-key.provider';
import { unverifiedHostKey } from '../../src/remote/host-key';

interface ExecCall {
  /** What the remote host would show in `ps` — the argv of the login shell. */
  command: string;
  /** The `env` requests the client made on the channel. */
  requestedEnv: Record<string, string>;
}

const execCalls: ExecCall[] = [];

/**
 * What OpenSSH accepts from a client's `env` channel requests: nothing, unless
 * `AcceptEnv` names it, and the config every distro ships names only the
 * locale. Anything else is logged and dropped. A remote environment therefore
 * cannot travel as a channel request — see the fake below.
 */
const ACCEPT_ENV = /^(?:LANG|LC_[A-Z_]+)$/;

/**
 * ssh2 is a system boundary — mocked. This fake is a loopback sshd rather than
 * a recorder: it runs the requested command through a local `/bin/sh -c`, the
 * way sshd runs it through the account's login shell, with stdin wired to the
 * channel. So these tests exercise the real shell — quoting, `export`, exit
 * status — instead of asserting on a string we composed ourselves.
 */
jest.mock('ssh2', () => {
  type Callback = (err: Error | undefined, stream: unknown) => void;

  class Client extends EventEmitter {
    exec(
      command: string,
      optionsOrCallback: { env?: Record<string, string> } | Callback,
      maybeCallback?: Callback,
    ) {
      const options =
        typeof optionsOrCallback === 'function'
          ? {}
          : (optionsOrCallback ?? {});
      const callback =
        typeof optionsOrCallback === 'function'
          ? optionsOrCallback
          : (maybeCallback as Callback);

      const requestedEnv = options.env ?? {};
      execCalls.push({ command, requestedEnv });

      const accepted = Object.fromEntries(
        Object.entries(requestedEnv).filter(([name]) => ACCEPT_ENV.test(name)),
      );
      // A fresh login environment, not this process's: a variable the command
      // can read is one that genuinely arrived over the connection.
      const child = spawn('/bin/sh', ['-c', command], {
        env: { PATH: process.env.PATH ?? '', ...accepted },
      });

      // The parts of ssh2's ClientChannel the service uses: data / close /
      // stderr.data to read, write / end to feed the remote stdin.
      const stream = new EventEmitter() as EventEmitter & {
        stderr: EventEmitter;
        write: (chunk: string) => boolean;
        end: (chunk?: string) => unknown;
      };
      stream.stderr = new EventEmitter();
      stream.write = (chunk: string) => child.stdin?.write(chunk) ?? false;
      stream.end = (chunk?: string) => {
        if (chunk !== undefined) child.stdin?.write(chunk);
        child.stdin?.end();
        return stream;
      };

      child.stdout?.on('data', (data: Buffer) =>
        stream.emit('data', data.toString()),
      );
      child.stderr?.on('data', (data: Buffer) =>
        stream.stderr.emit('data', data.toString()),
      );
      child.on('close', (code: number | null) =>
        stream.emit('close', code ?? 0),
      );

      callback(undefined, stream);
      return this;
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

const SECRET = 'wJalrXUtnFEMI-example-secret-key';
const ACCESS_KEY = 'AKIAEXAMPLEACCESSKEY';

const s3Env = {
  RCLONE_S3_ACCESS_KEY_ID: ACCESS_KEY,
  RCLONE_S3_SECRET_ACCESS_KEY: SECRET,
};

const keyProvider: ServerKeyProvider = {
  getConnection: () => Promise.resolve(CONNECTION),
};

// a remote rclone probe has to hand the credentials to rclone
// without putting them anywhere the remote host publishes them.
describe('RemoteExecService.execAsyncRemote environment (loopback sshd)', () => {
  let service: RemoteExecService;

  beforeEach(() => {
    execCalls.length = 0;
    service = new RemoteExecService(keyProvider);
  });

  it('runs the remote command with the environment it was given', async () => {
    const result = await service.execAsyncRemote(
      'server-1',
      'printf %s "$RCLONE_S3_SECRET_ACCESS_KEY"',
      undefined,
      { env: s3Env },
    );

    expect(result.stdout).toBe(SECRET);
    expect(result.exitCode).toBe(0);
  });

  it('keeps the environment out of the command the remote host runs', async () => {
    await service.execAsyncRemote('server-1', 'echo probing', undefined, {
      env: s3Env,
    });

    // The command string is the argv of the shell sshd starts, which every
    // other user on that host can read out of `ps`.
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].command).not.toContain(SECRET);
    expect(execCalls[0].command).not.toContain(ACCESS_KEY);
  });

  it('carries a value that a shell would otherwise interpret, unchanged', async () => {
    const awkward = `it's a "secret" $HOME \`whoami\` \\ & ; end`;

    const result = await service.execAsyncRemote(
      'server-1',
      'printf %s "$AWKWARD"',
      undefined,
      { env: { AWKWARD: awkward } },
    );

    expect(result.stdout).toBe(awkward);
  });

  it('streams output to onData and reports the remote exit code, environment or not', async () => {
    const chunks: string[] = [];

    const error = await service
      .execAsyncRemote(
        'server-1',
        'echo partial; exit 7',
        (data) => chunks.push(data),
        { env: s3Env },
      )
      .then(
        () => {
          throw new Error('expected execAsyncRemote to reject');
        },
        (e: unknown) => e,
      );

    expect(chunks.join('')).toBe('partial\n');
    expect(error).toBeInstanceOf(ExecError);
    const execError = error as ExecError;
    expect(execError.exitCode).toBe(7);
    // The failure names the command the caller asked for, not the shell that
    // was arranged to carry it.
    expect(execError.command).toBe('echo partial; exit 7');
  });

  it('runs the command directly when no environment is given', async () => {
    const result = await service.execAsyncRemote('server-1', 'echo direct');

    expect(execCalls[0].command).toBe('echo direct');
    expect(result.stdout).toBe('direct\n');
  });

  it('reads the script with the shell the caller named', async () => {
    // the database backup script opens with `set -eo pipefail`, so
    // it has to be read by bash and not by whatever `/bin/sh` happens to be on
    // the Server. The default stays `sh`, which is all a POSIX command needs.
    const result = await service.execAsyncRemote(
      'server-1',
      'set -o pipefail; printf %s "$RCLONE_S3_SECRET_ACCESS_KEY" | cat',
      undefined,
      { env: s3Env, shell: '/bin/bash' },
    );

    expect(result.stdout).toBe(SECRET);
    expect(execCalls[0].command).toBe('/bin/bash -s');
    // Still nothing of the environment in the argv the remote host publishes.
    expect(execCalls[0].command).not.toContain(SECRET);
  });

  it('reads the script with sh when no shell is named', async () => {
    await service.execAsyncRemote('server-1', 'echo hi', undefined, {
      env: s3Env,
    });

    expect(execCalls[0].command).toBe('sh -s');
  });

  it('refuses an environment name a shell could not safely take', async () => {
    await expect(
      service.execAsyncRemote('server-1', 'echo hi', undefined, {
        env: { 'NOT A NAME': 'x' },
      }),
    ).rejects.toBeInstanceOf(ExecError);
  });
});
