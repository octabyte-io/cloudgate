import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  cloudgateDirectoryOn,
  REMOTE_CLOUDGATE_DIRECTORY,
} from '../../src/common/config/cloudgate-directory';
import { volumeLockPathFor } from '../../src/deployment-engine/volume-lock';
import { rcloneFailureMessage } from '../../src/destinations/rclone-exec';
import {
  buildVolumeBackupScript,
  buildVolumeRestoreScript,
} from '../../src/volume-backups/volume-backup-commands';
import type { VolumeRestoreTarget } from '../../src/volume-backups/volume-backup-commands';
import {
  expectValueIsInert,
  INERT_VALUE,
  SEPARATOR_PAYLOAD,
} from '../utils/shell-safety';
import { PINNED_VOLUME_SCRIPTS } from './pinned-volume-scripts';

// buildVolumeBackupScript and buildVolumeRestoreScript — expected literals are
// the pinned scripts, lock preamble included (see the fixture module's header
// for the inputs, how the pin is maintained, and every deliberate property).
//
// Neither builder takes a credential, so every expected script
// below is also the negative assertion: there is no argument these could have
// interpolated a secret access key from.

/**
 * The machine every whole-script equality against `PINNED_VOLUME_SCRIPTS` is
 * built for: a Server, not the platform host.
 *
 * The fixture pins its paths as the literal `/etc/cloudgate` — the lock file
 * and the restore's staging tree — and that literal is
 * `REMOTE_CLOUDGATE_DIRECTORY`, the one root that does not follow
 * CLOUDGATE_DIRECTORY. These used to be built with `serverId: null`,
 * which made the literal a claim about the platform host's root that held only
 * while the variable was unset. Built for a Server, the same bytes are true in
 * every lane, and the backup's `volumeBackupPath` input already names that
 * Server's tree. The platform host's answer is not lost: the blocks below that
 * pass `null` take its root from `cloudgateDirectoryOn(null)`, and the last
 * block in this file pins it against a configured temp root.
 */
const FIXTURE_SERVER_ID = 'srv-1';

/** The platform host's root — this process's CLOUDGATE_DIRECTORY — for the
 * `serverId: null` calls below, asked of the machine rather than spelled.
 * A function: several blocks set the variable for their own run. */
const platformHostRoot = () => cloudgateDirectoryOn(null);

