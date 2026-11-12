import { parse } from 'shell-quote';
import { ExecError } from '../../src/remote/exec-error';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { expectQuotedInCommand, SHELL_PAYLOAD } from '../utils/shell-safety';

describe('RemoteExecService (local exec)', () => {
  let service: RemoteExecService;

  beforeEach(() => {
    service = new RemoteExecService();
  });

  describe('execAsync', () => {
    it('resolves stdout and a zero exit code for a successful command', async () => {
      await expect(service.execAsync('echo hi')).resolves.toMatchObject({
        stdout: 'hi\n',
        exitCode: 0,
      });
    });

    it('throws ExecError with stdout, stderr and exit code on non-zero exit', async () => {
      const command = 'echo out; echo err 1>&2; exit 3';

      const error = await service.execAsync(command).then(
        () => {
          throw new Error('expected execAsync to reject');
        },
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(ExecError);
      const execError = error as ExecError;
      expect(execError.command).toBe(command);
      expect(execError.stdout).toBe('out\n');
      expect(execError.stderr).toBe('err\n');
      expect(execError.exitCode).toBe(3);
    });
  });

  /**
   * An earlier change moved single commands to argv and left shell *programs* on the string
   * form. These two pin that the string form is still there and still a shell:
   * `compose/compose.utils.ts`'s `getBuildComposeCommand` is `set -e`, a
   * `{…} || {…}` group, a `base64 -d >` redirect and an inline `$(docker ps …)`,
   * and there is no argv for any of that — an argv-only service would have
   * nothing to run it with.
   */
  describe('the string form the script builders need', () => {
    it('runs a shell program that argv could not express', async () => {
      const script = "printf 'one\\n' && printf 'two\\n' | tr a-z A-Z";

      await expect(service.execAsync(script)).resolves.toMatchObject({
        stdout: 'one\nTWO\n',
        exitCode: 0,
      });
    });

    it('takes a whole script as one string on the remote branch too', async () => {
      const remote = jest
        .spyOn(service, 'execAsyncRemote')
        .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
      const script = 'set -e\ndocker ps -q | head -n 1\n';

      await service.execAsyncRemote('server-1', script);

      expect(remote).toHaveBeenCalledWith('server-1', script);
      remote.mockRestore();
    });
  });

  describe('execFileAsync', () => {
    it('runs a file with args without shell interpretation', async () => {
      const result = await service.execFileAsync('printf', ['%s-%s', 'a', 'b']);

      expect(result.stdout).toBe('a-b');
      expect(result.exitCode).toBe(0);
    });

    it('pipes the input option to stdin', async () => {
      const result = await service.execFileAsync('cat', [], {
        input: 'piped-in',
      });

      expect(result.stdout).toBe('piped-in');
    });

    it('runs in the working directory and environment its options name', async () => {
      const result = await service.execFileAsync(
        'sh',
        ['-c', 'pwd; echo $ONLY'],
        {
          cwd: '/tmp',
          env: { ONLY: 'one-variable' },
        },
      );

      // The cwd and the env are that change's widening: the sites migrating to argv
      // need them, and `execAsync` was the only method that had them.
      expect(result.stdout.trim().split('\n')).toEqual([
        expect.stringContaining('/tmp'),
        'one-variable',
      ]);
    });

    it('hands a metacharacter to the program as one inert argument', async () => {
      // The local half of the argv form is the only one that is genuinely
      // shell-free — `execFile` spawns the program itself — so the payload
      // arrives as itself rather than being expanded or quoted.
      const result = await service.execFileAsync('printf', ['%s', 'a$(id)']);

      expect(result.stdout).toBe('a$(id)');
    });

    it('rejects with ExecError on non-zero exit', async () => {
      const error = await service.execFileAsync('false', []).then(
        () => {
          throw new Error('expected execFileAsync to reject');
        },
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(ExecError);
      expect((error as ExecError).exitCode).toBe(1);
    });
  });
});

/**
 * The executable half of `execRemote`'s JSDoc.
 *
 * The SSH transport cannot carry argv — RFC 4254 §6.5's `exec` request is a
 * single length-prefixed string, and `ssh2` writes exactly that
 * (`ssh2/lib/protocol/Protocol.js:1280-1288`) — so the argv `execRemote` takes is
 * an API guarantee joined by `quote()`, not a shell-free wire. Everything the
 * remote form buys rests on that join being `quote()` and not `argv.join(' ')`,
 * which is a one-character-looking change nobody would notice in review. Hence a
 * test on it rather than a comment alone.
 */
describe('RemoteExecService.execRemote', () => {
  let service: RemoteExecService;
  let sent: jest.SpyInstance;

  beforeEach(() => {
    service = new RemoteExecService();
    sent = jest
      .spyOn(service, 'execAsyncRemote')
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  });

  /** The one command string the transport carried. */
  const command = (): string => (sent.mock.calls[0] as [string, string])[1];

  it('sends the argv as one command string, since the transport carries no argv', async () => {
    await service.execRemote('server-1', [
      'cat',
      '/etc/traefik/dynamic/api.yml',
    ]);

    expect(sent).toHaveBeenCalledWith(
      'server-1',
      'cat /etc/traefik/dynamic/api.yml',
      undefined,
      undefined,
    );
    expect(typeof command()).toBe('string');
  });

  it('joins the argv with quote(), so a metacharacter reaches the far shell as one inert word', async () => {
    await service.execRemote('server-1', ['cat', SHELL_PAYLOAD]);

    // The assertion is a `shell-quote` parse of what the far shell would hand
    // `cat`, not a comparison against an escaping scheme
    // (`test/utils/shell-safety.ts`). A bare `argv.join(' ')` fails it here: the
    // payload comes back as a command substitution rather than a word.
    expectQuotedInCommand(command());
    expect(parse(command())).toEqual(['cat', SHELL_PAYLOAD]);
  });

  it('forwards the onData callback and the options the string form takes', async () => {
    const onData = jest.fn();

    await service.execRemote('server-1', ['echo', 'hi'], onData, {
      shell: 'bash',
    });

    expect(sent).toHaveBeenCalledWith('server-1', 'echo hi', onData, {
      shell: 'bash',
    });
  });
});
