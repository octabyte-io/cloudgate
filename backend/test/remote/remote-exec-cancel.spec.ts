import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ExecError } from '../../src/remote/exec-error';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ServerKeyProvider } from '../../src/remote/server-key.provider';
import { unverifiedHostKey } from '../../src/remote/host-key';

/**
 * A build the queue has started can be stopped. `ExecOptions.signal` /
 * `RemoteExecOptions.signal` is the handle — aborting it kills the program's
 * whole process group (locally) or the remote shell's session (over SSH) and
 * rejects at once, so the queue slot the build held is freed.
 *
 * The local half runs real processes: the point is that a pipeline's
 * *grandchildren* (a `git clone` under a subshell under `sh -c`) die too, which
 * `child.kill()` on the shell alone does not do.
 */

// ssh2 is a system boundary — mocked for the remote half, as in
// `remote-exec-remote.spec.ts`. The local half never touches it.
interface FakeChannel extends EventEmitter {
  stderr: EventEmitter;
  end: (data?: string) => void;
}
const ssh = {
  commands: [] as string[],
  channels: [] as FakeChannel[],
  ended: 0,
};
jest.mock('ssh2', () => {
  class Client extends EventEmitter {
    exec(command: string, cb: (err: undefined, stream: unknown) => void) {
      ssh.commands.push(command);
      const stream = new EventEmitter() as FakeChannel;
      stream.stderr = new EventEmitter();
      stream.end = () => undefined;
      (stream as unknown as { resume: () => unknown }).resume = () => stream;
      ssh.channels.push(stream);
      cb(undefined, stream);
      // The kill request finishes at once; the build channel never does on
      // its own — that is the hang being cancelled.
      if (command.startsWith('kill ')) {
        process.nextTick(() => stream.emit('close', 0));
      }
    }
    connect() {
      process.nextTick(() => this.emit('ready'));
      return this;
    }
    end() {
      ssh.ended += 1;
    }
  }
  return { Client };
});

const keyProvider: ServerKeyProvider = {
  getConnection: () =>
    Promise.resolve({
      host: '203.0.113.10',
      port: 22,
      username: 'deploy',
      privateKey: 'fake',
      hostKey: unverifiedHostKey(),
    }),
};