describe('buildVolumeBackupScript', () => {
  const backupFor = (
    overrides: Partial<Parameters<typeof buildVolumeBackupScript>[0]> = {},
  ) =>
    buildVolumeBackupScript({
      serverId: null,
      volumeName: 'shop-data',
      backupFileName: 'shop-data-2026-07-23T10-20-30-456Z.tar',
      volumeBackupPath: '/etc/cloudgate/volume-backups/volume-backup-abc123',
      rcloneDestination:
        ':s3:cloudgate-backups/main-app/daily/shop-data-2026-07-23T10-20-30-456Z.tar',
      turnOff: false,
      lockMode: 'wait',
      ...overrides,
    });

  it('tars the volume from an ubuntu container and uploads via rclone copyto', () => {
    expect(
      buildVolumeBackupScript({
        serverId: FIXTURE_SERVER_ID,
        volumeName: 'shop-data',
        backupFileName: 'shop-data-2026-07-23T10-20-30-456Z.tar',
        volumeBackupPath: '/etc/cloudgate/volume-backups/volume-backup-abc123',
        rcloneDestination:
          ':s3:cloudgate-backups/main-app/daily/shop-data-2026-07-23T10-20-30-456Z.tar',
        turnOff: false,
        lockMode: 'wait',
      }),
    ).toBe(PINNED_VOLUME_SCRIPTS.plain);
  });

  it('turn-off application: scales the swarm service to 0 under the volume lock', () => {
    expect(
      buildVolumeBackupScript({
        serverId: FIXTURE_SERVER_ID,
        volumeName: 'shop-data',
        backupFileName: 'shop-data-2026-07-23T10-20-30-456Z.tar',
        volumeBackupPath: '/etc/cloudgate/volume-backups/volume-backup-abc123',
        rcloneDestination:
          ':s3:cloudgate-backups/main-app/daily/shop-data-2026-07-23T10-20-30-456Z.tar',
        turnOff: true,
        target: { serviceType: 'application', appName: 'main-app' },
        lockMode: 'wait',
      }),
    ).toBe(PINNED_VOLUME_SCRIPTS.applicationTurnOff);
  });

  it('turn-off stack service: scales the stack service to 0 under the volume lock', () => {
    expect(
      buildVolumeBackupScript({
        serverId: FIXTURE_SERVER_ID,
        volumeName: 'shop-data',
        backupFileName: 'shop-data-2026-07-23T10-20-30-456Z.tar',
        volumeBackupPath: '/etc/cloudgate/volume-backups/volume-backup-abc123',
        rcloneDestination:
          ':s3:cloudgate-backups/shop-stack_db/daily/shop-data-2026-07-23T10-20-30-456Z.tar',
        turnOff: true,
        target: {
          serviceType: 'compose',
          appName: 'shop-stack',
          serviceName: 'db',
          composeType: 'stack',
        },
        lockMode: 'wait',
      }),
    ).toBe(PINNED_VOLUME_SCRIPTS.stackTurnOff);
  });

  it('turn-off docker-compose service: stops the container under the volume lock', () => {
    expect(
      buildVolumeBackupScript({
        serverId: FIXTURE_SERVER_ID,
        volumeName: 'shop-data',
        backupFileName: 'shop-data-2026-07-23T10-20-30-456Z.tar',
        volumeBackupPath: '/etc/cloudgate/volume-backups/volume-backup-abc123',
        rcloneDestination:
          ':s3:cloudgate-backups/shop-stack_db/daily/shop-data-2026-07-23T10-20-30-456Z.tar',
        turnOff: true,
        target: {
          serviceType: 'compose',
          appName: 'shop-stack',
          serviceName: 'db',
          composeType: 'docker-compose',
        },
        lockMode: 'wait',
      }),
    ).toBe(PINNED_VOLUME_SCRIPTS.dockerComposeTurnOff);
  });

  // The lock is keyed by volume rather than by service (`appName`, or
  // `${appName}_${serviceName}` for a compose service) and is taken whether or
  // not the backup turns the service off, because the resource being contended
  // is the volume.
  describe('the volume lock', () => {
    it('keys the lock by volume, so two services sharing one volume serialize', () => {
      const first = backupFor({
        turnOff: true,
        target: { serviceType: 'application', appName: 'main-app' },
      });
      const second = backupFor({
        turnOff: true,
        target: {
          serviceType: 'compose',
          appName: 'shop-stack',
          serviceName: 'db',
          composeType: 'stack',
        },
      });

      // `quote()`d since H-31; a path with nothing shell-special in it is
      // emitted bare. The claim is the volume-keyed path, not the quoting.
      const lockPath = `LOCK_PATH=${platformHostRoot()}/volume-backup-lock-shop-data`;
      expect(first).toContain(lockPath);
      expect(second).toContain(lockPath);
      // Neither names the service it happens to belong to, which is what let
      // these two run at once over one volume.
      expect(first).not.toContain('volume-backup-lock-main-app');
      expect(second).not.toContain('volume-backup-lock-shop-stack_db');
    });

    it('takes the volume lock for the tar when turnOff is false', () => {
      const script = backupFor({ turnOff: false });

      expect(script).toContain(
        `LOCK_PATH=${platformHostRoot()}/volume-backup-lock-shop-data`,
      );
      // The tar is inside the acquisition, not beside it — this is the pairing
      // the restore's in-use guard cannot cover, because a volume no container
      // mounts leaves `docker ps -a --filter volume=` nothing to report.
      expect(script.indexOf('Volume lock acquired: shop-data')).toBeLessThan(
        script.indexOf('tar cvf'),
      );
      expect(script.indexOf('tar cvf')).toBeLessThan(
        script.indexOf('Volume lock released: shop-data'),
      );
    });

    it('blocks on a held lock for a scheduled run and refuses for a manual one', () => {
      const scheduled = backupFor({ lockMode: 'wait' });
      const manual = backupFor({ lockMode: 'fail-fast' });

      expect(scheduled).toContain('flock 9');
      expect(manual).toContain('if ! flock -n 9; then');
      expect(manual).toContain('exit 75');
      // A scheduled run has nobody waiting on it, so it never gives up — the
      // exit code that becomes a 409 cannot appear on that path.
      expect(scheduled).not.toContain('exit 75');
      expect(manual).not.toContain('\n\t\t\tflock 9\n');
    });
  });

  // The `docker-compose` branch resolved its container id once, before
  // the stop, and reused it to restart after the tar. Remove containers
  // (ADR-0011) and Delete both take that container away while the backup holds
  // it stopped, and under `set -e` the failing `docker start` aborted the
  // script before the upload — the tar had run and the bucket gained nothing.
  describe('the docker-compose restart after the tar', () => {
    const composeTurnOff = () =>
      backupFor({
        rcloneDestination:
          ':s3:cloudgate-backups/shop-stack_db/daily/shop-data-2026-07-23T10-20-30-456Z.tar',
        turnOff: true,
        target: {
          serviceType: 'compose',
          appName: 'shop-stack',
          serviceName: 'db',
          composeType: 'docker-compose',
        },
      });

    it('re-resolves the container by project and service label after the tar', () => {
      const script = composeTurnOff();

      // The two label words are `quote()`d since H-21, which for a word with
      // nothing shell-special in it but an `=` means a backslash — the shell
      // strips it to the plain argument, so the `docker ps` this pins looks up
      // the same labels.
      expect(script).toContain(
        'ID=$(docker ps -aq --filter label\\=com.docker.compose.project\\=shop-stack ' +
          '--filter label\\=com.docker.compose.service\\=db || true)',
      );
      // Two lookups, not one reused id — and the second one still runs after
      // the tar. Since H-96 that is no longer a claim about where the words sit:
      // the second lookup is inside `restore_workload`, which is *defined*
      // before the stop and *called* from the subshell's `EXIT` trap, so the
      // text now reads in the opposite order to the execution. The order that
      // matters is asserted by running the script — see
      // "buildVolumeBackupScript, executed under /bin/sh" at the bottom of this
      // file, whose call log has the
      // `docker ps -aq` after the tar on both the happy path and the abort.
      expect(script.match(/ID=\$\(docker ps/g)).toHaveLength(2);
      expect(script.indexOf('docker ps -aq')).toBeLessThan(
        script.indexOf('docker start $ID'),
      );
      // `toContain` first, and not tidiness: `indexOf` of an absent needle is
      // -1, which is less than every real index, so the two orderings below
      // would have **passed on the pre-H-96 script** where neither string
      // exists at all. That is precisely the vacuity H-95 found in H-92's proof,
      // arriving here in the same commit that fixes what it is about.
      expect(script).toContain('restore_workload() {');
      expect(script).toContain('trap restore_workload EXIT');
      expect(script.indexOf('restore_workload() {')).toBeLessThan(
        script.indexOf('tar cvf'),
      );
      expect(script.indexOf('trap restore_workload EXIT')).toBeLessThan(
        script.indexOf('docker stop $ID'),
      );
      // `-aq`, because the container being looked for is the one this script
      // exited, and `docker ps -q` lists only running ones.
      expect(script).not.toContain(
        'ID=$(docker ps -q --filter label\\=com.docker.compose.project\\=shop-stack --filter label\\=com.docker.compose.service\\=db || true)',
      );
    });

    it('uploads the tarball and reports the missing container when nothing is found to restart', () => {
      const script = composeTurnOff();
      const restart = script.slice(
        script.indexOf('echo "Looking for the compose container to restart"'),
        script.indexOf('echo "Starting upload to S3..."'),
      );

      // `[ -z "$ID" ]` and an early `return 0` since H-96, where it was
      // `[ -n "$ID" ]` round the restart: the restart is a shell function now,
      // and the shape that reads as "nothing to do, we are done here" is the one
      // that cannot fall through into the failure diagnosis below it.
      expect(restart).toContain('if [ -z "$ID" ]');
      expect(restart).toContain('docker start $ID');
      // The restart is announced inside the branch that performs it. This is a
      // log an operator reads back, and announcing it above the lookup made the
      // log claim a restart the very next line took back.
      expect(restart.indexOf('if [ -z "$ID" ]')).toBeLessThan(
        restart.indexOf('echo "Starting compose container"'),
      );
      expect(restart).toContain(
        'echo "No compose container found to restart — the compose service was ' +
          'left with none and the upload continues"',
      );
      // Finding no container does not abort the run, and the upload is outside
      // the function — so the tarball reaches the bucket either way. This is the
      // confirmed failure the issue exists for.
      //
      // H-96 narrowed this from "nothing here aborts" to "*this* outcome does
      // not abort": the branch that finds no container returns 0, and the one
      // where `docker start` itself fails ends `exit 1`. The distinction is the
      // whole point — "the operator removed the containers" is a legitimate
      // answer and "the container would not start" is an outage, and a single
      // `|| true` over both is a guard whose failure mode is allow (H-74).
      const nothingToRestart = restart.slice(
        restart.indexOf('if [ -z "$ID" ]'),
        restart.indexOf('echo "Starting compose container"'),
      );
      expect(nothingToRestart).toContain('return 0');
      expect(nothingToRestart).not.toContain('exit');
      expect(restart).toContain('exit 1');
      expect(restart).not.toContain('docker start $ID || true');
      expect(restart).not.toContain('rclone');
      expect(script.indexOf('rclone copyto')).toBeGreaterThan(
        script.indexOf('No compose container found to restart'),
      );
    });

    it('leaves the swarm paths addressing their service by name', () => {
      const application = backupFor({
        turnOff: true,
        target: { serviceType: 'application', appName: 'main-app' },
      });
      const stack = backupFor({
        turnOff: true,
        target: {
          serviceType: 'compose',
          appName: 'shop-stack',
          serviceName: 'db',
          composeType: 'stack',
        },
      });

      // Double-quoted since H-96: the `case` guard that proves the count is
      // digits runs in the outer shell and this use runs inside the trap's
      // subshell, so the quoting is what survives someone later moving one of
      // the two — the same "the charset stands behind the quoting, not in place
      // of it" ordering this module states at three other sinks.
      expect(application).toContain(
        'docker service update --replicas="$ACTUAL_REPLICAS" --with-registry-auth main-app',
      );
      expect(stack).toContain(
        'docker service update --replicas="$ACTUAL_REPLICAS" --with-registry-auth shop-stack_db',
      );
      // Neither has a container id to go stale, so neither grew a re-resolve.
      expect(application).not.toContain('docker ps');
      expect(stack).not.toContain('docker ps');
    });
  });

  /**
   * H-92 read this file's two `docker service inspect` lines as a sixth and
   * seventh site of the phase's unquoted-probe family and found them **already
   * quoted** — `service` and `stackService` are `quote()`d once each above,
   * which is H-21's fix and the reason all four places that name either of them
   * cannot drift apart on the question. Nothing changed here.
   *
   * What was missing was this: the turn-off branches had no injection test of
   * their own, so the register's read had to be taken from the source. The
   * restore's equivalents are proven under `sh` at the bottom of this file; the
   * backup's whole script needs the same stub `PATH`, and what is worth pinning
   * against a future edit is the property rather than the run — that a name
   * changes the script's *words* and none of its syntax, `$(docker service
   * inspect …)`'s own substitution included, which is what the two-arm helper
   * exists to say.
   */
  describe('the swarm names the turn-off branches address (H-92)', () => {
    const poisonedAndInert = (name: string) =>
      [
        backupFor({
          turnOff: true,
          target: { serviceType: 'application', appName: name },
        }),
        backupFor({
          turnOff: true,
          target: {
            serviceType: 'compose',
            appName: name,
            serviceName: name,
            composeType: 'stack',
          },
        }),
      ] as const;

    it('keeps a separator and a substitution inside one word', () => {
      const [application, stack] = poisonedAndInert(SEPARATOR_PAYLOAD);
      const [inertApplication, inertStack] = poisonedAndInert(INERT_VALUE);

      expectValueIsInert(application, inertApplication);
      // `serviceName` is `z.string().optional()` with no charset of its own, and
      // the stack's word is assembled — `${appName}_${serviceName}` — so it is
      // the arm where the quoting is the only thing standing.
      expectValueIsInert(stack, inertStack);
    });
  });
});

describe('buildVolumeRestoreScript', () => {
  it('application: downloads the tar and restores it, refusing in-use volumes', () => {
    expect(
      buildVolumeRestoreScript({
        serverId: FIXTURE_SERVER_ID,
        volumeName: 'shop-data',
        backupFileName: 'main-app/daily/shop-data-2026-07-23T10-20-30-456Z.tar',
        bucket: 'cloudgate-backups',
        target: { serviceType: 'application', appName: 'main-app' },
      }),
    ).toBe(PINNED_VOLUME_SCRIPTS.restoreApplication);
  });

  /**
   * H-19: `downloadStep`'s `mkdir -p ${volumeBackupPath}` was bare, and the
   * word is `{volumeBackupsDirectory()}/{volumeName}` — so a `;` in
   * `volumeName` ended the command and what followed was a second one, run by
   * `execAsyncRemote` on the target Server as the account that drives Docker.
   *
   * This is the one of H-19's three sinks that was **live**. Its two siblings
   * interpolate an `appName`, which `APP_NAME_REGEX` holds at its mint;
   * `volumeName` is not an `appName`, has no mint, and arrived from
   * `restoreVolumeBackupSchema` as `z.string().min(1)`. The word is `quote()`d
   * now and the DTO refuses a name Docker itself would refuse behind it — and
   * these tests use a payload that DTO rejects on purpose, because a builder
   * that is only safe on values someone else filtered is the arrangement that
   * failed before, including at H-12.
   *
   * The proof is `sh`'s: the emitted `mkdir -p` line is run on its own, in a
   * temporary directory, and what is asserted is what is on disk afterwards.
   * The rest of the script needs the stub `PATH` the executed-shell block at
   * the bottom of this file builds; this one line needs nothing.
   */
  describe('the staging directory is one word (H-19)', () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-volume-staging-')),
    );
    const original = process.env.CLOUDGATE_DIRECTORY;

    beforeAll(() => {
      process.env.CLOUDGATE_DIRECTORY = root;
    });

    afterAll(() => {
      if (original === undefined) delete process.env.CLOUDGATE_DIRECTORY;
      else process.env.CLOUDGATE_DIRECTORY = original;
      fs.rmSync(root, { recursive: true, force: true });
    });

    afterEach(() => {
      fs.rmSync(path.join(root, 'volume-backups'), {
        recursive: true,
        force: true,
      });
    });

    /** The one `mkdir -p` the restore emits, run with the temporary root as
     * its cwd so a payload that escapes the word lands where this can see it. */
    const runStagingMkdir = (volumeName: string) => {
      const line = buildVolumeRestoreScript({
        serverId: null,
        volumeName,
        backupFileName: 'main-app/daily/shop-data.tar',
        bucket: 'cloudgate-backups',
        target: { serviceType: 'application', appName: 'main-app' },
      })
        .split('\n')
        .map((text) => text.trim())
        .filter((text) => text.startsWith('mkdir -p '));
      expect(line).toHaveLength(1);
      return spawnSync('sh', ['-c', line[0]], { cwd: root, encoding: 'utf8' });
    };

    it('stages a legitimate volume under the volume-backups directory', () => {
      expect(runStagingMkdir('shop-data').status).toBe(0);
      expect(fs.readdirSync(path.join(root, 'volume-backups'))).toEqual([
        'shop-data',
      ]);
    });

    it('keeps a statement separator and a space inside one word', () => {
      expect(runStagingMkdir('x;touch pwned #').status).toBe(0);

      expect(fs.readdirSync(path.join(root, 'volume-backups'))).toEqual([
        'x;touch pwned #',
      ]);
      // Nothing after the `;` ran.
      expect(fs.existsSync(path.join(root, 'pwned'))).toBe(false);
    });

    it('keeps a command substitution inside one word', () => {
      expect(runStagingMkdir('a$(touch pwned)').status).toBe(0);

      expect(fs.readdirSync(path.join(root, 'volume-backups'))).toEqual([
        'a$(touch pwned)',
      ]);
      expect(fs.existsSync(path.join(root, 'pwned'))).toBe(false);
    });
  });

  /**
   * H-32 finishes what H-19 started: the same function's other ~25
   * interpolations — `docker volume rm`, `docker volume create`, both `-v`
   * mounts, both `tar`s, the three `--filter` words, `rclone copyto`, the `-s`
   * test, the `trap`, and every `echo` that names the volume, the key or the
   * bucket. H-31 does the lock preamble `withVolumeLock` wraps all of it in.
   *
   * So this runs the **whole script**, not one line of it, and asserts on the
   * filesystem afterwards. The payload is a `$(touch …)`: nothing between the
   * DTO and the run host would word-split it, and every one of those sinks was
   * either bare or in double quotes, where a substitution runs either way. One
   * unquoted survivor anywhere in the script and the file appears.
   *
   * `PATH` is the stub directory alone and deliberately has no `touch` on it —
   * so a payload that did escape would also leave a non-zero status behind it,
   * and the status is asserted too.
   */
  describe('the whole restore script is one word per value (H-31, H-32)', () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-restore-hostile-')),
    );
    const binDir = path.join(root, 'bin');
    const original = process.env.CLOUDGATE_DIRECTORY;

    /** Answers "the volume does not exist" so the run takes the short path
     * through to the replace phase, and records nothing it is not asked for. */
    const DOCKER_STUB = `#!/bin/sh
case "$1 $2" in
	"volume ls") ;;
	*) ;;
esac
exit 0
`;
    /** Writes the file its last argument names, the way `rclone copyto` does. */
    const RCLONE_STUB = `#!/bin/sh
if [ "$1" = lsjson ]; then echo '[]'; exit 0; fi
for arg in "$@"; do dest=$arg; done
mkdir -p "\${dest%/*}"
printf 'tarball' > "$dest"
exit 0
`;

    beforeAll(() => {
      fs.mkdirSync(binDir);
      for (const name of ['mkdir', 'rm', 'sleep', 'wc', 'tr']) {
        const resolved = spawnSync('/bin/sh', ['-c', `command -v ${name}`], {
          encoding: 'utf8',
        }).stdout.trim();
        if (!resolved)
          throw new Error(`the executed shell needs ${name} on PATH`);
        fs.symlinkSync(resolved, path.join(binDir, name));
      }
      fs.writeFileSync(path.join(binDir, 'docker'), DOCKER_STUB, {
        mode: 0o755,
      });
      fs.writeFileSync(path.join(binDir, 'rclone'), RCLONE_STUB, {
        mode: 0o755,
      });
      process.env.CLOUDGATE_DIRECTORY = root;
    });

    afterAll(() => {
      if (original === undefined) delete process.env.CLOUDGATE_DIRECTORY;
      else process.env.CLOUDGATE_DIRECTORY = original;
      fs.rmSync(root, { recursive: true, force: true });
    });

    afterEach(() => {
      fs.rmSync(path.join(root, 'volume-backups'), {
        recursive: true,
        force: true,
      });
      fs.rmSync(path.join(root, 'pwned'), { force: true });
    });

    const runRestore = ({
      volumeName = 'shop-data',
      backupFileName = 'main-app/daily/shop-data.tar',
      bucket = 'cloudgate-backups',
      appName = 'main-app',
    }: {
      volumeName?: string;
      backupFileName?: string;
      bucket?: string;
      appName?: string;
    }) => {
      const scriptFile = path.join(root, 'restore.sh');
      fs.writeFileSync(
        scriptFile,
        buildVolumeRestoreScript({
          serverId: null,
          volumeName,
          backupFileName,
          bucket,
          target: { serviceType: 'application', appName },
        }),
      );
      return spawnSync('/bin/sh', [scriptFile], {
        cwd: root,
        encoding: 'utf8',
        env: { PATH: binDir },
      });
    };

    it('restores a legitimate volume end to end under the stubs', () => {
      const { status, stdout } = runRestore({});

      expect(status).toBe(0);
      expect(stdout).toContain('Volume restore completed ✅');
    });

    for (const [what, volumeName] of [
      ['a command substitution', 'a$(touch pwned)'],
      ['a backtick substitution', 'a`touch pwned`'],
      ['a statement separator', 'x;touch pwned #'],
    ] as const) {
      it(`runs nothing for a volume name carrying ${what}`, () => {
        const { status } = runRestore({ volumeName });

        expect(fs.existsSync(path.join(root, 'pwned'))).toBe(false);
        expect(status).toBe(0);
      });
    }

    it('runs nothing for an object key or a bucket carrying a substitution', () => {
      // `backupFileName` reaches `tar -tf`, the `bash -c` program and five
      // `echo`s; `bucket` reaches three of the same `echo`s. Both were
      // `z.string().min(1)` before H-19 and neither is a volume name, so
      // neither is covered by the volume-name charset behind this.
      expect(
        runRestore({ backupFileName: 'k/$(touch pwned).tar' }).status,
      ).toBe(0);
      expect(fs.existsSync(path.join(root, 'pwned'))).toBe(false);

      expect(runRestore({ bucket: 'b$(touch pwned)' }).status).toBe(0);
      expect(fs.existsSync(path.join(root, 'pwned'))).toBe(false);
    });

    it('runs nothing for an appName carrying a substitution', () => {
      // `appName` only styles the banner and the in-use refusal's step 1, and
      // `APP_NAME_REGEX` holds it at its mint — which is exactly the reliance
      // this pass exists to stop resting on.
      expect(runRestore({ appName: 'a$(touch pwned)' }).status).toBe(0);
      expect(fs.existsSync(path.join(root, 'pwned'))).toBe(false);
    });
  });

  // A restore downloads the tarball into
  // `<CLOUDGATE_DIRECTORY>/volume-backups/<volumeName>` and untars it; left
  // there, every restore would permanently cost the volume's own size on the
  // platform host.
  //
  // The trap is how that removal is now spelled. It was a plain statement after
  // the untar plus a hand-rolled copy in the failed-download abort, and `set
  // -e` aborts the script at a failing `docker run … tar xvf` — so the one exit
  // that leaves a whole volume's worth of tarball behind was the one exit with
  // no cleanup on it. What the executed-shell block at the bottom of this file
  // proves is the behaviour; what these assertions pin is that there is exactly
  // **one** mechanism doing it, since two is what let one of them be forgotten.
  describe('the downloaded tarball is removed', () => {
    const STAGING = `${platformHostRoot()}/volume-backups`;
    const TARBALL = `${STAGING}/shop-data/main-app/daily/shop-data-2026-07-23T10-20-30-456Z.tar`;
    const restore = () =>
      buildVolumeRestoreScript({
        serverId: null,
        volumeName: 'shop-data',
        backupFileName: 'main-app/daily/shop-data-2026-07-23T10-20-30-456Z.tar',
        bucket: 'cloudgate-backups',
        target: { serviceType: 'application', appName: 'main-app' },
      });

    it('removes it from a trap, so every exit from the staged phase is covered', () => {
      const script = restore();

      // The tarball word inside the trap is `quote()`d since H-32 — the trap
      // body is a shell program evaluated when the trap fires, so a `$(…)` in
      // the key substituted there however the outer `'…'` was written.
      expect(script).toContain(
        `trap 'rm -f ${TARBALL}; echo "Local backup file cleaned up ✅"' EXIT`,
      );
      // One removal of the tarball in the whole script, and it is the trap's.
      // The tail statement after the untar and the hand-rolled copy inside the
      // failed-download abort are both gone — that pair is what the trap
      // replaced.
      expect(script.match(new RegExp(`rm -f ${TARBALL}`, 'g'))).toHaveLength(1);
      expect(script).not.toContain(`\trm "${TARBALL}"`);
      expect(script.match(/Local backup file cleaned up/g)).toHaveLength(1);
    });

    it('registers the trap after the mkdir, and before anything can be staged', () => {
      const script = restore();

      // After `mkdir -p`, so a run that never created the staging directory
      // cannot arrive at a cleanup for it; before the rclone, so there is no
      // window in which a tarball exists and nothing is registered to remove it.
      //
      // `toContain` first, for the reason H-95 gives further up: an absent
      // needle's `indexOf` is -1, which is less than every real index. Under a
      // relocated root the literal `/etc/cloudgate` this used to name was
      // exactly that, and the ordering passed on a line it never found.
      const mkdir = `mkdir -p ${STAGING}/shop-data`;
      expect(script).toContain(mkdir);
      expect(script.indexOf(mkdir)).toBeLessThan(script.indexOf("trap 'rm -f"));
      expect(script.indexOf("trap 'rm -f")).toBeLessThan(
        script.indexOf('rclone copyto'),
      );
    });

    it('is registered inside a subshell, so it cannot replace the lock’s own trap', () => {
      const script = restore();

      // `trap` sets rather than appends. The volume lock's `mkdir` fallback —
      // every host without `flock` — registers `trap 'rm -rf "$LOCK_DIR"' EXIT`
      // around this body, and a second registration in the same shell would
      // discard it, leaking the lock directory and wedging the volume for every
      // later backup and restore of it.
      expect(script).toContain(`trap 'rm -rf "$LOCK_DIR"' EXIT`);
      expect(script.indexOf(`trap 'rm -rf "$LOCK_DIR"' EXIT`)).toBeLessThan(
        script.indexOf('\t(\n'),
      );
      expect(script.indexOf('\t(\n')).toBeLessThan(
        script.indexOf("trap 'rm -f"),
      );
      expect(script.indexOf("trap 'rm -f")).toBeLessThan(
        script.indexOf('\n\t)\n'),
      );
    });

    it('prunes no directory, because the staging path is shared by every run', () => {
      // Deliberate, and the smaller half of the two ways triage offered
      // to make this safe: `<root>/volume-backups/<volume>` is per
      // volume, not per run, so a `find … -type d -empty -delete` in a trap
      // gives a failing run a way to rmdir a directory a concurrent healthy run
      // is downloading into. The accepted cost is the empty directories the S3
      // key nests the tarball in, which is what an earlier cleanup used to take
      // away.
      expect(restore()).not.toContain('-type d -empty -delete');
    });

    it('names only its own tarball, so one failing restore cannot touch another', () => {
      const shop = restore();
      const blog = buildVolumeRestoreScript({
        serverId: null,
        volumeName: 'blog-data',
        backupFileName: 'blog/daily/blog-data-2026-07-23T10-20-30-456Z.tar',
        bucket: 'cloudgate-backups',
        target: { serviceType: 'application', appName: 'blog-app' },
      });

      // The trap is a fixed path, interpolated with this run's own volume and
      // its own key, and it removes a file rather than a tree — so a restore of
      // `shop-data` that aborts has no expression in it that could reach
      // `blog-data`'s staging directory, whatever order the two run in.
      expect(shop).toContain(`trap 'rm -f ${TARBALL};`);
      expect(shop).not.toContain('blog-data');
      expect(blog).not.toContain('shop-data');
      for (const script of [shop, blog]) {
        // Nothing under the staging root is removed as a tree or by a search:
        // the only `rm -rf` in either script is the lock preamble's, over the
        // lock directory. Both spellings, because `quote()` emits a path with
        // nothing shell-special in it bare: the quoted needle alone was all
        // these used to check, and it could never have matched.
        for (const verb of ['rm -rf', 'find']) {
          expect(script).not.toContain(`${verb} ${STAGING}`);
          expect(script).not.toContain(`${verb} "${STAGING}`);
        }
        expect(script).not.toContain('-type d -empty -delete');
      }
    });
  });

  // The "exists but free" branch ran `docker volume rm --force` *before*
  // the download, and `rclone copyto` of an object that does not exist exits 0
  // — so a mistyped key removed the volume, re-created it empty and answered
  // 400, and an unreachable bucket removed it and never re-created it at all.
  describe('the volume is not touched until the tarball is in hand', () => {
    const restore = () =>
      buildVolumeRestoreScript({
        serverId: null,
        volumeName: 'shop-data',
        backupFileName: 'main-app/daily/shop-data-2026-07-23T10-20-30-456Z.tar',
        bucket: 'cloudgate-backups',
        target: { serviceType: 'application', appName: 'main-app' },
      });
    const REMOVAL = 'docker volume rm shop-data --force';

    it('reaches no volume removal before the download has been proven', () => {
      const script = restore();

      // One removal in the whole script, so there is no second copy of it for
      // a later branch to reach early.
      expect(script.match(/docker volume rm shop-data --force/g)).toHaveLength(
        1,
      );
      expect(script.indexOf('rclone copyto')).toBeLessThan(
        script.indexOf(REMOVAL),
      );
      expect(script.indexOf('if [ ! -s ')).toBeLessThan(
        script.indexOf(REMOVAL),
      );
      // And nothing else that writes to the volume is in front of the download
      // either.
      expect(script.indexOf('rclone copyto')).toBeLessThan(
        script.indexOf('docker volume create'),
      );
      expect(script.indexOf('rclone copyto')).toBeLessThan(
        script.indexOf('tar xvf'),
      );
    });

    // The quirk this whole issue turns on: `set -e` catches an unreachable
    // bucket and catches bad credentials, but a key that is not there is not an
    // error to rclone at all. So the local file is what gets tested.
    it('refuses on an rclone copyto that exited 0 without leaving a tarball', () => {
      const script = restore();
      const tarball = `${platformHostRoot()}/volume-backups/shop-data/main-app/daily/shop-data-2026-07-23T10-20-30-456Z.tar`;

      expect(script).toContain(`if [ ! -s ${tarball} ]; then`);
      // `-s`, not `-f`: the quirk's other shape is a zero-byte file where a tar
      // should be, and a tar of even an empty volume is 10 KiB. Written without
      // the quotes the operand used to carry (H-32 `quote()`s it, and a plain
      // path needs none), so the negative still names the operator it refuses
      // rather than passing because the spelling moved underneath it.
      expect(script).not.toContain(`if [ ! -f ${tarball} ]`);
      expect(script).toContain(
        'echo "❌ Volume restore aborted - the backup file did not download"',
      );
      // The 400 the caller reads says the volume was left alone — the old one
      // stopped at "Creating new volume and restoring data..." and said nothing
      // about having removed anything.
      expect(script).toContain(
        `echo "   Volume 'shop-data' has not been touched and still holds the data it held before this restore."`,
      );
      // Named where a later reader would otherwise delete the check.
      expect(script).toContain(
        `'rclone copyto' reports success for a key that does not exist`,
      );
    });

    // `-s` answers "are there bytes", not "are these bytes an archive".
    // A 200 000-byte object of /dev/urandom uploaded under a `.tar` name passed
    // it, the volume was removed, and the `tar xvf` failed into an emptied one.
    it('reads the archive’s headers before the volume is at risk', () => {
      const script = restore();
      const validation =
        'tar -tf /backup/main-app/daily/shop-data-2026-07-23T10-20-30-456Z.tar';

      expect(script).toContain(validation);
      // The whole property, and the one an index comparison cannot satisfy by
      // accident: the read is on the safe side of the destruction.
      expect(script.indexOf(validation)).toBeLessThan(script.indexOf(REMOVAL));
      expect(script.indexOf(validation)).toBeLessThan(
        script.indexOf('docker volume create'),
      );
      // …and on the far side of the two cheaper proofs, which is the only order
      // that makes sense: bytes exist, bytes are an archive, then destroy.
      expect(script.indexOf('rclone copyto')).toBeLessThan(
        script.indexOf(validation),
      );
      expect(script.indexOf('if [ ! -s ')).toBeLessThan(
        script.indexOf(validation),
      );
      // Judged by the `tar` that will extract it, not the host's — the BSD `wc`
      // bug is what a divergence between two implementations costs here.
      expect(script).toContain('ubuntu');
      // The volume is deliberately not mounted into the step that runs while it
      // is still safe: one mount of it in the whole script, and it belongs to
      // the extraction. A second would create a reference where this step has
      // just finished proving none is needed.
      // `-v` carries a value, so H-32 `quote()`s it and shell-quote escapes
      // the `:` with a backslash — `sh` strips it back to the same argument.
      // The claim is that there is exactly *one* such mount.
      expect(script.match(/-v shop-data\\:\/volume_data/g)).toHaveLength(1);
      expect(script).toContain(
        'echo "❌ Volume restore aborted - the downloaded file is not a readable tar archive"',
      );
      expect(script).toContain(
        `echo "   Volume 'shop-data' has not been touched and still holds the data it held before this restore."`,
      );
    });

    it('skips the removal when there was no volume to remove', () => {
      const script = restore();

      // The removal is guarded by the same answer the in-use guard read, so
      // the branch that found no volume runs the same download and untar
      // without a `docker volume rm` of a name that does not exist.
      expect(script).toContain('if [ "$VOLUME_EXISTS" != "0" ]; then');
      expect(
        script.indexOf('if [ "$VOLUME_EXISTS" != "0" ]; then'),
      ).toBeLessThan(script.indexOf(REMOVAL));
    });

    it('bounds the download on the restore profile, not the listing one', () => {
      // **Not the listing's flags**, which is what this line shipped with and
      // what was named in advance: this is the one bulk data transfer in front
      // of an HTTP caller, so it gets a longer idle bound (60s, idle rather than
      // total — a multi-GB download to a small host can stall for tens of
      // seconds under memory pressure, and cutting a real restore short would be
      // worse than the hang being fixed) and a connect timeout that tolerates a
      // cross-region endpoint (10s).
      //
      // Unbounded, rclone's 3 retries × 10 low-level retries held one restore —
      // and the volume's lock — open for 5 min 55 s.
      //
      // And the wall clock, which is the only one of the five that bounds the
      // *request* (reopened): the other four bound an attempt, and an
      // endpoint that dribbles rather than refuses is never idle on any single
      // connection — 18 min 03 s was measured here with the volume lock held
      // throughout. `--max-duration` is last, after the four it does not
      // replace.
      // The S3 path is `quote()`d since H-32, which for a `:`-bearing word
      // means backslashes rather than the double quotes it used to carry. The
      // five flags and their order are what this pins.
      expect(restore()).toContain(
        'rclone copyto --retries 1 --low-level-retries 10 --timeout 60s --contimeout 10s ' +
          '--max-duration 30m ' +
          '\\:s3\\:cloudgate-backups/main-app/daily/shop-data-2026-07-23T10-20-30-456Z.tar',
      );
    });

    /**
     * H-120: **`--max-duration` is accepted and inert on the rclone this
     * product installs**, so until this the request bound existed only in the
     * comment above the line.
     *
     * X10 measured it three ways and the last one removes all doubt:
     * `--max-duration 1ms` against a *healthy* endpoint transferred all
     * 157 286 400 bytes, rc=0, in 1 s. On `rclone v1.60.1-DEV` — which is what
     * apt has on the platform `docs/deploy.md` documents, and `deploy/install.sh`
     * installs rclone from apt — `--cutoff-mode` governs `--max-transfer` and
     * not `--max-duration`; the flag reaches `--max-duration` at rclone ≥ 1.64,
     * which apt does not offer.
     *
     * So the bound is the **process**, which does not depend on rclone's
     * version. `timeout` is coreutils and is on every host this ships to, but
     * these scripts also run on a Server over SSH, so it is probed for rather
     * than assumed — the same care taken over `wc`, and the reason this
     * asserts the fallback's shape and not just the happy word.
     */
    it('bounds the download on the process, because the flag that claims to is inert (H-120)', () => {
      const script = restore();

      expect(script).toContain(
        "if command -v timeout >/dev/null 2>&1; then RCLONE_WALL_CLOCK='timeout 1800'; else RCLONE_WALL_CLOCK=''; fi",
      );
      expect(script).toContain('$RCLONE_WALL_CLOCK rclone copyto ');
      // The probe is emitted before the word that expands it, and both are
      // inside the subshell that holds the lock.
      expect(script.indexOf('RCLONE_WALL_CLOCK=')).toBeLessThan(
        script.indexOf('$RCLONE_WALL_CLOCK rclone copyto'),
      );
      // Seconds rather than `30m`: coreutils takes the suffix and busybox's
      // `timeout` does not, and a host with the second one is exactly the host
      // the `command -v` probe exists for.
      expect(script).not.toContain('timeout 30m');
      // The flag stays as the belt for a host that has rclone ≥ 1.64 — it costs
      // nothing and it is not what the bound rests on any more.
      expect(script).toContain('--max-duration 30m');
    });

    it('answers a download its own bound killed with a sentence naming the bound (H-120)', () => {
      const script = restore();

      // `timeout` exits 124 when it fired. Read off a captured status rather
      // than from an `if !` condition, for H-121's reason: `set -e` is
      // suspended for the condition of an `if`.
      expect(script).toContain('DOWNLOAD_STATUS=0');
      expect(script).toContain('if [ "$DOWNLOAD_STATUS" = 124 ]; then');
      expect(script).toContain(
        '❌ Volume restore aborted - the download did not finish inside its 30-minute limit',
      );
      // Every other status is still the download's own, so an unreachable
      // bucket answers exactly what it answered before.
      expect(script).toContain('exit "$DOWNLOAD_STATUS"');
    });

    // G-39 read as "the bound is too tight" and was the opposite: `--retries`
    // restarts the object at byte zero and discards what the failed attempt
    // fetched, while `--low-level-retries` resumes at the offset already on
    // disk. The staged file was watched climbing to 79 MB and 119 MB and being
    // reset until `--retries 2` ran out with nothing, where rclone's own
    // defaults completed the same object over the same link. Paired against the
    // same stalling proxy: 1083 s and 0 B at `2 × 3`, 181 s and every byte here.
    it('spends the retry that restarts the download and keeps the one that resumes it', () => {
      const script = restore();

      expect(script).toContain(
        'rclone copyto --retries 1 --low-level-retries 10',
      );
      // The shipped shape, named so a later reader does not "even them up".
      expect(script).not.toContain('--retries 2');
      expect(script).not.toContain('--low-level-retries 3');
    });
  });

  // The download's retry budget is chosen so a degraded-but-
  // moving link still assembles, and the counter that buys that also governs a
  // connect that never completes — the same flags that took a stalling endpoint
  // from 1083 s-and-nothing to 181 s-and-every-byte take an absent one from
  // 242 s to 641 s. So the endpoint is asked about once, cheaply, first.
  describe('the destination is asked whether it is there at all', () => {
    const restore = () =>
      buildVolumeRestoreScript({
        serverId: null,
        volumeName: 'shop-data',
        backupFileName: 'main-app/daily/shop-data-2026-07-23T10-20-30-456Z.tar',
        bucket: 'cloudgate-backups',
        target: { serviceType: 'application', appName: 'main-app' },
      });

    it('probes on the listing profile, which refuses a dead socket in tens of seconds', () => {
      expect(restore()).toContain(
        'rclone lsjson --retries 1 --low-level-retries 1 --timeout 30s --contimeout 5s ' +
          // The object path is `quote()`d since H-38 — backslashes for a
          // `:`-bearing word rather than the double quotes it used to carry.
          '\\:s3\\:cloudgate-backups/main-app/daily/shop-data-2026-07-23T10-20-30-456Z.tar',
      );
    });

    it('asks before the volume lock is taken, so an absent bucket blocks nothing else', () => {
      const script = restore();

      // The whole of G-39's cost was the lock: `withVolumeLock` is held for the
      // script, so every backup, restore and Remove containers on the volume
      // answers 409 for as long as the download runs.
      expect(script.indexOf('rclone lsjson')).toBeLessThan(
        script.indexOf('LOCK_PATH='),
      );
      expect(script.indexOf('rclone lsjson')).toBeLessThan(
        script.indexOf('rclone copyto'),
      );
      // Nothing was staged either, so a refusal here leaves exactly the state a
      // refusal one line later would.
      expect(script.indexOf('rclone lsjson')).toBeLessThan(
        script.indexOf('mkdir -p'),
      );
    });

    it('answers with rclone’s own line, not only this builder’s sentence', () => {
      const script = restore();

      // `❌` puts the block on the path `rcloneFailureMessage` prefers, which
      // means rclone's diagnosis has to be carried into it rather than left on
      // the script's stderr for that path to discard.
      expect(script).toContain(
        'echo "❌ Volume restore aborted - the backup destination did not answer"',
      );
      expect(script).toContain('echo "$PROBE_ERROR"');
      expect(script).toContain('2>&1 >/dev/null');
      expect(script).toContain(
        `echo "   Volume 'shop-data' has not been touched, and its lock was never taken — nothing else waiting on 'shop-data' was held up by this."`,
      );
    });

    // A key that is not there exits 0 with `[]`, so this probe cannot answer
    // "is the object there" and does not try: that stays with the `-s` test on
    // the downloaded file, which asks the only question the untar cares about.
    it('leaves the absent key to the -s test it cannot answer for', () => {
      const script = restore();

      expect(script.indexOf('rclone lsjson')).toBeLessThan(
        script.indexOf('if [ ! -s '),
      );
      expect(script).toContain(
        'echo "❌ Volume restore aborted - the backup file did not download"',
      );
    });
  });

  // After removing the volume, the restore creates it again explicitly,
  // because letting `docker run -v <name>:/volume_data` create it creates it
  // unlabelled — a restored compose volume would stop answering to
  // `com.docker.compose.project` and nothing that finds volumes by label could
  // find it again.
  it('re-creates the volume explicitly, carrying its labels back', () => {
    const script = buildVolumeRestoreScript({
      serverId: null,
      volumeName: 'shop-data',
      backupFileName: 'main-app/daily/shop-data-2026-07-23T10-20-30-456Z.tar',
      bucket: 'cloudgate-backups',
      target: { serviceType: 'application', appName: 'main-app' },
    });
    // Read off before the removal…
    expect(script).toContain(
      `VOLUME_LABELS=$(docker volume inspect shop-data --format '{{range $k, $v := .Labels}}--label {{$k}}={{$v}} {{end}}')`,
    );
    expect(
      script.indexOf('VOLUME_LABELS=$(docker volume inspect'),
    ).toBeLessThan(script.indexOf('docker volume rm shop-data --force'));
    // …and passed back on a volume this script creates itself, rather than one
    // `docker run -v` conjures. Empty on the branch where there was no volume
    // to read them off, which is what the initialization is for.
    expect(script).toContain('docker volume create $VOLUME_LABELS shop-data');
    expect(script).toContain('VOLUME_LABELS=""');
  });

  // `replaceVolumeCommand` was `rm` → `create` → `tar xvf` → success
  // echo, with no failure branch at all. Under `set -e` the script ended at the
  // failing `tar` and said nothing, so an operator saw a restore that stopped, a
  // volume that now holds nothing it should, and no line connecting the two.
  it('says what the volume now holds when the archive would not extract (H-116)', () => {
    const script = buildVolumeRestoreScript({
      serverId: null,
      volumeName: 'shop-data',
      backupFileName: 'main-app/daily/shop-data-2026-07-23T10-20-30-456Z.tar',
      bucket: 'cloudgate-backups',
      target: { serviceType: 'application', appName: 'main-app' },
    });
    const marker =
      'echo "❌ Volume restore aborted - the archive would not extract"';

    expect(script).toContain(marker);
    // The one side of the destruction this message makes sense on. The two
    // aborts in `downloadStep` get to say "has not been touched"; this one is
    // past the point where that would be a lie, and it is the only phase that
    // can fail after the volume is gone.
    expect(script.indexOf('docker volume rm shop-data --force')).toBeLessThan(
      script.indexOf(marker),
    );
    // The clause that changes what the operator does next — and it said "it is
    // EMPTY" until H-116 read it against a run: this abort fires *during* an
    // extraction, so the volume holds the members that landed before `tar`
    // stopped. Since the tar gate now catches every truncation that loses a data
    // block in front of the removal, the partial is not the unusual case here
    // but the only one left.
    expect(script).toContain(
      'what it holds now is whatever the archive managed to extract before it failed',
    );
    expect(script).not.toContain('EMPTY');
    // The trap removes the staged tarball on the way out of this subshell,
    // so the message must not offer it — the older wording predates that trap and
    // would ship a sentence that is the opposite of what the script does.
    expect(script).toContain(
      `so restoring again re-downloads it from bucket 'cloudgate-backups'.`,
    );
    expect(script).not.toContain('the tarball is still at');
    // `exit 1`, so the caller answers 400; 75 is the volume lock's and means
    // 409. And the success echo is still reached on exactly one path.
    expect(script.match(/echo "Volume restore completed ✅"/g)).toHaveLength(1);
    expect(script.indexOf(marker)).toBeLessThan(
      script.indexOf('echo "Volume restore completed ✅"'),
    );
  });

  // A restore takes the volume lock, because without it a restore could
  // `docker volume rm` and re-create the volume under a backup mid-`tar`, and
  // the tarball that reached the bucket would be a backup of a half-replaced
  // volume with nothing marking it suspect.
  it('holds the volume lock across the in-use guard, and refuses rather than waiting', () => {
    const script = buildVolumeRestoreScript({
      serverId: null,
      volumeName: 'shop-data',
      backupFileName: 'main-app/daily/shop-data-2026-07-23T10-20-30-456Z.tar',
      bucket: 'cloudgate-backups',
      target: { serviceType: 'application', appName: 'main-app' },
    });

    expect(script).toContain(
      `LOCK_PATH=${platformHostRoot()}/volume-backup-lock-shop-data`,
    );
    expect(script).toContain('if ! flock -n 9; then');
    // The marker line is single-quoted since H-31 and its *output* is
    // unchanged, which is what matters: `busyVolumeNameFrom` reads this off
    // stdout to name the volume in the 409, and the shell strips either quote.
    expect(script).toContain("echo 'Volume lock busy: shop-data'");
    expect(script).toContain('exit 75');
    // The guard's answer goes stale the moment it is read, so it is inside the
    // acquisition rather than in front of it.
    expect(script.indexOf('Volume lock acquired: shop-data')).toBeLessThan(
      script.indexOf('VOLUME_EXISTS=$(docker volume ls'),
    );
    // A restore is one synchronous HTTP request, so it never blocks on the
    // lock the way a scheduled backup does.
    expect(script).not.toContain('sleep 5');
  });

  // The refusal used to print "Stop all containers/services using this
  // volume" at every target, and for a `docker-compose` compose stack that is
  // the one instruction that does not work — its Stop runs `docker compose
  // stop`, which leaves the containers exited and still holding the volume. The
  // reporter followed the instruction, watched it not help, and finished the
  // restore from a host shell.
  describe('the in-use refusal names the control that frees the volume', () => {
    const restoreFor = (target: VolumeRestoreTarget) =>
      buildVolumeRestoreScript({
        serverId: null,
        volumeName: 'shop-data',
        backupFileName: 'shop-data-2026-07-23T10-20-30-456Z.tar',
        bucket: 'cloudgate-backups',
        target,
      });

    it('sends a docker-compose compose stack to Remove containers, not to Stop', () => {
      const script = restoreFor({
        serviceType: 'compose',
        appName: 'shop-stack',
        composeType: 'docker-compose',
      });

      expect(script).toContain(
        "1. Use Remove containers on the compose stack 'shop-stack' in Cloudgate",
      );
      expect(script).toContain('Start brings the stack back afterwards');
      // The sentence that sent the reporter to a shell is gone, and so is the
      // step that could not have run while the container existed.
      expect(script).not.toContain('Stop all containers/services');
      expect(script).not.toContain('Remove the existing volume: docker volume');
    });

    it('sends an application to Stop, and says the task history it leaves is the restore’s to remove', () => {
      const script = restoreFor({
        serviceType: 'application',
        appName: 'main-app',
      });

      expect(script).toContain(
        "1. Stop the application 'main-app' in Cloudgate",
      );
      // An Application has no Remove containers control, and needs none: the
      // correction that narrowed this issue to one service type.
      expect(script).not.toContain('Remove containers');
      expect(script).not.toContain('Stop all containers/services');
    });

    it('sends a swarm stack to Stop, and says any task history it leaves is the restore’s to remove', () => {
      const script = restoreFor({
        serviceType: 'compose',
        appName: 'shop-stack',
        composeType: 'stack',
      });

      expect(script).toContain(
        "1. Stop the compose stack 'shop-stack' in Cloudgate",
      );
      expect(script).not.toContain('Remove containers');
      expect(script).not.toContain('Stop all containers/services');
    });

    it('tells every target why removing the volume by hand is not the way out', () => {
      for (const target of [
        { serviceType: 'application' as const, appName: 'main-app' },
        {
          serviceType: 'compose' as const,
          appName: 'shop-stack',
          composeType: 'docker-compose' as const,
        },
        {
          serviceType: 'compose' as const,
          appName: 'shop-stack',
          composeType: 'stack' as const,
        },
      ]) {
        const script = restoreFor(target);
        expect(script).toContain(
          "Docker counts exited containers in a volume's refcount",
        );
        expect(script).toContain(
          "'docker volume rm shop-data' refuses while any container still references it, --force included",
        );
        expect(script).toContain('2. Run the restore operation again');
      }
    });
  });

  it('compose: prints the stack banner around the same check-and-restore script', () => {
    expect(
      buildVolumeRestoreScript({
        serverId: FIXTURE_SERVER_ID,
        volumeName: 'shop-data',
        backupFileName:
          'shop-stack_db/daily/shop-data-2026-07-23T10-20-30-456Z.tar',
        bucket: 'cloudgate-backups',
        target: {
          serviceType: 'compose',
          appName: 'shop-stack',
          composeType: 'stack',
        },
      }),
    ).toBe(PINNED_VOLUME_SCRIPTS.restoreStack);
  });
});

