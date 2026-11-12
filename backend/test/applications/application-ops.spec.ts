import {
  applicationServicePresence,
  removeApplicationDirectory,
  removeApplicationService,
  scaleApplicationService,
} from '../../src/applications/application-ops';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import { runProbe } from '../utils/docker-daemon-stub';
import {
  expectValueIsInert,
  INERT_VALUE,
  SEPARATOR_PAYLOAD,
} from '../utils/shell-safety';
import { servicePresenceProbe } from '../utils/workload-presence-probe';

/**
 * {@link SEPARATOR_PAYLOAD}'s shape, aimed at the working directory instead of
 * `/tmp`, so the executed proof below can assert on an empty temporary
 * directory. Both halves write the same file: the substitution arm fires while
 * the shell is still building the word, the separator arm after it gave up on
 * it, and either one is a command this file never wrote.
 */
const PWN_PAYLOAD = 'a$(touch pwned); touch pwned #';

/**
 * `applicationServicePresence` is what decides whether a refused teardown
 * may drop the Application's row, and its three answers are decided by a
 * *string* on stdout rather than by an exit code — because
 * `RemoteExecService.execAsync` rejects on any non-zero exit, so a plain
 * try/catch cannot tell "no such service" from "cannot reach the daemon".
 *
 * The construction that separates them is exactly the kind of thing a later
 * reader simplifies away, so the emitted command and all three mappings are
 * pinned here. It used to be `<question> && echo present || echo absent`, and
 * this file's pin **passed on H-95**: `||` swallows `Cannot connect to the
 * Docker daemon` like any other non-zero exit, so a stopped or wedged daemon
 * printed `absent` at exit 0 for a running Application. The executed proof of
 * the three arms is in `test/common/workload-presence.spec.ts`, on the shared
 * builder; what is asserted here is that this probe uses it and that this file's
 * mappings are unchanged.
 */
describe('applicationServicePresence', () => {
  const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 });

  const execDouble = () => {
    const execAsync = jest.fn().mockResolvedValue(ok(''));
    const execAsyncRemote = jest.fn().mockResolvedValue(ok(''));
    return {
      execAsync,
      execAsyncRemote,
      service: { execAsync, execAsyncRemote } as unknown as RemoteExecService,
    };
  };

  // Hand-written, and not imported from `application-ops.ts`: the pin has to
  // come from somewhere other than the thing it pins. It comes from
  // `test/utils/workload-presence-probe.ts`, which is that copy — one for the
  // whole tree, where it was ten (H-108).
  const probe = servicePresenceProbe('web-app');

  it('asks the daemon with one zero-exit command that answers on stdout', async () => {
    const exec = execDouble();
    exec.execAsync.mockResolvedValue(ok('absent\n'));

    await applicationServicePresence(exec.service, null, 'web-app');

    expect(exec.execAsync).toHaveBeenCalledWith(probe);
  });

  it('reads a service the daemon knows as present', async () => {
    const exec = execDouble();
    exec.execAsync.mockResolvedValue(ok('present\n'));

    expect(
      await applicationServicePresence(exec.service, null, 'web-app'),
    ).toBe('present');
  });

  it('reads a service the daemon does not know as absent', async () => {
    const exec = execDouble();
    exec.execAsync.mockResolvedValue(ok('absent\n'));

    expect(
      await applicationServicePresence(exec.service, null, 'web-app'),
    ).toBe('absent');
  });

  it('reads a rejected exec as unknown rather than as absent', async () => {
    const exec = execDouble();
    exec.execAsync.mockRejectedValue(new Error('ssh: connect refused'));

    // The distinction the whole three-valued type exists for: SSH refused,
    // Docker not running or a wedged daemon is not the same answer as "gone",
    // and treating it as gone is the shortcut that manufactures the orphan.
    expect(
      await applicationServicePresence(exec.service, null, 'web-app'),
    ).toBe('unknown');
  });

  it('reads the probe’s own unknown as unknown rather than as absent', async () => {
    const exec = execDouble();
    exec.execAsync.mockResolvedValue(ok('unknown\n'));

    // H-95. A daemon that is down on a reachable Server no longer rejects the
    // exec — it exits 0 with `unknown`, because a rejection could not be told
    // apart from "no such service". This is the token that carries the whole
    // fix from the shell back to the caller.
    expect(
      await applicationServicePresence(exec.service, null, 'web-app'),
    ).toBe('unknown');
  });

  it('reads any other stdout as unknown', async () => {
    const exec = execDouble();
    exec.execAsync.mockResolvedValue(ok('Welcome to Ubuntu 24.04\n'));

    // A shell that never ran the command — a login banner, an empty answer —
    // is no more "gone" than a rejection is.
    expect(
      await applicationServicePresence(exec.service, null, 'web-app'),
    ).toBe('unknown');
  });

  it('reads the daemon on the Application’s own server when it has one', async () => {
    const exec = execDouble();
    exec.execAsyncRemote.mockResolvedValue(ok('present\n'));

    expect(
      await applicationServicePresence(exec.service, 'srv-1', 'web-app'),
    ).toBe('present');
    expect(exec.execAsyncRemote).toHaveBeenCalledWith('srv-1', probe);
    expect(exec.execAsync).not.toHaveBeenCalled();
  });

  /**
   * H-92. The probe is a shell *program* — `>/dev/null 2>&1`, `&&`, `||` — so
   * `execOnServerStdout` hands it to `execAsync`/`execAsyncRemote` verbatim and
   * every interpolation in it is this file's to `quote()` (§2.9, and
   * `remote/exec-dispatch.ts`'s own note, which names this probe as the
   * canonical example of the string shape). It was bare.
   *
   * Nothing was exploitable through it: `appName` is minted through
   * `APP_NAME_REGEX` (`db/columns.ts`'s `cleanAppName`) and is absent from every
   * `update*Schema`, so no route can put a metacharacter in the column. The
   * quoting is here because a charset enforced in another module is defence at a
   * distance, which this tree has got wrong three times — H-12, and H-21,
   * where the neighbour filed as "not currently exploitable" was live because
   * the word turned out not to be an `appName` at all.
   *
   * The payload is deliberately one the mint rejects: a builder that is only
   * safe on values someone else filtered is the arrangement that failed at each
   * of those three.
   */
  describe('the probe’s appName is one word (H-92)', () => {
    const probeFor = async (appName: string) => {
      const exec = execDouble();
      exec.execAsync.mockResolvedValue(ok('absent\n'));
      await applicationServicePresence(exec.service, null, appName);
      const [[command]] = exec.execAsync.mock.calls as [[string]];
      return command;
    };

    it('introduces no syntax for a name carrying a separator and a substitution', async () => {
      expectValueIsInert(
        await probeFor(SEPARATOR_PAYLOAD),
        await probeFor(INERT_VALUE),
      );
    });

    it('runs the payload as no command of its own under a real shell', async () => {
      // `touch` is reachable and the daemon answers, so the probe reaches the
      // branch the payload is interpolated into while the payload still has
      // everything it needs to fire — the arrangement that makes the empty
      // directory afterwards mean something. A PATH with no `touch` on it
      // would pass on the bare interpolation too.
      //
      // **The stub daemon has to be reachable, and that is H-95's doing.** This
      // test used to run with no `docker` on the PATH at all, which was
      // sufficient against `<question> && echo present || echo absent` because
      // the question was the first thing the shell evaluated. It is not
      // sufficient against the three-branch probe: an absent `docker` fails the
      // reachability check, the `elif` carrying the payload is never evaluated,
      // and the assertion would pass without the shell ever having looked at
      // the word. A reachability stub that answers is what keeps this proof a
      // proof.
      const ran = runProbe(
        await probeFor(PWN_PAYLOAD),
        { reachable: true, services: [] },
        ['touch'],
      );

      expect(ran.created).toEqual([]);
      // And the probe still answers: a quoted name Docker has never heard of
      // is `absent`, not a broken script and not `unknown`.
      expect(ran.said).toBe('absent');
    });
  });
});

