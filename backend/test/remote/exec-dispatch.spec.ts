import { quote } from 'shell-quote';
import { execOnServer } from '../../src/remote/exec-dispatch';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import { expectQuotedInCommand, SHELL_PAYLOAD } from '../utils/shell-safety';
import { servicePresenceProbe } from '../utils/workload-presence-probe';

const ok = { stdout: '', stderr: '', exitCode: 0 };

/**
 * The four arms, one per (shape × host). What is worth pinning is not the
 * plumbing but *which method each shape reaches*: argv must not fall back to a
 * shell locally, and a script must not be handed to a method that would word it
 * as a single program name.
 */
describe('execOnServer', () => {
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

  beforeEach(() => jest.clearAllMocks());

  describe('argv', () => {
    it('runs a single command through the shell-free local method when there is no serverId', async () => {
      await execOnServer(remoteExec, null, ['rm', '-rf', SHELL_PAYLOAD]);

      expect(execFileAsync).toHaveBeenCalledWith('rm', ['-rf', SHELL_PAYLOAD]);
      // Nothing reached a local shell on the way: `execAsync` is
      // `promisify(exec)` and always spawns one.
      expect(execAsync).not.toHaveBeenCalled();
    });

    it('runs a single command through execRemote when a serverId names a Server', async () => {
      await execOnServer(remoteExec, 'server-1', ['cat', SHELL_PAYLOAD]);

      expect(execRemote).toHaveBeenCalledWith('server-1', [
        'cat',
        SHELL_PAYLOAD,
      ]);
      expect(execAsyncRemote).not.toHaveBeenCalled();
    });
  });

  describe('a shell program', () => {
    it('keeps a script on the string method locally, redirections and all', async () => {
      // The presence probe of the cascade fix, in the shape H-95 gave it — the real
      // string program this dispatch has to carry verbatim. It comes from
      // `test/utils/workload-presence-probe.ts` rather than being written out
      // here, because a stale probe shape sitting in the tree as an
      // illustration is how ten hand-written copies came to disagree with the
      // builder (H-104). There is **one** copy now, in that file, and it is
      // still hand-written rather than imported from `src` — the argument for
      // that, and for why it is one and not ten, is in its docblock.
      // `test/common/workload-presence.spec.ts`'s set-level guard is what fails
      // if it goes stale, or if an eleventh copy appears.
      const script = servicePresenceProbe(SHELL_PAYLOAD);

      await execOnServer(remoteExec, null, script);

      expect(execAsync).toHaveBeenCalledWith(script);
      expect(execFileAsync).not.toHaveBeenCalled();
    });

    it("keeps a script on the string method remotely, and quotes nothing on the caller's behalf", async () => {
      const script = 'set -e\ndocker ps -q | head -n 1\n';

      await execOnServer(remoteExec, 'server-1', script);

      // Verbatim: a script's interpolations are its builder's to `quote()`, and
      // a dispatch that "helpfully" re-worded one would corrupt every
      // `compose.utils.ts` command (CODING_STANDARDS.md §2.9).
      expect(execAsyncRemote).toHaveBeenCalledWith('server-1', script);
      expect(execRemote).not.toHaveBeenCalled();
    });

    it('bounds a script by maxBuffer on either machine when the caller names one', async () => {
      await execOnServer(remoteExec, null, 'tail -n 5 /x', { maxBuffer: 64 });
      await execOnServer(remoteExec, 'server-1', 'tail -n 5 /x', {
        maxBuffer: 64,
      });

      expect(execAsync).toHaveBeenCalledWith('tail -n 5 /x', { maxBuffer: 64 });
      expect(execAsyncRemote).toHaveBeenCalledWith(
        'server-1',
        'tail -n 5 /x',
        undefined,
        { maxBuffer: 64 },
      );
    });
  });

  it('leaves a payload inert whichever host and shape it travelled as', async () => {
    await execOnServer(remoteExec, 'server-1', ['cat', SHELL_PAYLOAD]);

    // The remote arm is the one that still meets a shell, so its argv is the one
    // whose emitted command has to parse back to words. `execRemote` does the
    // joining; this asserts the outcome the two of them produce together.
    const [, argv] = execRemote.mock.calls[0] as [string, string[]];
    expectQuotedInCommand(quote(argv));
  });
});