// These scripts are echoed line by line into a log file the console
// serves back, so a `--s3-*` flag in one puts the destination's secret access
// key in front of whoever can read a run log. Neither builder takes a
// credential to interpolate — this asserts the property the whole-script
// equalities above encode, over the lock preamble too.
describe('no generated volume script carries an S3 credential flag', () => {
  it('emits no --s3- flag on any backup or restore path', () => {
    for (const script of Object.values(PINNED_VOLUME_SCRIPTS)) {
      expect(script).not.toContain('--s3-');
    }
  });
});

/**
 * H-129: the `tar` that decides whether an archive is restorable, and the `tar`
 * that does the restoring, were both `docker run --rm ubuntu` — i.e.
 * `ubuntu:latest`. They agree only because they resolve the same tag *within one
 * run*: a tag that moves between one restore and a later one silently changes
 * the tar doing the deciding, and the whole of H-119's gate is the claim that
 * the validating tar and the extracting tar are the same implementation.
 *
 * The unpinned pull is also what H-121's 125/126/127 branch exists for — X10's
 * evidence is that `ubuntu:latest` was not on the box at all, so the first
 * restore on any host pulls it *inside* the restore.
 *
 * Asserted over every entry rather than at the three literals, because the
 * failure this pins is the two builders drifting apart (§1.4) — which is exactly
 * what three separate string literals allow and one constant does not.
 *
 * `VOLUME_TAR_IMAGE` is the unit, and it is module-private to
 * `volume-backup-commands.ts` rather than imported here on purpose: an
 * expectation that read the constant would hold whatever the constant became,
 * so the tag is written out (§1.7).
 */