/** Pids of live processes whose command line contains `needle`. */
const processesMatching = (needle: string): string[] => {
  try {
    return execFileSync('pgrep', ['-f', needle], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
};

const until = async (check: () => boolean, ms = 5000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
};

const rejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );

describe('RemoteExecService', () => {
  describe('a local program under an abort signal', () => {
    const service = new RemoteExecService();

    it('kills the whole process group, grandchildren included, and rejects at once', async () => {
      // A number nothing else on the machine is sleeping for.
      const marker = `${44_700 + Math.floor(Math.random() * 99)}`;
      const controller = new AbortController();
      // The shape a build takes: `sh -c` → a subshell → a long-running tool,
      // plus a background job, so both a grandchild and a sibling must go.
      const running = service.execAsync(
        `(sleep ${marker} & sleep ${marker}; wait) >/dev/null 2>&1 < /dev/null`,
        { signal: controller.signal },
      );
      expect(
        await until(() => processesMatching(`^sleep ${marker}$`).length === 2),
      ).toBe(true);

      const started = Date.now();
      controller.abort();
      const error = await rejection(running);

      expect(error).toBeInstanceOf(ExecError);
      expect((error as ExecError).message).toContain('cancelled');
      expect(Date.now() - started).toBeLessThan(2000);
      expect(
        await until(() => processesMatching(`^sleep ${marker}$`).length === 0),
      ).toBe(true);
    });

    it('does not start a program whose signal is already aborted', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cancel-'));
      const touched = path.join(dir, 'ran');
      const controller = new AbortController();
      controller.abort();

      await expect(
        service.execAsync(`touch ${touched}`, { signal: controller.signal }),
      ).rejects.toBeInstanceOf(ExecError);

      expect(fs.existsSync(touched)).toBe(false);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('reports success and failure exactly as the unsignalled form does', async () => {
      const { signal } = new AbortController();

      await expect(
        service.execAsync('echo hi', { signal }),
      ).resolves.toMatchObject({ stdout: 'hi\n', stderr: '', exitCode: 0 });

      const command = 'echo out; echo err 1>&2; exit 3';
      const [withSignal, without] = await Promise.all([
        rejection(service.execAsync(command, { signal })),
        rejection(service.execAsync(command)),
      ]);
      for (const error of [withSignal, without]) {
        expect(error).toBeInstanceOf(ExecError);
        expect(error).toMatchObject({
          command,
          stdout: 'out\n',
          stderr: 'err\n',
          exitCode: 3,
        });
      }
      expect((withSignal as ExecError).message).toBe(
        (without as ExecError).message,
      );
    });

    it('passes the environment through', async () => {
      const { signal } = new AbortController();
      await expect(
        service.execAsync('printf %s "$CG_PROBE"', {
          signal,
          env: { ...process.env, CG_PROBE: 'seen' },
        }),
      ).resolves.toMatchObject({ stdout: 'seen' });
    });
  });

  describe('a remote program under an abort signal', () => {
    const service = new RemoteExecService(keyProvider);

    beforeEach(() => {
      ssh.commands = [];
      ssh.channels = [];
      ssh.ended = 0;
    });

    /** Resolves once the build's channel is open. */
    const channelOpen = () => until(() => ssh.channels.length > 0);

    it('kills the remote session by the process group its shell reports, closes the connection and rejects', async () => {
      const controller = new AbortController();
      const seen: string[] = [];
      const running = service.execAsyncRemote(
        'server-1',
        'git clone http://192.0.2.1/x/hang.git',
        (chunk) => seen.push(chunk),
        { signal: controller.signal },
      );
      await channelOpen();
      // The session leader's pid is announced before the program runs.
      expect(ssh.commands[0]).toMatch(/\$\$/);
      expect(ssh.commands[0]).toContain(
        'git clone http://192.0.2.1/x/hang.git',
      );
      ssh.channels[0].stderr.emit('data', 'cg-pgid:4242\nCloning into');

      controller.abort();
      const error = await rejection(running);

      expect(error).toBeInstanceOf(ExecError);
      expect((error as ExecError).message).toContain('cancelled');
      expect((error as ExecError).command).toBe(
        'git clone http://192.0.2.1/x/hang.git',
      );
      expect(await until(() => ssh.commands.length === 2)).toBe(true);
      expect(ssh.commands[1]).toBe('kill -s KILL -- -4242');
      expect(await until(() => ssh.ended > 0)).toBe(true);
      // The announcement is plumbing: it never reaches the log or the error.
      expect(seen.join('')).toBe('Cloning into');
      expect((error as ExecError).stderr).toBe('Cloning into');
    });

    it('kills a session whose pid arrives only after the cancel', async () => {
      const controller = new AbortController();
      const running = service.execAsyncRemote(
        'server-1',
        'sleep 600',
        undefined,
        {
          signal: controller.signal,
        },
      );
      await channelOpen();

      controller.abort();
      await rejection(running);
      expect(ssh.commands).toHaveLength(1);

      ssh.channels[0].stderr.emit('data', 'cg-pgid:');
      ssh.channels[0].stderr.emit('data', '777\n');
      expect(await until(() => ssh.commands.length === 2)).toBe(true);
      expect(ssh.commands[1]).toBe('kill -s KILL -- -777');
    });

    it('sends an unsignalled command exactly as before', async () => {
      const running = service.execAsyncRemote('server-1', 'echo hi');
      await channelOpen();
      ssh.channels[0].stderr.emit('data', 'cg-pgid:1\n');
      ssh.channels[0].emit('close', 0);
      await expect(running).resolves.toMatchObject({ stderr: 'cg-pgid:1\n' });
      expect(ssh.commands).toEqual(['echo hi']);
    });
  });
});
