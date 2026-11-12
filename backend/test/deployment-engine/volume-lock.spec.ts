import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  cloudgateDirectoryOn,
  REMOTE_CLOUDGATE_DIRECTORY,
} from '../../src/common/config/cloudgate-directory';
import {
  VOLUME_LOCK_BUSY_EXIT_CODE,
  busyVolumeNameFrom,
  isVolumeLockBusyError,
  volumeLockPathFor,
  withVolumeLock,
} from '../../src/deployment-engine/volume-lock';

// The lock three operations share: a volume backup, a volume restore and
// a compose stack's Remove containers. What these tests pin is mostly what the
// preamble must *not* do — it is keyed by volume and has three callers, and
// each property below is a way it can be quietly broken by a later reader
// who has only one call site in mind.

/**
 * The lock file a `serverId: null` taker names: the platform host's (ADR-0008),
 * so under this process's CLOUDGATE_DIRECTORY. Asked of the machine rather than
 * spelled `/etc/cloudgate`, which is a Server's root and matched here only
 * while the variable was unset. A function, because the blocks below
 * set the variable and this has to answer for whichever value is in force.
 */
const platformHostLockPath = (volumeName: string) =>
  `${cloudgateDirectoryOn(null)}/volume-backup-lock-${volumeName}`;

describe('volumeLockPathFor', () => {
  it('keys the lock file by volume name, not by service', () => {
    expect(volumeLockPathFor(null, 'shop-data')).toBe(
      platformHostLockPath('shop-data'),
    );
  });

  it('gives one volume one path however it is reached', () => {
    // The point of the re-key: two backup rows naming this volume under
    // different services now contend, where the service-keyed name did not.
    expect(volumeLockPathFor(null, 'shop-data')).toBe(
      volumeLockPathFor(null, 'shop-data'),
    );
    expect(volumeLockPathFor(null, 'shop-data')).not.toBe(
      volumeLockPathFor(null, 'other-data'),
    );
  });
});

/**
 * Which **root** the lock file is under, and the question that had to be
 * answered before this was converted rather than after.
 *
 * `volumeBackupLockPath()` was `localCloudgateDirectory()` — *this process's*
 * root — for every machine alike, while all three takers' scripts are
 * dispatched to a Server. A lock whose path two callers compute differently is
 * not a lock, so the first work was establishing whether the takers already
 * disagreed: that would have been a hole in the volume lock's serialization rather than a
 * wrong root, and a different fix. **They did not**, and structurally so —
 * `volumeLockPathFor` is the only expression of the path in the product, and
 * all three scripts go to one machine (a backup and a restore to
 * `ServiceParent.serverId`, Remove containers to `compose.serverId`, which for
 * rows that can contend over one volume are the same column of the same row).
 *
 * **What the wrong root did cost is not a misplaced directory.** Nothing
 * creates a lock file's parent — unlike the staging tree, which `docker run -v`
 * and rclone both mint. `exec 9>"$LOCK_PATH"` fails outright where the local
 * root does not exist, and the `mkdir` fallback reads the same missing
 * directory as the **busy** branch, so a host without `flock` answered 409
 * "volume is busy" about a lock nobody held.
 *
 * With `CLOUDGATE_DIRECTORY` unset the two roots are the same literal, so every
 * assertion in this file above and below passes whichever root is resolved.
 * These set it and name the resolved temp path.
 */