describe('VOLUME_TAR_IMAGE — the image every containerised tar runs (H-129)', () => {
  /** Every image word of every `docker run` in a generated script: the word
   * after the last `-v` mount, which is where both builders put it. */
  const imagesOf = (script: string): string[] =>
    [...script.matchAll(/docker run --rm\s+(?:-v\s+\S+\s+)+(\S+)\s/g)].map(
      (match) => match[1],
    );

  it('names one exact tag in every docker run of every path', () => {
    for (const [name, script] of Object.entries(PINNED_VOLUME_SCRIPTS)) {
      const images = imagesOf(script);

      expect(images.length).toBeGreaterThan(0);
      for (const image of images) {
        expect([name, image]).toEqual([name, 'ubuntu:24.04']);
      }
    }
  });

  it('runs the same image in the validation and the extraction', () => {
    // The two are the halves of one claim — the gate's verdict is only worth
    // anything if the tar that gave it is the tar that extracts — so drift
    // between them is the failure, not the tag itself.
    const restore = PINNED_VOLUME_SCRIPTS.restoreApplication;
    const backup = PINNED_VOLUME_SCRIPTS.plain;

    expect(new Set(imagesOf(restore)).size).toBe(1);
    expect(new Set([...imagesOf(restore), ...imagesOf(backup)]).size).toBe(1);
  });
});

/**
 * These run the generated restore script rather than asserting strings about
 * it, in the shape `test/deployment-engine/volume-lock.spec.ts` established.
 *
 * `PATH` is curated down to one directory: the three stubs below, plus symlinks
 * to the handful of real utilities these scripts call. That is not tidiness,
 * it is the point of the whole block.
 *
 * - **The only `wc` reachable from here is the padding stub**. A test
 *   that shelled out to the host's `wc` would pass on a GNU host and fail on a
 *   BSD one for reasons that have nothing to do with this code — and the
 *   defect being fixed is invisible on Ubuntu, which is what CI runs. Curating
 *   `PATH` pins the hostile `wc` instead of hoping for one.
 * - **`flock` is deliberately absent**, which pins the volume lock's `mkdir`
 *   fallback — the one branch that registers `trap 'rm -rf "$LOCK_DIR"' EXIT`,
 *   and therefore the branch the cleanup's own `trap … EXIT` would replace
 *   outright if it were registered in the same shell rather than in a subshell.
 *
 * `sh`, not `bash`: the restore is handed to `sh` with no shell option
 * (`volume-backups.service.ts` → `execRclone`).
 */
