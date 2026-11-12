import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PtyChannelService } from '../../src/realtime/channels/pty-channel.service';
import type { StreamChannel } from '../../src/realtime/channels/stream-channel';

/**
 * Every local-process gateway (`/docker-container-logs`,
 * `/docker-container-terminal`, `/terminal`) spawns through node-pty, and how
 * node-pty starts that process depends on the platform. **On macOS only** it
 * execs a small `spawn-helper` binary that ships prebuilt per platform:
 * node-pty's `binding.gyp` declares that target inside `['OS=="mac"', …]`, and
 * `src/unix/pty.cc` reads `helper_path` only under `#if defined(__APPLE__)`.
 * Linux — the platform Cloudgate is deployed on — goes through `forkpty(3)` and
 * never execs it; the artefact it loads is `build/Release/pty.node`, compiled
 * from source at install, since node-pty ships no Linux prebuild.
 *
 * The helper matters on macOS because package managers can extract that binary
 * without its executable bit, and the only symptom is a single frame of
 * `posix_spawnp failed.` that the log well renders as though the container had
 * said it — for every target, `/bin/sh` included, which makes it read like a
 * PATH problem.
 *
 * The repo restores the bit from the root `postinstall`
 * (`scripts/restore-node-pty-exec-bit.mjs`). These tests are the invariant that
 * keeps it restored: the helper's file mode, and an actual pty round-trip
 * through the same service the gateways use.
 *
 * Those two run on different sets of hosts. The file mode can only be asserted
 * where there is a helper; the round-trip does not touch spawn-helper at all
 * and runs on every posix host, Linux included — gating it on the helper left
 * the only platform that ships with no pty coverage whatsoever.
 *
 * The paths below are resolved the way node-pty's own loader resolves them
 * (`lib/utils.js`: build/Release, build/Debug, then
 * prebuilds/<platform>-<arch>), deliberately duplicated here rather than
 * imported from the fix, so a wrong path in the fix cannot make this pass.
 */

/** node-pty's package root, via its resolved entry point `lib/index.js`. */
function nodePtyPackageRoot(): string {
  return dirname(dirname(require.resolve('node-pty')));
}

/** The `spawn-helper` node-pty would exec on this host, or null if it has none. */
function resolveSpawnHelper(): string | null {
  const root = nodePtyPackageRoot();
  const candidates = [
    join(root, 'build', 'Release', 'spawn-helper'),
    join(root, 'build', 'Debug', 'spawn-helper'),
    join(
      root,
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'spawn-helper',
    ),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

// Windows drives ptys through conpty and ships no spawn-helper at all.
const spawnHelper = process.platform === 'win32' ? null : resolveSpawnHelper();

/**
 * Which of the two invariants this host can be held to. Kept pure — a function
 * of the platform and of whether a helper was found, nothing else — because it
 * is the only way a macOS dev machine, which always finds a helper, can assert
 * what happens on Linux, which never has one.
 */
function runnableOn(
  platform: NodeJS.Platform,
  helper: string | null,
): { fileMode: boolean; roundTrip: boolean } {
  return {
    // Nothing to chmod where node-pty ships no helper for this platform.
    fileMode: helper !== null,
    // forkpty(3) or spawn-helper, a posix host runs a real pty either way.
    roundTrip: platform !== 'win32',
  };
}

const runnable = runnableOn(process.platform, spawnHelper);
const itWithHelper = runnable.fileMode ? it : it.skip;
const itOnPosix = runnable.roundTrip ? it : it.skip;

// Only worth saying where the helper is in the pty path: on darwin its absence
// means node-pty is not installed for this platform. Anywhere else it is
// expected, and warning about it is what made the skip read as a defect.
if (spawnHelper === null && process.platform === 'darwin') {
  console.warn(
    `[pty-spawn-helper.spec] no node-pty spawn-helper for ${process.platform}-${process.arch} under ${nodePtyPackageRoot()}; skipping its file mode`,
  );
}

describe('the platform gate on these tests', () => {
  it('runs the round-trip on Linux, which has no spawn-helper to find', () => {
    expect(runnableOn('linux', null)).toEqual({
      fileMode: false,
      roundTrip: true,
    });
  });

  it('runs both on darwin, which execs the helper for every pty', () => {
    expect(
      runnableOn('darwin', '/node-pty/build/Release/spawn-helper'),
    ).toEqual({ fileMode: true, roundTrip: true });
  });

  it('runs neither on Windows, which drives ptys through conpty', () => {
    expect(runnableOn('win32', null)).toEqual({
      fileMode: false,
      roundTrip: false,
    });
  });
});

describe("node-pty's spawn-helper", () => {
  itWithHelper('is executable as installed', () => {
    const mode = statSync(spawnHelper as string).mode;

    // 0o111 — exec for user, group and other. Anything less and posix_spawnp
    // cannot exec the helper.
    expect({ helper: spawnHelper, exec: (mode & 0o111).toString(8) }).toEqual({
      helper: spawnHelper,
      exec: '111',
    });
  });
});

describe('PtyChannelService', () => {
  /** Collects a whole pty session: everything written, and the exit code. */
  function run(
    file: string,
    args: string[],
    options: {
      size?: { cols: number; rows: number };
      /** Called with the live channel, once, right after it is spawned. */
      whenRunning?: (channel: StreamChannel) => void;
    } = {},
  ) {
    return new Promise<{ output: string; exitCode: number | undefined }>(
      (resolve, reject) => {
        const channel = new PtyChannelService().spawn(file, args, {
          cols: options.size?.cols ?? 80,
          rows: options.size?.rows ?? 24,
        });
        options.whenRunning?.(channel);
        let output = '';
        const timer = setTimeout(() => {
          channel.close();
          reject(
            new Error(
              `pty never exited; output so far: ${JSON.stringify(output)}`,
            ),
          );
        }, 15_000);

        channel.onData((chunk) => {
          output += chunk;
        });
        channel.onClose((exitCode) => {
          clearTimeout(timer);
          resolve({ output, exitCode });
        });
      },
    );
  }

  itOnPosix(
    'runs a command in a local pty and reports its output',
    async () => {
      const { output, exitCode } = await run('/bin/sh', [
        '-c',
        'echo cloudgate-pty-ok',
      ]);

      expect(output).not.toContain('posix_spawnp failed');
      expect(output).toContain('cloudgate-pty-ok');
      expect(exitCode).toBe(0);
    },
  );

  itOnPosix(
    'reports a non-zero exit code from the spawned command',
    async () => {
      const { exitCode } = await run('/bin/sh', ['-c', 'exit 3']);

      expect(exitCode).toBe(3);
    },
  );

  /**
   * The window the pty actually has, asked of the kernel rather than of node-pty.
   * `stty size` prints `rows cols`, which is the source of truth every
   * full-screen program reads — so this is the same question the issue answered
   * `24 80` to by hand, put where it stays answered.
   */
  itOnPosix('opens the pty at the size it was given', async () => {
    const { output } = await run('/bin/sh', ['-c', 'stty size'], {
      size: { cols: 132, rows: 43 },
    });

    expect(output).toContain('43 132');
  });

  itOnPosix('resizes a running pty', async () => {
    // The shell reads its size after the resize has landed; without one it would
    // print the 80 x 24 it was opened at.
    const { output } = await run('/bin/sh', ['-c', 'sleep 0.5; stty size'], {
      size: { cols: 80, rows: 24 },
      whenRunning: (channel) => channel.resize?.(120, 40),
    });

    expect(output).toContain('40 120');
    expect(output).not.toContain('24 80');
  });
});