describe('volumeLockPathFor, on the root the lock file is under', () => {
  const configured = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-lock-root-')),
  );
  const originalRoot = process.env.CLOUDGATE_DIRECTORY;

  beforeEach(() => {
    process.env.CLOUDGATE_DIRECTORY = configured;
  });

  afterEach(() => {
    if (originalRoot === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = originalRoot;
  });

  afterAll(() => {
    fs.rmSync(configured, { recursive: true, force: true });
  });

  it('roots a Server’s lock on that Server’s own tree', () => {
    expect(volumeLockPathFor('srv-1', 'shop-data')).toBe(
      `${REMOTE_CLOUDGATE_DIRECTORY}/volume-backup-lock-shop-data`,
    );
    expect(volumeLockPathFor('srv-1', 'shop-data')).not.toContain(configured);
  });

  it('roots the platform host’s lock on this instance’s configured tree', () => {
    expect(volumeLockPathFor(null, 'shop-data')).toBe(
      `${configured}/volume-backup-lock-shop-data`,
    );
  });

  /**
   * The property that makes it a lock, stated as a test: the three takers reach
   * one string for one volume on one machine. The backup and the restore both
   * hold the Service's `serverId`, and Remove containers the stack's — the same
   * value for the rows that can contend, so the same file.
   */
  it('gives three takers on one machine one file for one volume', () => {
    const backup = withVolumeLock(
      { serverId: 'srv-1', volumeNames: ['shop-data'], mode: 'wait' },
      'echo backup',
    );
    const restore = withVolumeLock(
      { serverId: 'srv-1', volumeNames: ['shop-data'], mode: 'fail-fast' },
      'echo restore',
    );
    const removeContainers = withVolumeLock(
      { serverId: 'srv-1', volumeNames: ['shop-data'], mode: 'fail-fast' },
      'echo rm',
    );

    const assignment = `LOCK_PATH=${REMOTE_CLOUDGATE_DIRECTORY}/volume-backup-lock-shop-data`;
    for (const script of [backup, restore, removeContainers]) {
      expect(script).toContain(assignment);
      expect(script).not.toContain(configured);
    }
  });

  // Two machines are two locks, which is the other half of the same claim: a
  // volume is an object on one host, so a lock rooted on another host's tree
  // would not exclude anything.
  it('does not share a lock file between two machines', () => {
    expect(volumeLockPathFor('srv-1', 'shop-data')).not.toBe(
      volumeLockPathFor(null, 'shop-data'),
    );
  });
});

describe('withVolumeLock', () => {
  it('returns the body untouched when there is no volume to lock', () => {
    // Remove containers on a project with no turn-off-enabled backup row has
    // nothing to contend for, and must run exactly the command it ran before
    // this file existed — not that command wrapped in a no-op preamble.
    expect(
      withVolumeLock(
        { serverId: null, volumeNames: [], mode: 'fail-fast' },
        'echo hi',
      ),
    ).toBe('echo hi');
  });

  it('waits for the lock in wait mode, and never exits on contention', () => {
    const script = withVolumeLock(
      { serverId: null, volumeNames: ['shop-data'], mode: 'wait' },
      'echo body',
    );
    // The assignment is `quote()`d since H-31, and a path with nothing
    // shell-special in it is emitted bare — what this pins is the volume-keyed
    // path, not the quote character around it.
    expect(script).toContain(`LOCK_PATH=${platformHostLockPath('shop-data')}`);
    expect(script).toContain('flock 9');
    expect(script).toContain('while ! mkdir "$LOCK_DIR" 2>/dev/null; do');
    expect(script).toContain('echo body');
    // A scheduled run has no HTTP caller to answer, so blocking is the whole
    // behaviour: nothing here may bail out with the busy status.
    expect(script).not.toContain(`exit ${VOLUME_LOCK_BUSY_EXIT_CODE}`);
    expect(script).not.toContain('flock -n');
  });

  it('fails fast with the busy status in fail-fast mode, on both implementations', () => {
    const script = withVolumeLock(
      { serverId: null, volumeNames: ['shop-data'], mode: 'fail-fast' },
      'echo body',
    );
    expect(script).toContain('if ! flock -n 9; then');
    // The mkdir fallback's fail-fast form does not spin: the wait form's
    // spinlock loops forever by construction, which is exactly what a
    // synchronous caller must not do.
    expect(script).toContain('if ! mkdir "$LOCK_DIR" 2>/dev/null; then');
    expect(script).not.toContain('while ! mkdir');
    expect(script).not.toContain('sleep 5');
    // Twice: once per implementation branch.
    expect(
      script.match(new RegExp(`exit ${VOLUME_LOCK_BUSY_EXIT_CODE}`, 'g')),
    ).toHaveLength(2);
    expect(script).toContain('Volume lock busy: shop-data');
  });

  it('names the volume in every line a reader sees, never the lock path', () => {
    const script = withVolumeLock(
      { serverId: null, volumeNames: ['shop-data'], mode: 'wait' },
      'echo body',
    );
    // Single-quoted since H-31, which changes the spelling and not the output:
    // `sh` strips either quote and the reader sees the same line. What is
    // asserted is the message.
    expect(script).toContain("echo 'Waiting for volume lock: shop-data'");
    expect(script).toContain("echo 'Volume lock acquired: shop-data'");
    expect(script).toContain("echo 'Volume lock released: shop-data'");
    // The path is this file's business; the name is what a 409 has to carry.
    // Asserted on the *variable* rather than on a whole quoted line, because a
    // line pinned with its quotes stops catching this the moment the quoting
    // changes — which is exactly what H-31 did to the version of this that
    // read `not.toContain('echo "Waiting for volume lock: $LOCK_PATH"')`.
    expect(script).not.toContain('volume lock: $LOCK_PATH');
    // No line a reader sees carries the path. `$LOCK_PATH` appears twice, in
    // the redirection and in `LOCK_DIR`, and neither is an `echo`.
    for (const line of script.split('\n')) {
      if (line.includes('$LOCK_PATH')) expect(line).not.toContain('echo ');
    }
  });

  it('acquires several volumes in sorted order, each in its own subshell', () => {
    const script = withVolumeLock(
      {
        serverId: null,
        volumeNames: ['zeta-data', 'alpha-data'],
        mode: 'fail-fast',
      },
      'echo body',
    );
    const alpha = script.indexOf('volume-backup-lock-alpha-data');
    const zeta = script.indexOf('volume-backup-lock-zeta-data');
    expect(alpha).toBeGreaterThanOrEqual(0);
    // Sorted, so two callers naming the same set acquire in the same order and
    // cannot deadlock against each other.
    expect(alpha).toBeLessThan(zeta);
    // Descriptor 9 is reused at every level rather than numbered upwards, which
    // is only safe because the inner level runs in a subshell — the parent's
    // descriptor stays open, so the outer lock is held across the inner
    // acquisition. A multi-digit descriptor would not survive `sh -s`.
    expect(script.match(/exec 9>"\$LOCK_PATH"/g)).toHaveLength(2);
    expect(script).not.toContain('exec 10>');
    expect(script.slice(alpha, zeta)).toContain('(');
  });

  it('deduplicates a volume named twice, so one lock is taken once', () => {
    const script = withVolumeLock(
      {
        serverId: null,
        volumeNames: ['shop-data', 'shop-data'],
        mode: 'fail-fast',
      },
      'echo body',
    );
    // A compose project can mount one volume from two services; acquiring the
    // same lock twice on descriptor 9 would deadlock the second attempt.
    expect(script.match(/exec 9>"\$LOCK_PATH"/g)).toHaveLength(1);
  });
});