describe('the generated restore shell, executed', () => {
  /** Answers `docker volume ls -q` from `$STUB_VOLUME_EXISTS`, fails a
   * `volume inspect` of a volume that is not there the way the daemon does
   * (which is what made the BSD `wc` bug fatal rather than cosmetic), and
   * fails the untar on `$STUB_UNTAR_FAILS` — the abort the trap now covers.
   *
   * The `docker run --rm` calls the restore makes are told apart by their
   * arguments, not by their position: the header reads are `tar -tf` and the
   * extraction is `bash -c`, and only the reads answer to
   * `$STUB_TARBALL_CORRUPT`. A stub that failed both on one variable could not
   * express the case this file exists to pin — an object that is not an archive,
   * caught while the volume is still intact.
   *
   * **The two header reads are told apart by the trailing `.` (H-119).** The
   * gate's first read carries the extraction's own member selector and the
   * second does not, and the difference between them is the whole finding: a
   * `tar cf archive.tar mydir/` answers *yes* to "are these bytes a readable
   * tar" and *no* to "is there a member `tar xvf … .` can extract", which is the
   * question the removal depends on. `$STUB_TARBALL_FOREIGN` is that archive —
   * exit 0 without the selector, exit 2 and `tar: .: Not found in archive` with
   * it. Both statuses were read off a real `ubuntu` container against a real
   * 12 KB `tar -cf foreign.tar vol` before being written here.
   *
   * `$STUB_DOCKER_CANNOT_RUN` is H-121: `docker run` itself failing, which it
   * answers with **125** the way the real CLI does for an unreachable daemon or
   * an image it cannot pull. Not a hypothetical fixture — `ubuntu:latest` is not
   * on a fresh host, so the first restore on one pulls it inside the restore. */
  const DOCKER_STUB = `#!/bin/sh
echo "docker $*" >> "$STUB_LOG"
case "$1 $2" in
	"volume ls")
		if [ "$STUB_VOLUME_EXISTS" = yes ]; then echo shop-data; fi
		;;
	"volume inspect")
		if [ "$STUB_VOLUME_EXISTS" != yes ]; then
			echo "Error response from daemon: get shop-data: no such volume" >&2
			exit 1
		fi
		echo "--label com.docker.compose.project=shop-stack "
		;;
	"ps -a")
		if [ -n "$STUB_CONTAINERS" ]; then printf '%s\\n' "$STUB_CONTAINERS"; fi
		;;
	"service inspect")
		for arg in "$@"; do svc=$arg; done
		if [ "$STUB_SERVICE_INSPECT_FAILS" = 1 ]; then
			echo "Error response from daemon: This node is not a swarm manager." >&2
			exit 1
		fi
		replicas=$(printf '%s\\n' $STUB_SERVICES $(cat "$STUB_LOG.services" 2>/dev/null) | grep "^$svc=" | tail -n 1 | cut -d= -f2)
		if [ -z "$replicas" ]; then
			echo "Error response from daemon: service $svc not found" >&2
			exit 1
		fi
		echo "$replicas"
		;;
	"service update")
		# Remembered, so a later inspect answers the count it was scaled to.
		for arg in "$@"; do svc=$arg; done
		for arg in "$@"; do
			case "$arg" in --replicas=*) echo "$svc=\${arg#--replicas=}" >> "$STUB_LOG.services" ;; esac
		done
		if [ "$STUB_SCALE_UP_FAILS" = 1 ] && [ "$3" != "--replicas=0" ]; then
			echo "Error response from daemon: rpc error: update out of sequence" >&2
			exit 1
		fi
		;;
	"rm "*)
		# Per container, the way the real CLI answers a list: each one it
		# removes is echoed on stdout, each it cannot is a line on stderr, and
		# the status is 1 if any of them failed.
		if [ "$STUB_RM_SILENT" = 1 ]; then exit 1; fi
		shift
		rm_status=0
		for id in "$@"; do
			case " $STUB_RM_GONE " in
				(*" $id "*)
					echo "Error response from daemon: No such container: $id" >&2
					rm_status=1
					continue
					;;
			esac
			if [ "$STUB_RM_FAILS" = 1 ]; then
				echo "Error response from daemon: cannot remove container \\"/main-app.1.$id\\": container is running: stop the container before removing or force remove" >&2
				rm_status=1
				continue
			fi
			echo "$id"
		done
		exit $rm_status
		;;
	"run --rm")
		case "$*" in
			*"tar -tf"*)
				if [ "$STUB_DOCKER_CANNOT_RUN" = 1 ]; then
					echo "Unable to find image 'ubuntu:latest' locally" >&2
					echo "docker: Error response from daemon: toomanyrequests: You have reached your pull rate limit." >&2
					exit 125
				fi
				if [ "$STUB_TARBALL_CORRUPT" = 1 ]; then
					echo "tar: This does not look like a tar archive" >&2
					echo "tar: Exiting with failure status due to previous errors" >&2
					exit 2
				fi
				# The selector run ends in ' .', the second read does not.
				case "$*" in
					*" .")
						if [ "$STUB_TARBALL_FOREIGN" = 1 ]; then
							echo "tar: .: Not found in archive" >&2
							echo "tar: Exiting with failure status due to previous errors" >&2
							exit 2
						fi
						;;
					*)
						echo "vol/"
						echo "vol/real.txt"
						;;
				esac
				;;
			*)
				if [ "$STUB_UNTAR_FAILS" = 1 ]; then
					echo "tar: /backup: Cannot open: No such file or directory" >&2
					exit 2
				fi
				;;
		esac
		;;
esac
exit 0
`;

  /** Writes the tarball its last argument names, creating the directories the
   * S3 key nests it in the way `rclone copyto` does. `$STUB_RCLONE_BYTES=0` is
   * the quirk the empty-download message turned on: exit 0, no bytes.
   *
   * `lsjson` is answered separately and writes nothing: it is the
   * reachability probe, its last argument is the S3 path rather than a local
   * one, and treating it like the download would have this stub create a
   * `:s3:…` directory in the working directory. `$STUB_RCLONE_UNREACHABLE=1` is
   * the endpoint that does not answer — a status and a line on stderr, which is
   * what the probe captures and what its abort echoes back. */
  const RCLONE_STUB = `#!/bin/sh
echo "rclone $*" >> "$STUB_LOG"
if [ "$1" = lsjson ]; then
	if [ "$STUB_RCLONE_UNREACHABLE" = 1 ]; then
		echo "ERROR : : error listing: RequestError: send request failed" >&2
		exit 1
	fi
	echo '[]'
	exit 0
fi
for arg in "$@"; do dest=$arg; done
mkdir -p "\${dest%/*}"
if [ "$STUB_RCLONE_BYTES" = 0 ]; then
	: > "$dest"
else
	printf 'tarball' > "$dest"
fi
exit 0
`;

  /** A `wc` that pads unconditionally, which is what BSD's does and what GNU's
   * does not — the whole of the BSD `wc` bug. */
  const WC_STUB = `#!/bin/sh
awk 'END { printf "%7d\\n", NR }'
`;

  /** coreutils' `timeout`, and it lives in its **own** directory (H-120).
   *
   * The curated `PATH` below deliberately has no `timeout` on it, so the
   * default run exercises the `command -v` fallback — which is the arm that
   * matters, because these scripts also run on a Server over SSH and nothing
   * here may assume a host binary (the lesson taken over `wc`). A run that
   * wants the bound gets this directory prepended instead.
   *
   * `$STUB_TIMEOUT_EXPIRES=1` runs the command and *then* exits 124, which is
   * the shape that matters: real `timeout` fires on a transfer that has already
   * written bytes, so the abort has to hold with a partial staged file on disk. */
  const TIMEOUT_STUB = `#!/bin/sh
echo "timeout $*" >> "$STUB_LOG"
shift
if [ "$STUB_TIMEOUT_EXPIRES" = 1 ]; then
	"$@"
	exit 124
fi
exec "$@"
`;

  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-volume-restore-')),
  );
  const binDir = path.join(root, 'bin');
  const timeoutBinDir = path.join(root, 'timeout-bin');
  const logFile = path.join(root, 'stub-calls.log');
  const scriptFile = path.join(root, 'script.sh');
  const original = process.env.CLOUDGATE_DIRECTORY;

  const BACKUP_FILE_NAME =
    'main-app/daily/shop-data-2026-07-23T10-20-30-456Z.tar';
  const stagingDir = path.join(root, 'volume-backups', 'shop-data');
  /** A function, not a constant: `volumeLockPathFor` reads CLOUDGATE_DIRECTORY,
   * which `beforeAll` has not yet pointed at the temp root while this describe
   * body is being collected. */
  const lockDir = () => `${volumeLockPathFor(null, 'shop-data')}.dir`;

  beforeAll(() => {
    fs.mkdirSync(binDir);
    for (const name of [
      'awk',
      'cat',
      'cut',
      'find',
      'grep',
      'mkdir',
      'rm',
      'sleep',
      'tail',
      'tr',
    ]) {
      const resolved = spawnSync('/bin/sh', ['-c', `command -v ${name}`], {
        encoding: 'utf8',
      }).stdout.trim();
      if (!resolved)
        throw new Error(`the executed shell needs ${name} on PATH`);
      fs.symlinkSync(resolved, path.join(binDir, name));
    }
    for (const [name, body] of [
      ['docker', DOCKER_STUB],
      ['rclone', RCLONE_STUB],
      ['wc', WC_STUB],
    ]) {
      fs.writeFileSync(path.join(binDir, name), body, { mode: 0o755 });
    }
    fs.mkdirSync(timeoutBinDir);
    fs.writeFileSync(path.join(timeoutBinDir, 'timeout'), TIMEOUT_STUB, {
      mode: 0o755,
    });
    process.env.CLOUDGATE_DIRECTORY = root;
  });

  afterAll(() => {
    if (original === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = original;
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Every file left under the restore's staging directory. */
  const leftovers = (dir: string = stagingDir): string[] => {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? leftovers(full) : [full];
    });
  };

  const run = ({
    volumeExists,
    untarFails = false,
    rcloneWritesBytes = true,
    tarballCorrupt = false,
    tarballForeign = false,
    dockerCannotRun = false,
    endpointUnreachable = false,
    hostHasTimeout = false,
    wallClockExpires = false,
    containers = [],
    services = [],
    rmFails = false,
    rmGone = [],
    rmSilent = false,
    inspectFails = false,
    scaleUpFails = false,
    target = { serviceType: 'application', appName: 'main-app' },
  }: {
    volumeExists: boolean;
    /** What `docker ps -a --filter volume=…` lists, one line per container in
     * the restore's own `--format`. */
    containers?: string[];
    /** `name=replicas` for each Swarm service `docker service inspect`
     * answers; a service not listed is one Swarm no longer has. */
    services?: string[];
    /** `docker rm` of the task history refuses. */
    rmFails?: boolean;
    /** Task containers Swarm itself removed between the restore listing them
     * and its `docker rm` — what it does about a second after Stop returns. */
    rmGone?: string[];
    /** `docker rm` exits 1 and prints nothing at all. */
    rmSilent?: boolean;
    /** `docker service inspect` fails for a reason other than a missing
     * service. */
    inspectFails?: boolean;
    /** `docker service update` refuses every count but 0. */
    scaleUpFails?: boolean;
    target?: VolumeRestoreTarget;
    untarFails?: boolean;
    rcloneWritesBytes?: boolean;
    /** The bytes arrived and are not a tar archive. */
    tarballCorrupt?: boolean;
    /** The bytes arrived and are a readable tar this application did not write
     * — `tar cf archive.tar mydir/`, whose members are `mydir/…` rather than
     * `./…`, so the extraction's `.` selector matches nothing (H-119). */
    tarballForeign?: boolean;
    /** `docker run` cannot run at all — a dead daemon, or an `ubuntu` image
     * this host cannot pull (H-121). */
    dockerCannotRun?: boolean;
    /** The destination did not answer the probe at all. */
    endpointUnreachable?: boolean;
    /** `timeout` is on the host's `PATH`, so the wall-clock bound applies.
     * Off by default: the curated `PATH` is a host that has none, which is the
     * arm the `command -v` probe exists for (H-120). */
    hostHasTimeout?: boolean;
    /** That bound fired — `timeout` exits 124 on a transfer that has already
     * written bytes (H-120). */
    wallClockExpires?: boolean;
  }) => {
    fs.rmSync(path.join(root, 'volume-backups'), {
      recursive: true,
      force: true,
    });
    fs.rmSync(lockDir(), { recursive: true, force: true });
    fs.rmSync(logFile, { force: true });
    fs.rmSync(`${logFile}.services`, { force: true });
    fs.writeFileSync(
      scriptFile,
      buildVolumeRestoreScript({
        serverId: null,
        volumeName: 'shop-data',
        backupFileName: BACKUP_FILE_NAME,
        bucket: 'cloudgate-backups',
        target,
      }),
    );
    const result = spawnSync('/bin/sh', [scriptFile], {
      encoding: 'utf8',
      env: {
        PATH: hostHasTimeout ? `${timeoutBinDir}:${binDir}` : binDir,
        STUB_TIMEOUT_EXPIRES: wallClockExpires ? '1' : '0',
        STUB_LOG: logFile,
        STUB_VOLUME_EXISTS: volumeExists ? 'yes' : 'no',
        STUB_UNTAR_FAILS: untarFails ? '1' : '0',
        STUB_RCLONE_BYTES: rcloneWritesBytes ? '1' : '0',
        STUB_TARBALL_CORRUPT: tarballCorrupt ? '1' : '0',
        STUB_TARBALL_FOREIGN: tarballForeign ? '1' : '0',
        STUB_DOCKER_CANNOT_RUN: dockerCannotRun ? '1' : '0',
        STUB_RCLONE_UNREACHABLE: endpointUnreachable ? '1' : '0',
        STUB_CONTAINERS: containers.join('\n'),
        STUB_SERVICES: services.join(' '),
        STUB_RM_FAILS: rmFails ? '1' : '0',
        STUB_RM_GONE: rmGone.join(' '),
        STUB_RM_SILENT: rmSilent ? '1' : '0',
        STUB_SERVICE_INSPECT_FAILS: inspectFails ? '1' : '0',
        STUB_SCALE_UP_FAILS: scaleUpFails ? '1' : '0',
      },
    });
    return {
      status: result.status ?? -1,
      output: `${result.stdout}${result.stderr}`,
      /** What the caller of the restore is answered with: the service hands
       * the rejected execution's two streams to `rcloneFailureMessage`. */
      answered: rcloneFailureMessage(
        { stdout: result.stdout, stderr: result.stderr },
        'Failed to restore the volume',
      ),
      calls: fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '',
      leftovers: leftovers(),
    };
  };

  // `VOLUME_EXISTS=$(… | wc -l)` was compared against the literal "0",
  // so on a host whose `wc` pads its answer the doesn't-exist branch was
  // unreachable — and the else branch it fell into ran `docker volume inspect`
  // on a volume that is not there, which exits 1 and aborts the whole restore
  // under `set -e`, one line after the log claimed the volume existed.
  describe('the volume-existence check, on a host whose `wc` pads', () => {
    it('takes the doesn’t-exist branch and restores into a new volume', () => {
      const { status, output, calls, leftovers } = run({ volumeExists: false });

      expect(output).toContain(
        "Volume doesn't exist, proceeding with direct restore",
      );
      expect(output).not.toContain('Volume exists, checking for containers');
      // The line the padded comparison reached instead, and the reason the
      // defect is fatal rather than cosmetic.
      expect(calls).not.toContain('docker volume inspect');
      // Nothing to remove, so the removal is skipped rather than run against a
      // name that does not resolve.
      expect(calls).not.toContain('docker volume rm');
      expect(calls).toContain('docker volume create');
      expect(status).toBe(0);
      expect(leftovers).toEqual([]);
    });

    it('still takes the exists branch when the volume really is there', () => {
      const { status, output, calls } = run({ volumeExists: true });

      expect(output).toContain('Volume exists, checking for containers');
      expect(calls).toContain('docker volume inspect');
      expect(calls).toContain('docker volume rm shop-data --force');
      expect(status).toBe(0);
    });
  });

  // Stop scales an application's Swarm service to zero, and Swarm keeps
  // the exited task containers of the slot (TaskHistoryRetentionLimit, 5 by
  // default) — each still referencing the volume, so the in-use check refused
  // after the very step it prescribed. They cannot merely be ignored: Docker's
  // refcount counts them and the `docker volume rm` behind the check refuses.
  // So the restore removes them itself — only exited task containers of the
  // target's own service, and only once that service runs no replica.
  // A bucket's volume is restored as an Application's is, but the
  // restore stops its Garage itself — scaled to 0 for the replace, as the
  // backup's stop option does, and scaled back from a trap that every exit
  // from the stopped phase runs, so no restore leaves the bucket down.
  describe("a bucket's volume, its Garage stopped by the restore", () => {
    const garage = 'uploads-k3f9a2';
    const bucketTarget: VolumeRestoreTarget = {
      serviceType: 'bucket',
      appName: garage,
    };
    const exitedTask = `aaa111|${garage}.1.aaa111|exited|${garage}|${garage}|com.docker.swarm.service.name=${garage}`;

    it('scales Garage to 0, restores into the freed volume, and scales it back to the count it ran', () => {
      const { status, output, calls } = run({
        volumeExists: true,
        containers: [exitedTask],
        services: [`${garage}=2`],
        target: bucketTarget,
      });

      expect(status).toBe(0);
      expect(output).toContain('Volume restore completed ✅');
      expect(output).toContain(`Bucket: ${garage}`);
      const stop = `docker service update --replicas=0 ${garage}`;
      const start = `docker service update --replicas=2 --with-registry-auth ${garage}`;
      expect(calls).toContain(stop);
      expect(calls).toContain(start);
      expect(calls.indexOf(stop)).toBeLessThan(
        calls.indexOf('docker rm aaa111'),
      );
      expect(calls.indexOf('docker volume rm shop-data')).toBeLessThan(
        calls.indexOf(start),
      );
      expect(calls.indexOf('docker volume create')).toBeLessThan(
        calls.indexOf(start),
      );
    });

    it('scales Garage back up when the restore fails after stopping it', () => {
      const { status, calls } = run({
        volumeExists: true,
        containers: [exitedTask],
        services: [`${garage}=1`],
        target: bucketTarget,
        untarFails: true,
      });

      expect(status).not.toBe(0);
      expect(calls).toContain(
        `docker service update --replicas=1 --with-registry-auth ${garage}`,
      );
    });

    it('scales Garage back up when something else holds the volume and the restore refuses', () => {
      const { status, output, calls } = run({
        volumeExists: true,
        containers: [`zzz999|stray|running|||com.docker.compose.project=other`],
        services: [`${garage}=1`],
        target: bucketTarget,
      });

      expect(status).not.toBe(0);
      expect(output).toContain('Cannot restore volume');
      expect(calls).not.toContain('docker volume rm');
      expect(calls).toContain(
        `docker service update --replicas=1 --with-registry-auth ${garage}`,
      );
    });

    it('stops nothing when the replica count does not read as a number', () => {
      const { status, output, calls } = run({
        volumeExists: true,
        // Any answer that is not digits, as an empty one from a service
        // that is not replicated-mode would be.
        services: [`${garage}=unknown`],
        target: bucketTarget,
      });

      expect(status).not.toBe(0);
      expect(output).toContain('nothing was stopped');
      expect(calls).not.toContain('docker service update');
      expect(calls).not.toContain('rclone copyto');
    });

    it('fails, naming the outage, when Garage will not scale back up', () => {
      const { status, output } = run({
        volumeExists: false,
        services: [`${garage}=1`],
        target: bucketTarget,
        scaleUpFails: true,
      });

      expect(status).not.toBe(0);
      expect(output).toContain('Volume restore completed ✅');
      expect(output).toContain(`Bucket '${garage}' is DOWN at 0 replicas`);
    });
  });

  describe('the exited task containers Swarm keeps after Stop', () => {
    /** One `docker ps -a` line in the restore's own `--format`:
     * ID|Name|State|owner label|swarm service|Labels. The owner label is the
     * service name for an Application, the stack namespace for a stack. */
    const task = (
      id: string,
      service: string,
      state = 'exited',
      owner = service,
    ) =>
      `${id}|${service}.1.${id}|${state}|${owner}|${service}|com.docker.swarm.service.name=${service},com.docker.swarm.task.id=${id}`;
    const history = [
      task('aaa111', 'main-app'),
      task('bbb222', 'main-app'),
      task('ccc333', 'main-app'),
    ];

    it('removes them and restores once the application is stopped', () => {
      const { status, output, calls } = run({
        volumeExists: true,
        containers: history,
        services: ['main-app=0'],
      });

      expect(output).not.toContain('Cannot restore volume');
      expect(status).toBe(0);
      expect(calls).toContain('docker rm aaa111 bbb222 ccc333');
      // Before the volume goes, and after the tarball is proved.
      expect(calls.indexOf('docker rm aaa111')).toBeLessThan(
        calls.indexOf('docker volume rm shop-data'),
      );
      expect(calls.indexOf('tar -tf')).toBeLessThan(
        calls.indexOf('docker rm aaa111'),
      );
      expect(calls).not.toMatch(/docker rm .*(-f|--force)/);
    });

    it('removes them when the service is gone altogether', () => {
      const { status, calls } = run({
        volumeExists: true,
        containers: history,
        services: [],
      });

      expect(status).toBe(0);
      expect(calls).toContain('docker rm aaa111 bbb222 ccc333');
    });

    it('still refuses, touching nothing, while the service is scaled up', () => {
      // A crash-looping replica can be exited at the instant of the check and
      // started again a second later, mounting the volume mid-restore.
      const { status, output, calls } = run({
        volumeExists: true,
        containers: history,
        services: ['main-app=1'],
      });

      expect(status).not.toBe(0);
      expect(output).toContain(
        'Cannot restore volume as it is currently in use',
      );
      expect(output).toContain('Container: main-app.1.aaa111 (aaa111)');
      expect(output).toContain(
        "1. Stop the application 'main-app' in Cloudgate",
      );
      expect(calls).not.toMatch(/^docker rm /m);
      expect(calls).not.toContain('docker volume rm');
      expect(calls).not.toContain('rclone copyto');
    });

    it('still refuses while a task is running, and lists it', () => {
      const { status, output, calls } = run({
        volumeExists: true,
        containers: [task('run999', 'main-app', 'running'), ...history],
        services: ['main-app=1'],
      });

      expect(status).not.toBe(0);
      expect(output).toContain('Container: main-app.1.run999 (run999)');
      expect(output).toContain('Status: running');
      expect(calls).not.toMatch(/^docker rm /m);
    });

    it('refuses on a container Cloudgate does not own, naming it, and removes nothing', () => {
      const { status, output, calls } = run({
        volumeExists: true,
        containers: [
          'fff000|someones-shell|running|||maintainer=someone',
          ...history,
        ],
        services: ['main-app=0'],
      });

      expect(status).not.toBe(0);
      expect(output).toContain('Container: someones-shell (fff000)');
      expect(output).toContain('Type: Regular Container');
      // Stop on main-app has been done and cannot free this, so it is not
      // what the refusal sends the operator to.
      expect(output).toContain(
        "1. Stop and remove the containers listed above wherever they are managed — none of them is part of 'main-app'",
      );
      expect(output).not.toContain("1. Stop the application 'main-app'");
      // The application's own history is not what is blocking, so it is not
      // listed as if Stop would clear it — and not removed on a refusal.
      expect(output).not.toContain('main-app.1.aaa111');
      expect(calls).not.toMatch(/^docker rm /m);
    });

    it("never removes another service's exited task containers", () => {
      const { status, output, calls } = run({
        volumeExists: true,
        containers: [task('ddd444', 'other-app'), ...history],
        services: ['main-app=0', 'other-app=0'],
      });

      expect(status).not.toBe(0);
      expect(output).toContain('Container: other-app.1.ddd444 (ddd444)');
      expect(output).toContain('Type: Docker Swarm Service (other-app)');
      expect(output).toContain("none of them is part of 'main-app'");
      expect(calls).not.toMatch(/^docker rm /m);
    });

    it('names both steps when its own task and a foreign container both hold it', () => {
      const { status, output, calls } = run({
        volumeExists: true,
        containers: [
          task('run999', 'main-app', 'running'),
          'fff000|someones-shell|running|||maintainer=someone',
        ],
        services: ['main-app=1'],
      });

      expect(status).not.toBe(0);
      expect(output).toContain(
        "1. Stop the application 'main-app' in Cloudgate",
      );
      expect(output).toContain(
        "The containers listed above that are not part of 'main-app' hold this volume as well",
      );
      expect(calls).not.toMatch(/^docker rm /m);
    });

    it('removes the exited task containers a stopped swarm stack left', () => {
      const { status, calls } = run({
        volumeExists: true,
        containers: [task('eee555', 'shop-stack_db', 'exited', 'shop-stack')],
        services: [],
        target: {
          serviceType: 'compose',
          appName: 'shop-stack',
          composeType: 'stack',
        },
      });

      expect(status).toBe(0);
      expect(calls).toContain('docker rm eee555');
    });

    it("never takes an underscore neighbour's stack for its own", () => {
      // APP_NAME_REGEX allows '_', so stack 'shop' and stack 'shop_api' are
      // both legal, and 'shop_api_db' starts with 'shop_'. Ownership is the
      // stack namespace label, matched exactly — not a service-name prefix.
      const { status, output, calls } = run({
        volumeExists: true,
        containers: [task('hhh777', 'shop_api_db', 'exited', 'shop_api')],
        services: [],
        target: {
          serviceType: 'compose',
          appName: 'shop',
          composeType: 'stack',
        },
      });

      expect(status).not.toBe(0);
      expect(output).toContain('Container: shop_api_db.1.hhh777 (hhh777)');
      expect(output).toContain("none of them is part of 'shop'");
      expect(calls).not.toContain('docker service inspect');
      expect(calls).not.toMatch(/^docker rm /m);
      expect(calls).not.toContain('docker volume rm');
    });

    it('refuses, removing nothing, when Docker will not say whether the service is there', () => {
      const { status, output, calls } = run({
        volumeExists: true,
        containers: history,
        services: ['main-app=0'],
        inspectFails: true,
      });

      expect(status).not.toBe(0);
      expect(output).toContain('Container: main-app.1.aaa111 (aaa111)');
      expect(output).toContain(
        "Not removed: 'docker service inspect' did not say whether this container's service still runs a replica",
      );
      expect(output).toContain(
        "1. Stop the application 'main-app' in Cloudgate",
      );
      expect(calls).not.toMatch(/^docker rm /m);
      expect(calls).not.toContain('docker volume rm');
    });

    it('leaves a docker-compose stack on Remove containers', () => {
      const { status, output, calls } = run({
        volumeExists: true,
        containers: [
          'ggg666|shop-stack-db-1|exited|shop-stack||com.docker.compose.project=shop-stack',
        ],
        target: {
          serviceType: 'compose',
          appName: 'shop-stack',
          composeType: 'docker-compose',
        },
      });

      expect(status).not.toBe(0);
      expect(output).toContain('Type: Docker Compose (shop-stack)');
      expect(output).toContain('1. Use Remove containers');
      expect(output).not.toContain('that are not part of');
      expect(calls).not.toMatch(/^docker rm /m);
    });

    it('stops with the volume untouched when the task history will not go', () => {
      const { status, output, calls } = run({
        volumeExists: true,
        containers: history,
        services: ['main-app=0'],
        rmFails: true,
      });

      expect(status).not.toBe(0);
      expect(output).toContain(
        '❌ Volume restore aborted - the exited task containers holding the volume could not be removed',
      );
      expect(output).toContain("Volume 'shop-data' has not been touched");
      expect(calls).not.toContain('docker volume rm');
    });

    // #1412: Stop scales the service to 0 and Swarm destroys the stopped
    // task's container itself about a second later, so a restore called
    // straight after Stop lists a container that is gone by its `docker rm`.
    it('counts a task container Swarm removed after Stop as removed, and restores', () => {
      const { status, output, calls } = run({
        volumeExists: true,
        containers: history,
        services: ['main-app=0'],
        rmGone: ['bbb222'],
      });

      expect(output).not.toContain('❌');
      expect(status).toBe(0);
      expect(calls).toContain('docker rm aaa111 bbb222 ccc333');
      expect(calls).toContain('docker volume rm shop-data');
      expect(output).toContain('Volume restore completed ✅');
    });

    it('restores when Swarm removed every task container it listed', () => {
      const { status, calls } = run({
        volumeExists: true,
        containers: history,
        services: ['main-app=0'],
        rmGone: ['aaa111', 'bbb222', 'ccc333'],
      });

      expect(status).toBe(0);
      expect(calls).toContain('docker volume rm shop-data');
    });

    it("answers a refused removal with docker's own reason, and leaves the volume", () => {
      const { status, answered, calls } = run({
        volumeExists: true,
        containers: history,
        services: ['main-app=0'],
        rmGone: ['aaa111'],
        rmFails: true,
      });

      expect(status).not.toBe(0);
      expect(answered).toMatch(
        /^❌ Volume restore aborted - the exited task containers holding the volume could not be removed/,
      );
      // The reason, which the operator used to be told to read "above" —
      // above the line the answer starts at.
      expect(answered).toContain(
        'Error response from daemon: cannot remove container "/main-app.1.bbb222": container is running',
      );
      // The container that was already gone is not a reason.
      expect(answered).not.toContain('No such container');
      expect(answered).not.toContain('read its line above');
      expect(answered).toContain("Volume 'shop-data' has not been touched");
      expect(calls).not.toContain('docker volume rm');
    });

    it('refuses a removal that failed without saying why', () => {
      // Fail closed: a failed `docker rm` counts as "already gone" only where
      // docker said so.
      const { status, answered, calls } = run({
        volumeExists: true,
        containers: history,
        services: ['main-app=0'],
        rmSilent: true,
      });

      expect(status).not.toBe(0);
      expect(answered).toMatch(
        /^❌ Volume restore aborted - the exited task containers holding the volume could not be removed/,
      );
      expect(calls).not.toContain('docker volume rm');
    });
  });

  // `rm "${localTarball}"` was a plain statement after the untar, and
  // `set -e` aborts the script at a failing `docker run … tar xvf` — so the
  // tarball, which is the size of the whole volume, stayed on the host.
  describe('the downloaded tarball is removed on every exit', () => {
    it('leaves no tarball behind when the untar fails', () => {
      const { status, leftovers } = run({
        volumeExists: true,
        untarFails: true,
      });

      expect(status).not.toBe(0);
      expect(leftovers).toEqual([]);
    });

    it('still cleans up after a restore that worked', () => {
      const { status, output, leftovers } = run({ volumeExists: true });

      expect(status).toBe(0);
      expect(output).toContain('Volume restore completed ✅');
      expect(output).toContain('Local backup file cleaned up ✅');
      expect(leftovers).toEqual([]);
    });

    it('leaves no zero-byte tarball behind when the download brought nothing', () => {
      const { status, output, calls, leftovers } = run({
        volumeExists: true,
        rcloneWritesBytes: false,
      });

      expect(status).not.toBe(0);
      expect(output).toContain(
        '❌ Volume restore aborted - the backup file did not download',
      );
      // The abort is in front of everything destructive, still.
      expect(calls).not.toContain('docker volume rm');
      expect(leftovers).toEqual([]);
    });

    // The regression this fix could quietly cause, and the reason the cleanup
    // is registered inside a subshell: a second `trap … EXIT` in the same shell
    // *replaces* the lock's own, so on a host with no `flock` — which is what
    // this block's curated PATH pins — the lock directory would survive the
    // run and every later backup of this volume would wait on it forever.
    it('still releases the mkdir-fallback volume lock on the way out', () => {
      const { output } = run({ volumeExists: true });

      expect(output).toContain('Volume lock acquired: shop-data');
      expect(output).toContain('Volume lock released: shop-data');
      expect(fs.existsSync(lockDir())).toBe(false);
    });

    it('leaves the lock released after a run that failed at the untar', () => {
      run({ volumeExists: true, untarFails: true });

      expect(fs.existsSync(lockDir())).toBe(false);
    });
  });

  // What made G-39's eighteen minutes worse than a slow request
  // is that `withVolumeLock` was held for every one of them, so every other
  // operation on the volume answered 409 because one endpoint was degraded. A
  // destination that is not answering is now found out in front of the lock.
  describe('a destination that does not answer at all', () => {
    it('refuses without taking the volume lock or reaching docker', () => {
      const { status, output, calls, leftovers } = run({
        volumeExists: true,
        endpointUnreachable: true,
      });

      expect(status).not.toBe(0);
      expect(output).toContain(
        '❌ Volume restore aborted - the backup destination did not answer',
      );
      // Never acquired, so nothing else waiting on this volume was refused.
      expect(output).not.toContain('Volume lock acquired: shop-data');
      expect(fs.existsSync(lockDir())).toBe(false);
      // And nothing was inspected, removed, staged or downloaded.
      expect(calls).not.toContain('docker');
      expect(calls).not.toContain('rclone copyto');
      expect(leftovers).toEqual([]);
    });

    it('carries rclone’s own line into the answer the caller reads', () => {
      const { output } = run({
        volumeExists: true,
        endpointUnreachable: true,
      });

      // The builder's sentence says what to do about it; rclone's says what
      // happened, and only one of the two can be written in advance.
      expect(output).toContain(
        'ERROR : : error listing: RequestError: send request failed',
      );
      expect(output).toContain(
        `Volume 'shop-data' has not been touched, and its lock was never taken`,
      );
    });

    it('runs the restore untouched when the destination does answer', () => {
      const { status, output, calls } = run({ volumeExists: true });

      // The negative assertion's other half: the probe is a gate, not a step
      // that can fail a healthy restore.
      expect(status).toBe(0);
      expect(calls).toContain('rclone lsjson');
      expect(output).toContain('Volume restore completed ✅');
    });
  });

  // The object was there and was 200 000 bytes of /dev/urandom, so
  // `[ ! -s ]` was satisfied, the volume was removed and re-created, and the
  // `tar xvf` failed into an emptied volume holding real data a moment before.
  describe('a corrupt-but-present tarball', () => {
    it('leaves the volume alone rather than emptying it', () => {
      const { status, output, calls, leftovers } = run({
        volumeExists: true,
        tarballCorrupt: true,
      });

      expect(status).not.toBe(0);
      expect(output).toContain('is not a readable tar archive');
      expect(output).toContain('has not been touched');
      // The whole of the issue: without the header read this run reaches the
      // removal, and what is left afterwards is a correctly labelled empty
      // volume.
      expect(calls).not.toContain('docker volume rm');
      expect(calls).not.toContain('docker volume create');
      // The cleanup trap still fires on this new abort, so nothing volume-sized
      // is left staged.
      expect(leftovers).toEqual([]);
    });

    it('releases the mkdir-fallback volume lock on the new abort', () => {
      // The mistake this catches is registering the check outside the subshell,
      // where an `exit 1` would leave the lock directory behind and every later
      // backup of this volume would wait on it forever.
      run({ volumeExists: true, tarballCorrupt: true });

      expect(fs.existsSync(lockDir())).toBe(false);
    });

    it('runs the extraction untouched when the archive reads', () => {
      // The check that the stub split is right rather than the fix: with
      // `tarballCorrupt` unset the header read passes and the restore is the
      // same restore it was.
      const { status, output, calls } = run({ volumeExists: true });

      expect(output).toContain('Verifying the downloaded archive...');
      expect(output).toContain('Download completed ✅');
      expect(output).toContain('Volume restore completed ✅');
      expect(calls).toContain('docker volume create');
      expect(status).toBe(0);
    });
  });

  // H-119: `replaceVolumeCommand` extracts with `tar xvf /backup/<file> .`,
  // where the trailing `.` is a member selector — so the tar gate passed an
  // ordinary `tar cf archive.tar mydir/` (readable, exit 0), the volume was
  // removed and re-created, and the extraction then found no `.` member. Driven
  // on the box against two byte-identical 150 MB archives: the one written the
  // way this application writes them restored, and the one written the ordinary
  // way emptied the volume and blamed `tar`.
  describe('a readable tar this application did not write (H-119)', () => {
    it('refuses before the removal and names the real cause', () => {
      const { status, output, calls, leftovers } = run({
        volumeExists: true,
        tarballForeign: true,
      });

      expect(status).not.toBe(0);
      expect(output).toContain(
        '❌ Volume restore aborted - the archive is a tar this application did not write',
      );
      expect(output).toContain("the archive holds no './' entry");
      // The whole of the finding: the object passes the "is this a tar" read,
      // so the message it used to get was the tar gate's — a diagnosis of
      // unreadable headers for headers that read perfectly.
      expect(output).not.toContain('is not a readable tar archive');
      // And the volume is on the safe side of it, which is what the
      // empty-download check and the tar gate both exist for.
      expect(output).toContain('has not been touched');
      expect(calls).not.toContain('docker volume rm');
      expect(calls).not.toContain('docker volume create');
      expect(output).not.toContain('Volume restore completed ✅');
      // The cleanup trap still fires on this third abort, so nothing volume-sized
      // is left staged.
      expect(leftovers).toEqual([]);
      expect(fs.existsSync(lockDir())).toBe(false);
    });

    it('asks with the extraction’s own selector rather than a second matcher', () => {
      // Not tidiness: tar's member matching is tar's, and a `grep '^\\./'` over
      // the listing would be a second implementation of it that can disagree
      // with the one doing the extracting — which is the BSD `wc` bug's shape
      // exactly. So the gate's read carries the same `.` the `tar xvf` does,
      // and the second read (the one that separates "unreadable" from "no such
      // member") is the one without it.
      const { calls } = run({ volumeExists: true, tarballForeign: true });
      const read = `docker run --rm -v ${stagingDir}:/backup ubuntu:24.04 tar -tf /backup/${BACKUP_FILE_NAME}`;

      expect(calls).toContain(`${read} .\n`);
      expect(calls).toContain(`${read}\n`);
    });

    it('costs the healthy restore one container, not two', () => {
      // The second read is behind the failure, so a restore that works reads
      // the headers once — the same cost the tar gate shipped with.
      const { calls, status } = run({ volumeExists: true });

      expect(
        calls.split('\n').filter((call) => call.includes('tar -tf')),
      ).toHaveLength(1);
      // And the extraction's selector is unchanged, which is the alternative
      // fix this one exists instead of: dropping the `.` from `tar xvf` would
      // extract a foreign archive into the volume root and change the layout of
      // every restore.
      expect(calls).toContain(`tar xvf /backup/${BACKUP_FILE_NAME} .`);
      expect(status).toBe(0);
    });
  });

  // H-121: `set -e` is suspended for the condition of an `if`, so the gate's
  // `if ! docker run …` took the false branch when `docker run` could not run at
  // all — and told the operator their backup was corrupt when the cause was the
  // daemon or a Docker Hub rate limit. Reachable on any fresh host: `ubuntu` is
  // not present, so the first restore pulls it inside the restore.
  describe('a `docker run` that cannot run at all (H-121)', () => {
    it('blames docker rather than the archive', () => {
      const { status, output, calls, leftovers } = run({
        volumeExists: true,
        dockerCannotRun: true,
      });

      expect(status).not.toBe(0);
      expect(output).toContain(
        "❌ Volume restore aborted - the archive could not be checked because 'docker run' would not run",
      );
      // The status is docker's own and it is the thing that separates the two
      // causes, so it is in the message rather than in the reader's head.
      expect(output).toContain('The status it exited with: 125');
      // docker's own line, the way the reachability probe carries rclone's:
      // the half of the answer the builder cannot write in advance.
      expect(output).toContain('You have reached your pull rate limit');
      expect(output).toContain(
        "the 'ubuntu:24.04' image this host cannot pull",
      );
      // The message it used to get, which was a verdict on the object.
      expect(output).not.toContain('is not a readable tar archive');
      // The conclusion the old docblock drew was right and its mechanism was
      // not: nothing reaches the removal either way, and what makes that true
      // now is this branch's own `exit 1`.
      expect(calls).not.toContain('docker volume rm');
      expect(calls).not.toContain('docker volume create');
      expect(output).toContain('has not been touched');
      expect(leftovers).toEqual([]);
      expect(fs.existsSync(lockDir())).toBe(false);
    });
  });

  /**
   * H-120: the wall-clock bound once claimed was `--max-duration`, and
   * it is not — the flag is accepted and does nothing on `rclone v1.60.1-DEV`,
   * which is what apt has on the documented platform and therefore what
   * `deploy/install.sh` installs. X10 gave a *healthy* endpoint
   * `--max-duration 1ms` and it transferred all 157 286 400 bytes, rc=0, in 1 s.
   *
   * Which matters because the download runs inside `withVolumeLock`: a link
   * delivering 1 KB/s to a 5 GB volume is never idle, never finished, and every
   * backup, restore and Remove-containers on that volume answers 409 until
   * somebody kills the backend — G-39's own first half.
   *
   * So these run the script rather than reading it, on both hosts.
   */
  describe('the download is bounded by the process, not by a flag rclone ignores (H-120)', () => {
    const DOWNLOAD = `rclone copyto --retries 1 --low-level-retries 10 --timeout 60s --contimeout 10s --max-duration 30m :s3:cloudgate-backups/${BACKUP_FILE_NAME} ${stagingDir}/${BACKUP_FILE_NAME}`;

    it('runs the download under a wall clock on a host that has one', () => {
      const { status, output, calls } = run({
        volumeExists: true,
        hostHasTimeout: true,
      });

      // Seconds, not `30m`: busybox's `timeout` takes no suffix, and a host
      // with busybox coreutils is the same host the fallback is for.
      expect(calls).toContain(`timeout 1800 ${DOWNLOAD}\n`);
      // And rclone still ran, with every flag it had — the bound is a wrapper,
      // not a replacement.
      expect(calls).toContain(`${DOWNLOAD}\n`);
      expect(output).toContain('Download completed ✅');
      expect(status).toBe(0);
    });

    it('downloads unwrapped on a host with no timeout, rather than failing', () => {
      // The curated `PATH` is that host. The BSD `wc` bug is what an assumed
      // host binary costs this file, and these scripts also run on a Server
      // over SSH.
      const { status, output, calls } = run({ volumeExists: true });

      expect(calls).toContain(`${DOWNLOAD}\n`);
      expect(calls).not.toContain('timeout 1800');
      expect(output).toContain('Download completed ✅');
      expect(status).toBe(0);
    });

    it('refuses with the volume untouched when the wall clock fires', () => {
      const { status, output, calls, leftovers } = run({
        volumeExists: true,
        hostHasTimeout: true,
        wallClockExpires: true,
      });

      expect(status).toBe(1);
      expect(output).toContain(
        '❌ Volume restore aborted - the download did not finish inside its 30-minute limit',
      );
      // The whole point of bounding it: the lock is released, so everything else
      // waiting on this volume stops answering 409. Read off the lock directory
      // rather than the log — `set -e` ends the script at the failing subshell,
      // so the preamble's release `echo` is unreachable on *every* abort in this
      // file, and the `trap` is what actually frees the volume.
      expect(fs.existsSync(lockDir())).toBe(false);
      // Nothing on the far side of the download ran, so the volume is on the
      // safe side of the removal exactly as it is for an unreachable bucket.
      expect(output).toContain('has not been touched');
      expect(calls).not.toContain('docker volume rm');
      expect(calls).not.toContain('docker volume create');
      expect(calls).not.toContain('tar -tf');
      // The staged partial the transfer had already written is removed by
      // the cleanup trap, which is why no new cleanup was added for this exit.
      expect(leftovers).toEqual([]);
    });

    it('leaves every other download failure answering what it answered before', () => {
      // The 124 branch is the only new one: an `rclone copyto` that exits 0
      // without leaving bytes still gets the empty-download message, which is
      // the case a captured status could most easily have swallowed.
      const { status, output } = run({
        volumeExists: true,
        rcloneWritesBytes: false,
      });

      expect(status).not.toBe(0);
      expect(output).toContain(
        '❌ Volume restore aborted - the backup file did not download',
      );
      expect(output).not.toContain('did not finish inside its 30-minute limit');
    });
  });

  // The untar had no failure branch, so `set -e` ended the subshell at the
  // failing `tar` and the last thing on stdout was "Creating new volume and
  // restoring data...", which reads as progress.
  describe('an untar that fails after the volume is gone', () => {
    it('says the volume has been re-created and holds the partial extraction', () => {
      const { status, output, calls } = run({
        volumeExists: true,
        untarFails: true,
      });

      expect(status).not.toBe(0);
      expect(output).toContain('the archive would not extract');
      // H-116: it said "it is EMPTY", and this abort fires *during* an
      // extraction — so what the volume holds is whatever landed before `tar`
      // stopped. Measured: one `real.txt` out of an archive with a bad hard
      // link in it. And it is the only case left to reach here, because the tar
      // gate now catches every truncation that loses a data block in front of
      // the removal. An operator who reads EMPTY, looks, and finds files has to
      // decide which to believe — and a container started on a half-extracted
      // volume is the worse of the two outcomes, because a database engine will
      // open half its files rather than refuse.
      expect(output).toContain(
        'what it holds now is whatever the archive managed to extract before it failed',
      );
      expect(output).not.toContain('EMPTY');
      // The clause that is the failed-untar message's whole point is untouched.
      expect(output).toContain(
        'not the data it held before this restore, which is gone',
      );
      expect(output).toContain('re-downloads it from bucket');
      // A message claiming the volume was removed, on a run where it was not,
      // would be worse than silence — so the claim is checked against the log.
      expect(calls).toContain('docker volume rm shop-data --force');
      expect(calls).toContain('docker volume create');
      expect(output).not.toContain('Volume restore completed ✅');
    });

    it('prints the abort above the trap’s own cleanup line', () => {
      // A trap runs last by definition, so `Local backup file cleaned up ✅`
      // lands under an `❌` banner. That is intentional; this pins
      // the order rather than leaving a later reader to reverse it.
      const { output } = run({ volumeExists: true, untarFails: true });

      expect(output.indexOf('the archive would not extract')).toBeLessThan(
        output.indexOf('Local backup file cleaned up ✅'),
      );
    });
  });
});

