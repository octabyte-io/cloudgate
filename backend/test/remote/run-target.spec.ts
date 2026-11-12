import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quote } from 'shell-quote';
import type { PtyChannelService } from '../../src/realtime/channels/pty-channel.service';
import type { SshChannelService } from '../../src/realtime/channels/ssh-channel.service';
import type { StreamChannel } from '../../src/realtime/channels/stream-channel';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import {
  RunTargetForwardError,
  runTargetOn,
} from '../../src/remote/run-target';
import { stackVmRemoteId } from '../../src/remote/stack-vm-remote';

const ok = { stdout: 'out', stderr: '', exitCode: 0 };

/**
 * Where a Compose stack runs, as its callers see it: one run target asked for
 * an exec and a forward, which goes over SSH for a stack on a Server and runs
 * on this machine for one on the platform host. What is pinned is which
 * transport each place reaches, not how the run target picks it.
 */
describe('runTargetOn', () => {
  const execAsync = jest.fn().mockResolvedValue(ok);
  const execAsyncRemote = jest.fn().mockResolvedValue(ok);
  const execRemote = jest.fn().mockResolvedValue(ok);
  const execFileAsync = jest.fn().mockResolvedValue(ok);
  const remoteExec = {
    execAsync,
    execAsyncRemote,
    execRemote,
    execFileAsync,
  } as unknown as RemoteExecService;

  const channel = {} as StreamChannel;
  const open = jest.fn().mockResolvedValue(channel);
  const spawn = jest.fn().mockReturnValue(channel);
  const channels = {
    ssh: { open } as unknown as SshChannelService,
    pty: { spawn } as unknown as PtyChannelService,
  };

  beforeEach(() => jest.clearAllMocks());

  describe('a stack on a Server', () => {
    const target = () => runTargetOn('server-1', { remoteExec, channels });

    it('runs a shell program on the Server over SSH and nothing on the platform host', async () => {
      const result = await target().exec('docker compose -p app stop');

      expect(result).toBe(ok);
      expect(execAsyncRemote).toHaveBeenCalledWith(
        'server-1',
        'docker compose -p app stop',
      );
      expect(execAsync).not.toHaveBeenCalled();
      expect(execFileAsync).not.toHaveBeenCalled();
    });

    it('runs one command on the Server over SSH', async () => {
      await target().exec(['cat', '/etc/cloudgate/compose/app/code/x.yml']);

      expect(execRemote).toHaveBeenCalledWith('server-1', [
        'cat',
        '/etc/cloudgate/compose/app/code/x.yml',
      ]);
      expect(execFileAsync).not.toHaveBeenCalled();
    });

    it('carries an environment and a cancel signal to the Server beside the program, not in it', async () => {
      const signal = new AbortController().signal;

      await target().exec('docker compose up -d', {
        env: { SECRET: 'v' },
        signal,
      });

      expect(execAsyncRemote).toHaveBeenCalledWith(
        'server-1',
        'docker compose up -d',
        undefined,
        { env: { SECRET: 'v' }, signal },
      );
    });

    it('forwards a terminal over an SSH channel, the argv quoted once', async () => {
      const argv = ['docker', 'exec', '-it', 'web-app', 'sh'];

      const forwarded = await target().forward(
        { argv },
        { pty: true, cols: 120, rows: 40 },
      );

      expect(forwarded).toBe(channel);
      expect(open).toHaveBeenCalledWith(
        { serverId: 'server-1' },
        { command: quote(argv), pty: true, cols: 120, rows: 40 },
      );
      expect(spawn).not.toHaveBeenCalled();
    });

    it('forwards a shell program over an SSH channel as it is written', async () => {
      await target().forward(
        { program: 'docker logs --follow web-app 2>&1 | grep x' },
        { pty: true, hostTerminal: { name: 'xterm-256color' } },
      );

      // The platform host's terminal options are the platform host's: a
      // Server is sent only what an SSH channel takes.
      expect(open).toHaveBeenCalledWith(
        { serverId: 'server-1' },
        { command: 'docker logs --follow web-app 2>&1 | grep x', pty: true },
      );
    });

    it('rejects a forward the Server would not open with the SSH failure in words', async () => {
      open.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

      const forwarding = target().forward({ argv: ['docker', 'ps'] });

      await expect(forwarding).rejects.toBeInstanceOf(RunTargetForwardError);
      await expect(forwarding).rejects.toThrow(
        'SSH error: connect ECONNREFUSED',
      );
    });

    it('names its Server as its place', () => {
      expect(target().serverId).toBe('server-1');
    });
  });

  describe('a stack on the platform host', () => {
    const target = () => runTargetOn(null, { remoteExec, channels });

    it('runs a shell program on this machine and dials no Server', async () => {
      const result = await target().exec('docker compose -p app stop');

      expect(result).toBe(ok);
      expect(execAsync).toHaveBeenCalledWith('docker compose -p app stop');
      expect(execAsyncRemote).not.toHaveBeenCalled();
      expect(execRemote).not.toHaveBeenCalled();
    });

    it('runs one command on this machine without a shell', async () => {
      await target().exec(['rm', '-rf', '/etc/cloudgate/compose/app']);

      expect(execFileAsync).toHaveBeenCalledWith('rm', [
        '-rf',
        '/etc/cloudgate/compose/app',
      ]);
      expect(execAsync).not.toHaveBeenCalled();
    });

    it("extends this process's environment rather than replacing it", async () => {
      const signal = new AbortController().signal;

      await target().exec('docker compose up -d', {
        env: { SECRET: 'v' },
        signal,
      });

      const [, options] = execAsync.mock.calls[0] as [
        string,
        { env: NodeJS.ProcessEnv; signal: AbortSignal },
      ];
      expect(options.env.SECRET).toBe('v');
      expect(options.env.PATH).toBe(process.env.PATH);
      expect(options.signal).toBe(signal);
    });

    it('forwards a terminal through a local pty at the window asked for', async () => {
      await target().forward(
        { argv: ['docker', 'exec', '-it', 'web-app', 'sh'] },
        { pty: true, cols: 120, rows: 40 },
      );

      expect(spawn).toHaveBeenCalledWith(
        'docker',
        ['exec', '-it', 'web-app', 'sh'],
        { cols: 120, rows: 40 },
      );
      expect(open).not.toHaveBeenCalled();
    });

    it("forwards a shell program through a local pty with the platform host's terminal options", async () => {
      await target().forward(
        { program: 'docker logs --follow web-app' },
        { pty: true, hostTerminal: { name: 'xterm-256color', cols: 80 } },
      );

      expect(spawn).toHaveBeenCalledWith(
        expect.any(String),
        ['-c', 'docker logs --follow web-app'],
        { name: 'xterm-256color', cols: 80 },
      );
    });

    it('has no Server as its place', () => {
      expect(target().serverId).toBeNull();
    });
  });

  describe('a stack on its Stack VM', () => {
    const stack = {
      composeId: 'stack-1',
      serverId: null,
      cloudAccountId: 'account-1',
    };
    const target = () => runTargetOn(stack, { remoteExec, channels });
    const remoteId = stackVmRemoteId('stack-1');

    it('runs a shell program on its Stack VM through the remote layer, never on the platform host', async () => {
      const signal = new AbortController().signal;

      await target().exec('docker compose up -d', {
        env: { SECRET: 'v' },
        signal,
      });

      expect(execAsyncRemote).toHaveBeenCalledWith(
        remoteId,
        'docker compose up -d',
        undefined,
        { env: { SECRET: 'v' }, signal },
      );
      expect(execAsync).not.toHaveBeenCalled();
      expect(execFileAsync).not.toHaveBeenCalled();
    });

    it('runs one command on its Stack VM, the argv quoted by the remote layer', async () => {
      await target().exec(['cat', '/etc/cloudgate/compose/app/code/x.yml']);

      expect(execRemote).toHaveBeenCalledWith(remoteId, [
        'cat',
        '/etc/cloudgate/compose/app/code/x.yml',
      ]);
      expect(execFileAsync).not.toHaveBeenCalled();
    });

    it('forwards a terminal over an SSH channel to its Stack VM', async () => {
      const argv = ['docker', 'exec', '-it', 'web-app', 'sh'];

      await target().forward({ argv }, { pty: true, cols: 100, rows: 30 });

      expect(open).toHaveBeenCalledWith(
        { serverId: remoteId },
        { command: quote(argv), pty: true, cols: 100, rows: 30 },
      );
      expect(spawn).not.toHaveBeenCalled();
    });

    it('is the Stack VM for the bare id the remote layer reaches it by too', async () => {
      await runTargetOn(remoteId, { remoteExec, channels }).exec(['true']);

      expect(execRemote).toHaveBeenCalledWith(remoteId, ['true']);
      expect(runTargetOn(remoteId, { remoteExec }).serverId).toBeNull();
    });

    it('has no Server, and roots its paths as a remote place does', () => {
      expect(target().serverId).toBeNull();
      expect(target().remoteId).toBe(remoteId);
    });

    it("writes a program's output into the Deployment log on the platform host, not on the Stack VM", async () => {
      const logPath = join(mkdtempSync(join(tmpdir(), 'run-target-')), 'd.log');
      writeFileSync(logPath, 'first\n');
      execAsyncRemote.mockImplementationOnce(
        (_id: string, _cmd: string, onData: (chunk: string) => void) => {
          onData('Pulling web\n');
          onData('Started\n');
          return Promise.resolve(ok);
        },
      );

      await target().execToLog('docker compose up -d', logPath, {
        env: { SECRET: 'v' },
      });

      const [id, command, , options] = execAsyncRemote.mock.calls[0] as [
        string,
        string,
        unknown,
        { env: Record<string, string> },
      ];
      expect(id).toBe(remoteId);
      expect(command).not.toContain(logPath);
      expect(options.env).toEqual({ SECRET: 'v' });
      expect(readFileSync(logPath, 'utf8')).toBe(
        'first\nPulling web\nStarted\n',
      );
    });
  });

  describe("a stack's row", () => {
    it('on a Server runs there over plain SSH', async () => {
      const row = {
        composeId: 'c',
        serverId: 'server-1',
        cloudAccountId: null,
      };

      await runTargetOn(row, { remoteExec }).exec(['true']);

      expect(execRemote).toHaveBeenCalledWith('server-1', ['true']);
    });

    it('on the platform host runs here', async () => {
      const row = { composeId: 'c', serverId: null, cloudAccountId: null };

      await runTargetOn(row, { remoteExec }).exec(['true']);

      expect(execFileAsync).toHaveBeenCalledWith('true', []);
    });
  });

  describe("a program's Deployment log on a Server", () => {
    it('is appended on the Server by the program itself', async () => {
      await runTargetOn('server-1', { remoteExec }).execToLog(
        'docker compose up -d',
        '/etc/cloudgate/logs/app/d.log',
      );

      expect(execAsyncRemote).toHaveBeenCalledWith(
        'server-1',
        '(docker compose up -d) >> /etc/cloudgate/logs/app/d.log 2>&1 < /dev/null',
      );
    });
  });
});