describe('isVolumeLockBusyError', () => {
  it('is true only for the busy exit status', () => {
    // Read off the status and not the output, because the volume-backup run
    // redirects its whole script into the run's log file and so hands us an
    // error with no stdout at all.
    expect(
      isVolumeLockBusyError({ exitCode: VOLUME_LOCK_BUSY_EXIT_CODE }),
    ).toBe(true);
    expect(isVolumeLockBusyError({ exitCode: 1 })).toBe(false);
    expect(isVolumeLockBusyError({})).toBe(false);
    expect(isVolumeLockBusyError(undefined)).toBe(false);
  });

  it('does not collide with an ordinary `set -e` abort', () => {
    // Every abort in these scripts exits 1, which is why the busy status is not 1.
    expect(VOLUME_LOCK_BUSY_EXIT_CODE).not.toBe(1);
  });
});

describe('busyVolumeNameFrom', () => {
  it('recovers which volume refused, for a caller holding several locks', () => {
    expect(
      busyVolumeNameFrom({
        stdout:
          'Waiting for volume lock: alpha-data\nVolume lock acquired: alpha-data\nWaiting for volume lock: zeta-data\nVolume lock busy: zeta-data\n',
      }),
    ).toBe('zeta-data');
  });

  it('reads stderr when the marker went there instead', () => {
    expect(
      busyVolumeNameFrom({ stderr: 'Volume lock busy: shop-data\n' }),
    ).toBe('shop-data');
  });

  it('is null when the output never reached us', () => {
    // The backup run's case: the script's output is in the log file, so the
    // caller has to fall back to the volume it already knows it asked for.
    expect(
      busyVolumeNameFrom({ exitCode: VOLUME_LOCK_BUSY_EXIT_CODE }),
    ).toBeNull();
    expect(
      busyVolumeNameFrom({ stdout: 'something else entirely' }),
    ).toBeNull();
  });
});