/**
 * The turn-off backup script, run under a real `/bin/sh` with a stub `docker`
 * (H-96).
 *
 * **A string assertion cannot see H-96, and this run has been bitten twice by
 * that.** The defect was four statements in the right order —
 * `<stop>; <tar>; <restart>; <upload>` — with `set -e` in force from the lock
 * preamble's first line, so every `toContain('docker service update
 * --replicas=$ACTUAL_REPLICAS …')` in this file passed on it: the restart *was*
 * in the script, three lines under a statement whose failure meant the shell
 * never reached it. Only executing the program answers "does the restart
 * happen", and it is the answer a tenant's uptime depends on. H-94 found a
 * `shell-quote`-`parse` assertion that passed on the bug it was written for and
 * H-95 found an executed proof gone vacuous, which is why the assertions below
 * are on the **call log** — what `docker` was actually asked to do, in order —
 * rather than on the script's text or on an exit status.
 *
 * The stub is not `docker-daemon-stub.ts`'s: that one answers presence probes
 * (`version` / `service inspect` / `stack ps` / `compose ps`) on exit status
 * alone and bakes its mode into the script text because the probes run under
 * `env -i`. Nothing here runs under `env -i`, and what this needs instead is a
 * `service inspect --format` that *prints a replica count*, an `update` and a
 * `start` that can be made to fail on their own, and a `docker run … tar` that
 * can be made to fail while the two `update`s still work. So it follows the
 * pattern of the restore harness above — env-var modes, one call log — which is
 * the same file and the same shape.
 */
