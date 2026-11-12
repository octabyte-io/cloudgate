import { ExecError } from '../../src/remote/exec-error';
import { ReachabilityMemo } from '../../src/remote/reachability-memo';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ExecResult } from '../../src/remote/remote-exec.service';

/**
 * A Delete's teardown steps each dialled the Server on their own, so on
 * an unreachable one a forced Delete spent every step's connection attempt in
 * turn — 200 s, measured, against the console proxy's 240 s. The memo is the
 * per-Delete answer: the first failure to *connect* marks that Server, and
 * every later call to it fails at once with the same error.
 */
const ok = { stdout: '', stderr: '', exitCode: 0 };

/** What `RemoteExecService` rejects with when ssh2 never got a session: the
 * client's `error` event, marked where it is raised (`connectionFailed`). */
const refused = (serverId: string) =>
  new ExecError('SSH connection error: connect ECONNREFUSED 203.0.113.7:1', {
    command: 'docker service rm web-app',
    serverId,
    connectionFailed: true,
  });

/** A remote program whose output outgrew `maxBuffer`: it ran, on a Server
 * that answered, and carries no exit code because the call closed it. */
const outgrewMaxBuffer = (serverId: string) =>
  new ExecError('Remote command stdout exceeded maxBuffer', {
    command: 'docker logs web-app',
    serverId,
    originalError: new RangeError('stdout maxBuffer length exceeded'),
  });

/** A remote program killed by a signal: ssh2's channel `close` reports a
 * `null` code, so this error has no numeric exit code either. */
const killedBySignal = (serverId: string) =>
  new ExecError('Remote command failed with exit code null', {
    command: 'docker service rm web-app',
    serverId,
    exitCode: null as unknown as number,
  });

/** A command that ran on the Server and exited non-zero. */
const exitedNonZero = (serverId: string) =>
  new ExecError('Remote command failed with exit code 1', {
    command: 'rm -rf /etc/cloudgate/applications/web-app',
    serverId,
    exitCode: 1,
  });

const inner = () => {
  const double = {
    execAsyncRemote: jest
      .fn<Promise<ExecResult>, [string, string]>()
      .mockResolvedValue(ok),
    execRemote: jest
      .fn<Promise<ExecResult>, [string, string[]]>()
      .mockResolvedValue(ok),
    execAsync: jest.fn<Promise<ExecResult>, [string]>().mockResolvedValue(ok),
    execFileAsync: jest
      .fn<Promise<ExecResult>, [string, string[]]>()
      .mockResolvedValue(ok),
  };
  return {
    double,
    memo: new ReachabilityMemo(double),
  };
};