/**
 * These run the generated shell, rather than asserting strings about it.
 *
 * They exist because a string assertion cannot see the bug they were written
 * for: the wrapper appended a release `echo` after the body, and POSIX exempts
 * every command of an AND-OR list except the last from `set -e`, so a body of
 * the shape `cd DIR && …` whose `cd` failed carried on to that `echo` and the
 * script exited 0. `Remove containers` has exactly that shape, so its failure
 * came back as a success. Every `toContain` in this file passed throughout.
 *
 * `sh`, not `bash`, because `execAsyncRemote` feeds these to `sh -s`. Both lock
 * implementations are exercised depending on whether the host has `flock` —
 * neither may swallow a status, so the assertions hold either way.
 */
describe('the generated shell, executed', () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-volume-lock-')),
  );
  const original = process.env.CLOUDGATE_DIRECTORY;
  let scriptFile: string;

  beforeAll(() => {
    process.env.CLOUDGATE_DIRECTORY = root;
    scriptFile = path.join(root, 'script.sh');
  });

  afterAll(() => {
    if (original === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = original;
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Runs a script under `sh`, returning its exit status and combined output. */
  const run = (script: string): { status: number; output: string } => {
    fs.writeFileSync(scriptFile, script);
    const result = spawnSync('sh', [scriptFile], { encoding: 'utf8' });
    return {
      status: result.status ?? -1,
      output: `${result.stdout}${result.stderr}`,
    };
  };

  it('carries a failing body out as a failure, even one that fails at `&&`', () => {
    const { status, output } = run(
      withVolumeLock(
        { serverId: null, volumeNames: ['shop-data'], mode: 'wait' },
        'cd /definitely/not/a/directory && echo SHOULD-NOT-RUN',
      ),
    );
    expect(status).not.toBe(0);
    expect(output).not.toContain('SHOULD-NOT-RUN');
    // The lock is still released on the way out — the status is carried, not
    // bought by skipping the release.
    expect(output).toContain('Volume lock released: shop-data');
  });

  it('carries a failing body out through several nested locks', () => {
    const { status } = run(
      withVolumeLock(
        {
          serverId: null,
          volumeNames: ['alpha-data', 'zeta-data'],
          mode: 'wait',
        },
        'cd /definitely/not/a/directory && echo SHOULD-NOT-RUN',
      ),
    );
    expect(status).not.toBe(0);
  });

  it('succeeds and releases when the body succeeds', () => {
    const { status, output } = run(
      withVolumeLock(
        {
          serverId: null,
          volumeNames: ['alpha-data', 'zeta-data'],
          mode: 'wait',
        },
        'echo BODY-RAN',
      ),
    );
    expect(status).toBe(0);
    expect(output).toContain('BODY-RAN');
    expect(output).toContain('Volume lock released: zeta-data');
    expect(output).toContain('Volume lock released: alpha-data');
  });

  it('refuses with the busy status while another script holds the lock', () => {
    // The whole point of the fail-fast mode, and the one assertion that proves
    // the lock is a lock rather than a preamble that looks like one: the holder
    // is a real second process, and fd 9 is reused at every nesting level.
    const holder = withVolumeLock(
      { serverId: null, volumeNames: ['shop-data'], mode: 'fail-fast' },
      'echo HOLDING; sleep 3',
    );
    const holderFile = path.join(root, 'holder.sh');
    fs.writeFileSync(holderFile, holder);
    const child = spawn('sh', [holderFile], { stdio: 'ignore' });
    try {
      // Give the holder time to acquire before contending for it.
      spawnSync('sh', ['-c', 'sleep 1']);
      const { status, output } = run(
        withVolumeLock(
          { serverId: null, volumeNames: ['shop-data'], mode: 'fail-fast' },
          'echo SHOULD-NOT-RUN',
        ),
      );
      expect(status).toBe(VOLUME_LOCK_BUSY_EXIT_CODE);
      expect(output).toContain('Volume lock busy: shop-data');
      expect(output).not.toContain('SHOULD-NOT-RUN');
      // And the name is recoverable from that output, which is how the caller
      // holding several locks builds its 409.
      expect(busyVolumeNameFrom({ stdout: output })).toBe('shop-data');
    } finally {
      child.kill();
    }
  });
});