describe('buildVolumeBackupScript, executed under /bin/sh', () => {
  /** Answers `service inspect --format` from `$STUB_REPLICAS` (`empty` is the
   * exit-0-with-nothing a non-replicated-mode service gives, and `fail` is a
   * daemon that is not answering), fails the `docker run … tar` on
   * `$STUB_TAR_FAILS`, and fails the *restoring* `service update` / `docker
   * start` on `$STUB_RESTART_FAILS`.
   *
   * **Three container fixtures, not two, and the third is H-118's** (added with
   * H-97's fix). `$STUB_NO_CONTAINER` blanks `ps -q` *and* `ps -aq` — no
   * container anywhere, which is the benign half. `$STUB_CONTAINER_VANISHES`
   * blanks `ps -aq` only — one was running and is gone by the time the trap
   * looks. `$STUB_CONTAINER_ALREADY_STOPPED` blanks `ps -q` only, which is the
   * combination H-97's own title describes and the one that had **no fixture at
   * all**: the compose container exists and is not running. That gap is why the
   * pinning test below passed while `main` was starting a container this backup
   * never stopped.
   *
   * The scale-down and the scale-up are told apart by their arguments rather
   * than by their position: `$STUB_RESTART_FAILS` must break the restart while
   * leaving `--replicas=0` working, or the case this file exists to pin — the
   * workload is stopped and cannot be brought back — cannot be expressed. */
  const DOCKER_STUB = `#!/bin/sh
echo "docker $*" >> "$STUB_LOG"
case "$1 $2" in
	"service inspect")
		if [ "$STUB_REPLICAS" = fail ]; then
			echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock." >&2
			exit 1
		fi
		if [ "$STUB_REPLICAS" = empty ]; then exit 0; fi
		echo "$STUB_REPLICAS"
		;;
	"service update")
		case "$*" in
			*--replicas=0*) ;;
			*)
				if [ "$STUB_RESTART_FAILS" = 1 ]; then
					echo "Error: rpc error: code = Unavailable" >&2
					exit 1
				fi
				;;
		esac
		;;
	"ps -q")
		if [ "$STUB_NO_CONTAINER" != 1 ] && [ "$STUB_CONTAINER_ALREADY_STOPPED" != 1 ]; then
			echo 444d9d36df9e
		fi
		;;
	"ps -aq")
		if [ "$STUB_NO_CONTAINER" != 1 ] && [ "$STUB_CONTAINER_VANISHES" != 1 ]; then
			echo 444d9d36df9e
		fi
		;;
	"stop "|"start ")
		# Faithful to the real CLI, and still load-bearing after H-97 turned
		# the no-container case from a refusal into a backup that proceeds:
		# 'docker stop' with no argument is a usage error, so a regression that
		# dropped the '[ -n "$ID" ]' guard round the stop shows up as a failing
		# run here rather than as a stub's 'exit 0' hiding it.
		echo "docker: '$*' requires at least 1 argument." >&2
		exit 1
		;;
	"start 444d9d36df9e")
		if [ "$STUB_RESTART_FAILS" = 1 ]; then
			echo "Error response from daemon: driver failed" >&2
			exit 1
		fi
		;;
	"stop 444d9d36df9e")
		# A stop that is refused for the container it named, which is not the
		# same as the usage error above: '$ID' can name more than one
		# container, so a stop can fail with something already stopped.
		if [ "$STUB_STOP_FAILS" = 1 ]; then
			echo "Error response from daemon: cannot stop container" >&2
			exit 1
		fi
		;;
	"run --rm")
		if [ "$STUB_TAR_FAILS" = 1 ]; then
			echo "tar: /volume_data: Cannot open: No such file or directory" >&2
			exit 2
		fi
		;;
esac
exit 0
`;

  /** The upload half, so the happy path can be watched reaching the bucket
   * *after* the restart rather than being inferred from the script's text. */
  const RCLONE_STUB = `#!/bin/sh
echo "rclone $*" >> "$STUB_LOG"
exit 0
`;

  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-volume-backup-')),
  );
  const binDir = path.join(root, 'bin');
  const logFile = path.join(root, 'stub-calls.log');
  const scriptFile = path.join(root, 'script.sh');
  const original = process.env.CLOUDGATE_DIRECTORY;

  const BACKUP_FILE_NAME = 'shop-data-2026-07-23T10-20-30-456Z.tar';
  const stagingDir = path.join(root, 'volume-backups', 'main-app');
  /** A function, not a constant: `volumeLockPathFor` reads CLOUDGATE_DIRECTORY,
   * which `beforeAll` has not yet pointed at the temp root while this describe
   * body is being collected. */
  const lockDir = () => `${volumeLockPathFor(null, 'shop-data')}.dir`;

  beforeAll(() => {
    fs.mkdirSync(binDir);
    // No `flock` among them, deliberately: its absence is what sends the lock
    // preamble down the `mkdir` fallback, which is the branch that registers
    // `trap 'rm -rf "$LOCK_DIR"' EXIT` — the trap H-96's own trap would have
    // replaced had it been registered in the same shell instead of a subshell.
    // Every case below therefore also witnesses the lock being released.
    for (const name of ['mkdir', 'rm', 'sleep']) {
      const resolved = spawnSync('/bin/sh', ['-c', `command -v ${name}`], {
        encoding: 'utf8',
      }).stdout.trim();
      if (!resolved)
        throw new Error(`the executed shell needs ${name} on PATH`);
      fs.symlinkSync(resolved, path.join(binDir, name));
    }
    for (const [name, body] of [
      ['docker', DOCKER_STUB],
      ['rclone', RCLONE_STUB],
    ]) {
      fs.writeFileSync(path.join(binDir, name), body, { mode: 0o755 });
    }
    process.env.CLOUDGATE_DIRECTORY = root;
  });

  afterAll(() => {
    if (original === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = original;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const TARGETS = {
    application: {
      serviceType: 'application' as const,
      appName: 'main-app',
    },
    stack: {
      serviceType: 'compose' as const,
      appName: 'shop-stack',
      serviceName: 'db',
      composeType: 'stack' as const,
    },
    'docker-compose': {
      serviceType: 'compose' as const,
      appName: 'shop-stack',
      serviceName: 'db',
      composeType: 'docker-compose' as const,
    },
  };

  const run = ({
    arm,
    tarFails = false,
    restartFails = false,
    replicas = '3',
    noContainer = false,
    containerVanishes = false,
    containerAlreadyStopped = false,
    stopFails = false,
  }: {
    arm: keyof typeof TARGETS;
    /** The `docker run … tar` fails — a dockerd restart mid-tar, a full disk,
     * an OOM. The whole of H-96. */
    tarFails?: boolean;
    /** The restart itself fails, which must not pass silently (H-74). */
    restartFails?: boolean;
    /** What `service inspect --format` answers: `empty` is the exit-0-with-
     * nothing of a non-replicated service, `fail` is a dead daemon. */
    replicas?: string;
    /** There was no compose container to stop in the first place. */
    noContainer?: boolean;
    /** There was one to stop, and it is gone by the time the trap looks for it
     * — Remove containers or Delete took it away while the backup held it
     * stopped, which the volume lock is for. */
    containerVanishes?: boolean;
    /** The container exists and is not running — `docker ps -q` finds nothing
     * and `docker ps -aq` finds it. H-97's own case, and the one whose absence
     * let H-118 through. */
    containerAlreadyStopped?: boolean;
    /** The stop of a container that *was* running is refused. H-97's guard put
     * a flag in front of the restart, and this is the case that decides which
     * side of the `docker stop` it goes on. */
    stopFails?: boolean;
  }) => {
    fs.rmSync(lockDir(), { recursive: true, force: true });
    fs.rmSync(logFile, { force: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    // The tar's output, so the upload's `rm` on the happy path is removing a
    // real file rather than failing for a reason the case did not intend.
    fs.writeFileSync(path.join(stagingDir, BACKUP_FILE_NAME), 'tarball');
    fs.writeFileSync(
      scriptFile,
      buildVolumeBackupScript({
        serverId: null,
        volumeName: 'shop-data',
        backupFileName: BACKUP_FILE_NAME,
        volumeBackupPath: stagingDir,
        rcloneDestination: `:s3:cloudgate-backups/main-app/daily/${BACKUP_FILE_NAME}`,
        turnOff: true,
        target: TARGETS[arm],
        lockMode: 'wait',
      }),
    );
    const result = spawnSync('/bin/sh', [scriptFile], {
      encoding: 'utf8',
      env: {
        PATH: binDir,
        STUB_LOG: logFile,
        STUB_REPLICAS: replicas,
        STUB_TAR_FAILS: tarFails ? '1' : '0',
        STUB_RESTART_FAILS: restartFails ? '1' : '0',
        STUB_NO_CONTAINER: noContainer ? '1' : '0',
        STUB_CONTAINER_VANISHES: containerVanishes ? '1' : '0',
        STUB_CONTAINER_ALREADY_STOPPED: containerAlreadyStopped ? '1' : '0',
        STUB_STOP_FAILS: stopFails ? '1' : '0',
      },
    });
    return {
      status: result.status ?? -1,
      output: `${result.stdout}${result.stderr}`,
      calls: fs.existsSync(logFile)
        ? fs.readFileSync(logFile, 'utf8').trimEnd().split('\n')
        : [],
      lockHeld: fs.existsSync(lockDir()),
    };
  };

  /** The call that puts the workload back, per arm — the one line whose absence
   * is the outage. */
  const RESTORING_CALL = {
    application:
      'docker service update --replicas=3 --with-registry-auth main-app',
    stack:
      'docker service update --replicas=3 --with-registry-auth shop-stack_db',
    'docker-compose': 'docker start 444d9d36df9e',
  };
  const STOPPING_CALL = {
    application: 'docker service update --replicas=0 main-app',
    stack: 'docker service update --replicas=0 shop-stack_db',
    'docker-compose': 'docker stop 444d9d36df9e',
  };
  const ARMS = ['application', 'stack', 'docker-compose'] as const;

  describe.each(ARMS)('%s', (arm) => {
    it('restarts the workload when the tar fails after the stop', () => {
      const { calls, status, lockHeld } = run({ arm, tarFails: true });

      // The whole finding, in three lines: the workload was stopped, the tar
      // failed, and the restart happened anyway. At HEAD~ the third assertion
      // failed — the log ended at the `docker run`.
      expect(calls).toContain(STOPPING_CALL[arm]);
      expect(calls.join('\n')).toContain('run --rm');
      expect(calls).toContain(RESTORING_CALL[arm]);
      expect(calls.indexOf(STOPPING_CALL[arm])).toBeLessThan(
        calls.indexOf(RESTORING_CALL[arm]),
      );
      // The tar still failed, so the run still fails and the tarball is not
      // uploaded — the restart is a rescue, not a reason to report success.
      expect(status).not.toBe(0);
      expect(calls.join('\n')).not.toContain('rclone');
      // And the lock preamble's own EXIT trap still fired, which is what says
      // the new trap did not replace it.
      expect(lockHeld).toBe(false);
    });

    it('restarts once on the happy path, before the upload', () => {
      const { calls, status, lockHeld } = run({ arm });

      expect(status).toBe(0);
      expect(calls.filter((call) => call === RESTORING_CALL[arm])).toHaveLength(
        1,
      );
      // The restart lives only in the trap, so the ordering the tail statement
      // used to give is now given by when the subshell closes. `uploadCommand`
      // is outside it, which is the answer to "does an upload failure still
      // leave the workload up": it is already up by then.
      const uploaded = calls.findIndex((call) => call.startsWith('rclone'));
      expect(uploaded).toBeGreaterThan(calls.indexOf(RESTORING_CALL[arm]));
      expect(lockHeld).toBe(false);
    });

    it('fails loudly rather than silently when the restart itself fails', () => {
      const { status, output, calls, lockHeld } = run({
        arm,
        restartFails: true,
      });

      // A `|| true` here would have made this exit 0 over a stopped workload,
      // which is H-74's shape: a guard whose failure mode is allow.
      expect(status).not.toBe(0);
      expect(calls).toContain(RESTORING_CALL[arm]);
      expect(output).toContain('❌ Volume backup failed');
      expect(output).toContain('is DOWN');
      // `❌` on stdout is what `failureReportedOn` selects from, so the sentence
      // an operator reads is this one rather than docker's line on stderr.
      expect(output.slice(output.indexOf('❌'))).toContain('Cloudgate');
      expect(calls.join('\n')).not.toContain('rclone');
      expect(lockHeld).toBe(false);
    });
  });

  describe('the replica count the restart needs (swarm arms only)', () => {
    it.each(['application', 'stack'] as const)(
      '%s: refuses before the stop when the count reads empty at exit 0',
      (arm) => {
        const { status, output, calls, lockHeld } = run({
          arm,
          replicas: 'empty',
        });

        // `docker service inspect` on a service that is not replicated-mode
        // exits 0 with nothing, and the script used to carry that straight into
        // `--replicas=` — which docker refuses on its own flag, after the stop.
        // Nothing is stopped now.
        expect(calls).not.toContain(STOPPING_CALL[arm]);
        expect(calls.join('\n')).not.toContain('run --rm');
        expect(status).toBe(1);
        expect(output).toContain(
          '❌ Volume backup aborted - the replica count could not be read',
        );
        expect(output).toContain('the workload is untouched');
        expect(lockHeld).toBe(false);
      },
    );

    it.each(['application', 'stack'] as const)(
      '%s: stops nothing when the daemon will not answer the count at all',
      (arm) => {
        // This arm needs no new guard — `set -e` from the lock preamble already
        // covers the capture — and it is asserted because that is the half of
        // the finding's mechanism that turned out to be already covered, and a
        // regression of it would be silent.
        const { status, calls, lockHeld } = run({ arm, replicas: 'fail' });

        expect(calls).toEqual([
          calls[0].startsWith('docker service inspect')
            ? calls[0]
            : 'unexpected',
        ]);
        expect(calls).not.toContain(STOPPING_CALL[arm]);
        expect(status).not.toBe(0);
        expect(lockHeld).toBe(false);
      },
    );

    it('carries a non-default count back rather than defaulting to 1', () => {
      const { calls } = run({ arm: 'application', replicas: '4' });

      expect(calls).toContain(
        'docker service update --replicas=4 --with-registry-auth main-app',
      );
    });
  });

  describe('the compose container that is not there (now under the trap)', () => {
    it('still uploads when the container vanished while the backup held it stopped', () => {
      // The volume lock's case, and the one the trap must not turn into a
      // failure: the stop worked, Remove containers or Delete took the
      // container away during the tar, and the tarball is valid whatever became
      // of the containers. So the "nothing to restart" branch returns 0 and the
      // upload runs.
      const { status, output, calls } = run({
        arm: 'docker-compose',
        containerVanishes: true,
      });

      expect(calls).toContain('docker stop 444d9d36df9e');
      expect(calls.join('\n')).toContain('run --rm');
      expect(calls.join('\n')).toContain('docker ps -aq');
      expect(calls.join('\n')).not.toContain('docker start');
      expect(output).toContain('No compose container found to restart');
      expect(output).not.toContain('❌');
      expect(calls.join('\n')).toContain('rclone copyto');
      expect(status).toBe(0);
    });

    // H-97, decided at X10, and H-118, which is the reason the two are one
    // commit. Until then `docker stop $ID` ran unguarded: an empty `$ID` made it
    // a usage error, `set -e` ended the script before the tar, and a turn-off
    // backup of a compose service an operator had stopped therefore never took
    // a backup — silently, indefinitely, because the caller is usually
    // `runScheduled`. The decision is that it should proceed: the only
    // precondition the stop exists to establish, nothing writing to the volume,
    // is already met.
    //
    // The `docker start` assertions are the H-118 half. `restore_workload`
    // re-looks-up with `-aq` so it can find a container this script exited,
    // which means it cannot tell "I stopped this" from "this was already down" —
    // so with only the stop guarded, H-96's trap fires on the way out of the
    // subshell and *starts* a container the backup never touched. Measured on
    // the box against a real one: `created` → `running`.
    it.each([
      ['already stopped', { containerAlreadyStopped: true }],
      ['not there at all', { noContainer: true }],
    ] as const)(
      'backs the volume up when the compose container is %s, and starts nothing',
      (_case, fixture) => {
        const { status, output, calls, lockHeld } = run({
          arm: 'docker-compose',
          ...fixture,
        });

        // The backup happens. This is the inversion: the same fixture used to
        // assert the tar and the upload did *not* run.
        expect(calls.join('\n')).toContain('run --rm');
        expect(calls.join('\n')).toContain('rclone copyto');
        expect(status).toBe(0);
        // Nothing was stopped, so nothing is started — and the run says both,
        // rather than leaving the log to `docker`'s usage text on stderr.
        expect(calls.join('\n')).not.toContain('docker stop');
        expect(calls.join('\n')).not.toContain('docker start');
        expect(output).toContain('No running compose container to stop');
        expect(output).toContain(
          'Nothing was stopped by this backup, so there is nothing to restart',
        );
        expect(output).not.toContain('❌');
        expect(lockHeld).toBe(false);
      },
    );

    it('restarts the container when the stop itself failed part-way', () => {
      // Which side of the `docker stop` H-97's flag goes on, decided by
      // execution rather than by reading. `$ID` can name more than one
      // container, so a stop that stops one and is refused for the next exits
      // non-zero with something already stopped — and that is precisely the
      // failure H-96 built the trap for. A flag set *after* the stop would skip
      // the restart on it.
      const { calls, status, output } = run({
        arm: 'docker-compose',
        stopFails: true,
      });

      expect(calls).toContain('docker stop 444d9d36df9e');
      expect(calls).toContain('docker start 444d9d36df9e');
      expect(output).not.toContain('Nothing was stopped by this backup');
      // The stop still failed, so the run fails and nothing is uploaded.
      expect(status).not.toBe(0);
      expect(calls.join('\n')).not.toContain('rclone');
    });

    it('still stops and restarts the container that is running', () => {
      // The other side of the flag, and the regression the guard could cause:
      // `STOPPED_BY_THIS_RUN` must not make the ordinary turn-off backup skip
      // its own restart. Asserted here as well as in the three-arm block above
      // because that block is where a `describe.each` would hide which arm the
      // flag broke.
      const { status, output, calls } = run({ arm: 'docker-compose' });

      expect(calls).toContain('docker stop 444d9d36df9e');
      expect(calls).toContain('docker start 444d9d36df9e');
      expect(output).toContain('Stopping compose container');
      expect(output).not.toContain('Nothing was stopped by this backup');
      expect(status).toBe(0);
    });
  });
});

/**
 * Which **root** the two builders stage under, and the lock they take.
 *
 * `volumeBackupsDirectory()` and `volumeBackupLockPath()` resolved
 * `localCloudgateDirectory()` — *this process's* root — while both scripts are
 * dispatched by `VolumeBackupsService` to the Service's own Server. With
 * `CLOUDGATE_DIRECTORY` unset the two roots are the same literal, so every
 * expected script above passes whichever root is resolved; these set it and
 * name the resolved temp path, because `/etc/cloudgate` exists and is writable
 * on some development hosts and a silent fall back would read as a pass.
 *
 * The staging tree and the lock fail differently, which is why both are here.
 * A staging directory under a root the Server does not own is *created* — by
 * `docker run -v`'s bind source and by rclone's own `mkdir -p` — so the cost is
 * a tree nothing on that machine owns and nothing reclaims. A lock file's
 * parent is created by nothing, so `exec 9>` failed outright and the `mkdir`
 * fallback answered 409 "volume is busy" about a lock nobody held.
 */
describe('buildVolumeRestoreScript and volumeLockPathFor, the root a backup and a restore run against', () => {
  const configured = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-volume-root-')),
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

  const restoreOn = (serverId: string | null) =>
    buildVolumeRestoreScript({
      serverId,
      volumeName: 'shop-data',
      backupFileName: 'main-app/daily/shop-data.tar',
      bucket: 'cloudgate-backups',
      target: { serviceType: 'application', appName: 'main-app' },
    });

  it('stages a Server’s restore under that Server’s own root, and locks there', () => {
    const script = restoreOn('srv-1');

    expect(script).toContain(
      `${REMOTE_CLOUDGATE_DIRECTORY}/volume-backups/shop-data`,
    );
    expect(script).toContain(
      `LOCK_PATH=${REMOTE_CLOUDGATE_DIRECTORY}/volume-backup-lock-shop-data`,
    );
    // Not one word of this instance's own layout reaches a machine that has
    // never heard of it.
    expect(script).not.toContain(configured);
  });

  // The branch that has to keep working: a Service on the platform host stages
  // where this process can write.
  it('stages the platform host’s restore under this instance’s configured root', () => {
    const script = restoreOn(null);

    expect(script).toContain(`${configured}/volume-backups/shop-data`);
    expect(script).toContain(
      `LOCK_PATH=${configured}/volume-backup-lock-shop-data`,
    );
    expect(script).not.toContain(REMOTE_CLOUDGATE_DIRECTORY);
  });

  /**
   * The backup builder takes its staging directory already resolved, because
   * `VolumeBackupsService` also has to name it in the cleanup that runs after
   * this script has exited — one string for the writer and the destroyer, which
   * is ADR-0018's rule. What this builder still roots itself is the lock, and a
   * backup taking a lock at a different path from the restore's would be the
   * volume lock with a hole in it.
   */
  it('takes the same lock file as the restore for the same volume and machine', () => {
    const backup = buildVolumeBackupScript({
      serverId: 'srv-1',
      volumeName: 'shop-data',
      backupFileName: 'shop-data-2026-07-23T10-20-30-456Z.tar',
      volumeBackupPath: `${REMOTE_CLOUDGATE_DIRECTORY}/volume-backups/main-app`,
      rcloneDestination: ':s3:cloudgate-backups/main-app/daily/x.tar',
      turnOff: false,
      lockMode: 'wait',
    });

    const lockLine = `LOCK_PATH=${volumeLockPathFor('srv-1', 'shop-data')}`;
    expect(backup).toContain(lockLine);
    expect(restoreOn('srv-1')).toContain(lockLine);
    expect(backup).not.toContain(configured);
  });
});