/**
 * The three single commands, asserted as the argv they are rather
 * than as the strings they used to be interpolated into. This is the unit that
 * changed, so it is the unit that says so: locally argv reaches `execFileAsync`,
 * which spawns the program itself, and remotely it reaches `execRemote`, which
 * words it with `quote()` — neither is a string this file assembled. The three
 * words carried here (`appName`, a directory, a `0 | 1`) were already guarded at
 * their mints, so this retires them from shell-word review rather than fixing a
 * live injection.
 */
describe('application swarm operations', () => {
  const execDouble = () => {
    const ok = { stdout: '', stderr: '', exitCode: 0 };
    const execAsync = jest.fn().mockResolvedValue(ok);
    const execAsyncRemote = jest.fn().mockResolvedValue(ok);
    const execFileAsync = jest.fn().mockResolvedValue(ok);
    const execRemote = jest.fn().mockResolvedValue(ok);
    return {
      execAsync,
      execAsyncRemote,
      execFileAsync,
      execRemote,
      service: {
        execAsync,
        execAsyncRemote,
        execFileAsync,
        execRemote,
      } as unknown as RemoteExecService,
    };
  };

  it('drops the swarm service by name and nothing else', async () => {
    const exec = execDouble();

    await removeApplicationService(exec.service, null, 'web-app');

    // No `--force`, no volume flag: volumes survive a Delete unless asked for.
    expect(exec.execFileAsync).toHaveBeenCalledWith('docker', [
      'service',
      'rm',
      'web-app',
    ]);
    // Not through a local shell on the way: `execAsync` is `promisify(exec)`.
    expect(exec.execAsync).not.toHaveBeenCalled();
  });

  it('drops the Application directory on the host that built it', async () => {
    const exec = execDouble();

    await removeApplicationDirectory(exec.service, 'srv-1', '/root/apps/web');

    expect(exec.execRemote).toHaveBeenCalledWith('srv-1', [
      'rm',
      '-rf',
      '/root/apps/web',
    ]);
    expect(exec.execFileAsync).not.toHaveBeenCalled();
    expect(exec.execAsync).not.toHaveBeenCalled();
  });

  it('still scales through the same exec layer', async () => {
    const exec = execDouble();

    await scaleApplicationService(exec.service, null, 'web-app', 0);

    expect(exec.execFileAsync).toHaveBeenCalledWith('docker', [
      'service',
      'scale',
      'web-app=0',
    ]);
  });
});
