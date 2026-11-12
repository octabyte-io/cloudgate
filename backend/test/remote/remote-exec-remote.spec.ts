import { EventEmitter } from 'node:events';
import { ExecError, isConnectionFailure } from '../../src/remote/exec-error';
import {
  isMaxBufferExceeded,
  RemoteExecService,
} from '../../src/remote/remote-exec.service';
import type {
  ServerConnection,
  ServerKeyProvider,
} from '../../src/remote/server-key.provider';
import { unverifiedHostKey } from '../../src/remote/host-key';

type Scenario =
  // `null` is what ssh2 reports for a program killed by a signal.
  | { kind: 'success'; stdoutChunks: string[]; exitCode?: number | null }
  | { kind: 'auth-error' };

interface MockState {
  scenario: Scenario;
  connectConfigs: Record<string, unknown>[];
}

const mockState: MockState = {
  scenario: { kind: 'success', stdoutChunks: [] },
  connectConfigs: [],
};

// ssh2 is a system boundary — mocked. The fake Client honors the parts of
// the ssh2 API the service uses: once('ready') / on('error') / connect /
// exec(cmd, cb) with a stream exposing data / close / stderr.data.
jest.mock('ssh2', () => {
  class Client extends EventEmitter {
    exec(
      _command: string,
      cb: (err: Error | undefined, stream: unknown) => void,
    ) {
      const scenario = mockState.scenario;
      const stream = new EventEmitter() as EventEmitter & {
        stderr: EventEmitter;
      };
      stream.stderr = new EventEmitter();
      cb(undefined, stream);
      process.nextTick(() => {
        if (scenario.kind !== 'success') return;
        for (const chunk of scenario.stdoutChunks) {
          stream.emit('data', chunk);
        }
        stream.emit(
          'close',
          scenario.exitCode === undefined ? 0 : scenario.exitCode,
        );
      });
    }

    connect(config: Record<string, unknown>) {
      mockState.connectConfigs.push(config);
      process.nextTick(() => {
        if (mockState.scenario.kind === 'auth-error') {
          const err = new Error(
            'All configured authentication methods failed',
          ) as Error & { level: string };
          err.level = 'client-authentication';
          this.emit('error', err);
        } else {
          this.emit('ready');
        }
      });
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

const getConnection = jest.fn<Promise<ServerConnection>, [string]>();
const keyProvider: ServerKeyProvider = { getConnection };

describe('RemoteExecService.execAsyncRemote (ssh2 mocked)', () => {
  let service: RemoteExecService;

  beforeEach(() => {
    mockState.scenario = { kind: 'success', stdoutChunks: [] };
    mockState.connectConfigs = [];
    jest.clearAllMocks();
    getConnection.mockResolvedValue(CONNECTION);
    service = new RemoteExecService(keyProvider);
  });

  it('connects with the connection details resolved for the server', async () => {
    mockState.scenario = { kind: 'success', stdoutChunks: ['ok\n'] };

    await service.execAsyncRemote('server-1', 'docker ps');

    expect(getConnection).toHaveBeenCalledWith('server-1');
    expect(mockState.connectConfigs).toHaveLength(1);
    expect(mockState.connectConfigs[0]).toMatchObject({
      host: CONNECTION.host,
      port: CONNECTION.port,
      username: CONNECTION.username,
      privateKey: CONNECTION.privateKey,
      // The host key is checked by the connection's own check (ADR-0074).
      hostVerifier: CONNECTION.hostKey.verifier,
    });
  });

  it('streams output chunks to onData and resolves the full stdout', async () => {
    mockState.scenario = {
      kind: 'success',
      stdoutChunks: ['chunk-1\n', 'chunk-2\n'],
    };
    const chunks: string[] = [];

    const result = await service.execAsyncRemote(
      'server-1',
      'docker ps',
      (data) => chunks.push(data),
    );

    expect(chunks).toEqual(['chunk-1\n', 'chunk-2\n']);
    expect(result.stdout).toBe('chunk-1\nchunk-2\n');
    expect(result.exitCode).toBe(0);
  });

  it('surfaces a clear ExecError when SSH authentication fails', async () => {
    mockState.scenario = { kind: 'auth-error' };

    const error = await service.execAsyncRemote('server-1', 'docker ps').then(
      () => {
        throw new Error('expected execAsyncRemote to reject');
      },
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ExecError);
    const execError = error as ExecError;
    expect(execError.serverId).toBe('server-1');
    expect(execError.message).toMatch(/authentication|ssh key/i);
    // The one fact a Delete's ReachabilityMemo marks a Server on.
    expect(isConnectionFailure(error)).toBe(true);
  });

  // A program killed by a signal ran on a Server that answered, though
  // its error carries no numeric exit code.
  it('does not call a program killed by a signal a connection failure', async () => {
    mockState.scenario = { kind: 'success', stdoutChunks: [], exitCode: null };

    const error = await service.execAsyncRemote('server-1', 'sleep 60').then(
      () => {
        throw new Error('expected execAsyncRemote to reject');
      },
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ExecError);
    expect(isConnectionFailure(error)).toBe(false);
  });

  // ssh2 collects without limit, so the cap `ExecOptions.maxBuffer`
  // gives the local branch is ours to enforce on this one.
  it('rejects with the overflow isMaxBufferExceeded recognizes once stdout outgrows maxBuffer', async () => {
    mockState.scenario = {
      kind: 'success',
      stdoutChunks: ['12345', '67890', 'more'],
    };

    const error = await service
      .execAsyncRemote('server-1', 'tail -n 500 log', undefined, {
        maxBuffer: 8,
      })
      .then(
        () => {
          throw new Error('expected execAsyncRemote to reject');
        },
        (e: unknown) => e,
      );

    expect(isMaxBufferExceeded(error)).toBe(true);
    expect((error as ExecError).serverId).toBe('server-1');
    expect(isConnectionFailure(error)).toBe(false);
  });

  it('resolves output that fits maxBuffer exactly, and is not an overflow', async () => {
    mockState.scenario = { kind: 'success', stdoutChunks: ['1234', '5678'] };

    const result = await service.execAsyncRemote(
      'server-1',
      'tail -n 500 log',
      undefined,
      { maxBuffer: 8 },
    );

    expect(result.stdout).toBe('12345678');
    expect(isMaxBufferExceeded(new ExecError('failed', { command: 'x' }))).toBe(
      false,
    );
  });
});