describe('ReachabilityMemo', () => {
  it('dials an unreachable Server once, and fails every later call to it with the same error', async () => {
    const { double, memo } = inner();
    const error = refused('srv-1');
    double.execAsyncRemote.mockRejectedValue(error);
    double.execRemote.mockRejectedValue(error);

    await expect(
      memo.execAsyncRemote('srv-1', 'docker service rm web-app'),
    ).rejects.toBe(error);
    await expect(
      memo.execRemote('srv-1', [
        'rm',
        '-rf',
        '/etc/cloudgate/applications/web-app',
      ]),
    ).rejects.toBe(error);
    await expect(
      memo.guard('srv-1', () => Promise.resolve('never run')),
    ).rejects.toBe(error);

    expect(double.execAsyncRemote).toHaveBeenCalledTimes(1);
    expect(double.execRemote).not.toHaveBeenCalled();
  });

  it('keeps dialling a Server whose command ran and exited non-zero', async () => {
    const { double, memo } = inner();
    double.execRemote.mockRejectedValueOnce(exitedNonZero('srv-1'));

    await expect(
      memo.execRemote('srv-1', [
        'rm',
        '-rf',
        '/etc/cloudgate/applications/web-app',
      ]),
    ).rejects.toBeInstanceOf(ExecError);
    await expect(
      memo.execAsyncRemote('srv-1', 'docker service rm web-app'),
    ).resolves.toEqual(ok);

    expect(double.execAsyncRemote).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['whose output outgrew maxBuffer', outgrewMaxBuffer],
    ['killed by a signal', killedBySignal],
  ])(
    'keeps dialling a Server whose program ran and was %s, though it carries no exit code',
    async (_, failure) => {
      const { double, memo } = inner();
      double.execAsyncRemote.mockRejectedValueOnce(failure('srv-1'));

      await expect(
        memo.execAsyncRemote('srv-1', 'docker logs web-app'),
      ).rejects.toBeInstanceOf(ExecError);
      await expect(memo.execAsyncRemote('srv-1', 'true')).resolves.toEqual(ok);

      expect(double.execAsyncRemote).toHaveBeenCalledTimes(2);
    },
  );

  it('keeps dialling a Server when a rejection did not come from the exec layer', async () => {
    const { double, memo } = inner();
    double.execAsyncRemote.mockRejectedValueOnce(new Error('no such server'));

    await expect(memo.execAsyncRemote('srv-1', 'true')).rejects.toThrow(
      'no such server',
    );
    await expect(memo.execAsyncRemote('srv-1', 'true')).resolves.toEqual(ok);
  });

  it('marks only the Server it could not reach', async () => {
    const { double, memo } = inner();
    double.execAsyncRemote.mockImplementation((serverId: string) =>
      serverId === 'srv-1'
        ? Promise.reject(refused(serverId))
        : Promise.resolve(ok),
    );

    await expect(memo.execAsyncRemote('srv-1', 'true')).rejects.toBeInstanceOf(
      ExecError,
    );
    await expect(memo.execAsyncRemote('srv-2', 'true')).resolves.toEqual(ok);
    await expect(memo.execAsyncRemote('srv-2', 'true')).resolves.toEqual(ok);

    expect(double.execAsyncRemote.mock.calls.map(([id]) => id)).toEqual([
      'srv-1',
      'srv-2',
      'srv-2',
    ]);
  });

  it('never marks the platform host', async () => {
    const { double, memo } = inner();
    const spawnFailed = new ExecError('Command execution error: spawn ENOENT', {
      command: 'docker',
    });
    double.execFileAsync.mockRejectedValueOnce(spawnFailed);
    double.execAsync.mockRejectedValueOnce(spawnFailed);

    await expect(memo.execFileAsync('docker', ['ps'])).rejects.toBe(
      spawnFailed,
    );
    await expect(memo.execFileAsync('docker', ['ps'])).resolves.toEqual(ok);
    await expect(memo.execAsync('docker ps')).rejects.toBe(spawnFailed);
    await expect(memo.execAsync('docker ps')).resolves.toEqual(ok);
    await expect(
      memo.guard(null, () => Promise.reject(spawnFailed)),
    ).rejects.toBe(spawnFailed);
    await expect(memo.guard(null, () => Promise.resolve(1))).resolves.toBe(1);
  });

  it('remembers nothing across instances, so the next Delete dials again', async () => {
    const { double, memo } = inner();
    double.execAsyncRemote.mockRejectedValueOnce(refused('srv-1'));
    await expect(memo.execAsyncRemote('srv-1', 'true')).rejects.toBeInstanceOf(
      ExecError,
    );

    const next = new ReachabilityMemo(double);
    await expect(next.execAsyncRemote('srv-1', 'true')).resolves.toEqual(ok);
  });

  it('marks a Server from a guarded call, such as the Traefik writer’s own', async () => {
    const { double, memo } = inner();

    await expect(
      memo.guard('srv-1', () => Promise.reject(refused('srv-1'))),
    ).rejects.toBeInstanceOf(ExecError);
    await expect(memo.execAsyncRemote('srv-1', 'true')).rejects.toBeInstanceOf(
      ExecError,
    );

    expect(double.execAsyncRemote).not.toHaveBeenCalled();
  });

  /**
   * The memo subclasses `RemoteExecService` so every helper takes it
   * unchanged, but it is constructed without a `ServerKeyProvider`: a method
   * it does not override runs the unconfigured base, which dials nothing
   * through the memo and fails outright for a Server. So a method added to
   * `RemoteExecService` fails here until the memo overrides it. A private
   * helper the base gains is on its prototype too at runtime; list it in
   * `notEntryPoints` with the reason it is never called from outside.
   */
  it('overrides every method RemoteExecService has, so none reaches the unconfigured base', () => {
    const notEntryPoints = new Set<string>(['constructor']);
    const baseMethods = Object.getOwnPropertyNames(
      RemoteExecService.prototype,
    ).filter((name) => !notEntryPoints.has(name));

    const notOverridden = baseMethods.filter(
      (name) => !Object.hasOwn(ReachabilityMemo.prototype, name),
    );

    expect(baseMethods.length).toBeGreaterThan(0);
    expect(notOverridden).toEqual([]);
  });
});
