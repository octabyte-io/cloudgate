import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BadRequestException } from '@nestjs/common';
import type { BackupRunRecorderService } from '../../src/backups/run-recorder.service';
import type { ServiceParent } from '../../src/common/service-parent';
import type { Destination } from '../../src/db/schema';
import type { NotificationDispatcherService } from '../../src/notifications/dispatcher.service';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import { buildVolumeBackupScript } from '../../src/volume-backups/volume-backup-commands';
import type { VolumeBackup } from '../../src/volume-backups/volume-backup.schema';
import { VolumeBackupsService } from '../../src/volume-backups/volume-backups.service';
import { SELF_HOSTED } from '../utils/instance-mode-double';

/**
 * H-21. A volume backup is a cron job: `runScheduled` reads the row and builds
 * a shell script from it with **no request in the call at all**, so a row
 * written before `volumeName` and `prefix` had any rule can never reach a DTO
 * again — there is no write left to validate. Two things answer that, and both
 * are asserted here:
 *
 * - **The script builder quotes every word it interpolates**, so the stored
 *   value is data even when nothing filtered it. That half is proved by running
 *   the emitted script under `sh` against stub binaries and looking at what is
 *   on disk, on the precedent of `volume-lock.spec.ts` — a string assertion
 *   restates the builder, and the builder is what is in question.
 * - **`run` holds the row to the DTO's own rule before building anything**, so
 *   a pre-rule row fails its run loudly instead of executing. That half is
 *   asserted through `run` rather than through the private guard, because the
 *   claim worth pinning is not "it throws" but *where the throw lands*: the run
 *   is recorded, finished `error` and notified, which is what puts a poisoned
 *   row in the one place an operator looks at backups.
 */
describe('VolumeBackupsService', () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-volume-backup-run-')),
  );
  const binDir = path.join(root, 'bin');
  const originalDirectory = process.env.CLOUDGATE_DIRECTORY;

  /** Records what it was asked to do and does nothing else — the assertion is
   * that `volumeName` arrived as one argument rather than as a command. */
  const DOCKER_STUB = `#!/bin/sh
for arg in "$@"; do printf '%s\\n' "$arg" >> "$STUB_LOG"; done
exit 0
`;
  const RCLONE_STUB = `#!/bin/sh
exit 0
`;

  beforeAll(() => {
    fs.mkdirSync(binDir);
    for (const name of ['mkdir', 'rm', 'sleep']) {
      const resolved = spawnSync('/bin/sh', ['-c', `command -v ${name}`], {
        encoding: 'utf8',
      }).stdout.trim();
      if (!resolved)
        throw new Error(`the executed shell needs ${name} on PATH`);
      fs.symlinkSync(resolved, path.join(binDir, name));
    }
    fs.writeFileSync(path.join(binDir, 'docker'), DOCKER_STUB, { mode: 0o755 });
    fs.writeFileSync(path.join(binDir, 'rclone'), RCLONE_STUB, { mode: 0o755 });
    // The lock preamble's path is read at build time, in this process.
    process.env.CLOUDGATE_DIRECTORY = root;
  });

  afterAll(() => {
    if (originalDirectory === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = originalDirectory;
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('buildVolumeBackupScript, executed', () => {
    /**
     * Runs the generated script's `docker run` line under `sh` with only the
     * stubs on `PATH`, and answers the argument list `docker` was handed.
     *
     * **The one line, not the whole script, and that is a statement about what
     * is still unfixed.** `withVolumeLock` wraps every path this builder emits
     * and lives in `deployment-engine/volume-lock.ts`, outside this module —
     * it puts `volumeName` into `LOCK_PATH="…"` and three `echo "…"` lines,
     * all still unquoted, so a `$(…)` payload substitutes there and the script
     * never reaches the line under test. That residual is reported rather than
     * fixed here; running the preamble too would assert its behaviour, and its
     * behaviour is the bug.
     */
    const dockerArgumentsFor = (volumeName: string): string[] => {
      const logFile = path.join(root, 'docker-args.log');
      fs.rmSync(logFile, { force: true });
      const [dockerLine, ...rest] = buildVolumeBackupScript({
        serverId: null,
        volumeName,
        backupFileName: `${volumeName}-2026-07-23T10-20-30-456Z.tar`,
        volumeBackupPath: path.join(root, 'staging'),
        rcloneDestination: ':s3:cloudgate-backups/main-app/daily/x.tar',
        turnOff: false,
        lockMode: 'fail-fast',
      })
        .split('\n')
        .filter((line) => line.includes('docker run --rm'));
      expect(rest).toEqual([]);

      const result = spawnSync('/bin/sh', ['-c', dockerLine], {
        cwd: root,
        encoding: 'utf8',
        env: { PATH: binDir, STUB_LOG: logFile },
      });
      expect(result.status).toBe(0);
      return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
    };

    afterEach(() => {
      fs.rmSync(path.join(root, 'pwned'), { force: true });
    });

    it('hands docker the volume mount as one argument', () => {
      expect(dockerArgumentsFor('shop-data')).toContain(
        'shop-data:/volume_data',
      );
    });

    it('keeps a statement separator in the volume mount, and runs nothing', () => {
      // `-v ${volumeName}:/volume_data` was bare, so this ended the `docker
      // run` and started a second command on the run host.
      expect(dockerArgumentsFor('x;touch pwned #')).toContain(
        'x;touch pwned #:/volume_data',
      );
      expect(fs.existsSync(path.join(root, 'pwned'))).toBe(false);
    });

    it('keeps a command substitution in the volume mount, and runs nothing', () => {
      // The half double quotes would not have caught: every `"…"` in this
      // script substitutes, so double-quoting the word was never a fix.
      expect(dockerArgumentsFor('a$(touch pwned)')).toContain(
        'a$(touch pwned):/volume_data',
      );
      expect(fs.existsSync(path.join(root, 'pwned'))).toBe(false);
    });

    it('keeps a backtick substitution in the volume mount, and runs nothing', () => {
      expect(dockerArgumentsFor('a`touch pwned`')).toContain(
        'a`touch pwned`:/volume_data',
      );
      expect(fs.existsSync(path.join(root, 'pwned'))).toBe(false);
    });
  });

  describe('a stored row written before the rule existed', () => {
    const row = (
      volumeName: string,
      prefix = 'daily',
      overrides: Partial<VolumeBackup> = {},
    ): VolumeBackup =>
      ({
        volumeBackupId: 'vb-1',
        name: 'nightly uploads',
        volumeName,
        prefix,
        appName: 'volume-backup-abc123',
        serviceType: 'application',
        serviceName: null,
        turnOff: false,
        schedule: '0 3 * * *',
        keepLatestCount: null,
        enabled: true,
        destinationId: 'dst-1',
        ...overrides,
      }) as unknown as VolumeBackup;

    const parent = {
      serverId: null,
      organizationId: 'org-1',
      name: 'checkout-api',
      projectName: 'storefront',
      appName: 'main-app',
      serviceType: 'application',
    } as unknown as ServiceParent;

    const destination = { bucket: 'cloudgate-backups' } as Destination;

    /** `run` with the three collaborators the refusal path reaches, and
     * nothing else built: anything further would fail loudly rather than pass
     * quietly. */
    const runWith = async (stored: VolumeBackup) => {
      const finished: Array<'done' | 'error'> = [];
      const notified: string[] = [];
      const executed: string[] = [];

      const runRecorder = {
        start: () =>
          Promise.resolve({ deploymentId: 'dep-1', logPath: '/tmp/dep-1.log' }),
        finish: (_id: string, status: 'done' | 'error') => {
          finished.push(status);
          return Promise.resolve();
        },
      } as unknown as BackupRunRecorderService;

      const dispatcher = {
        dispatch: (_organizationId: string, event: { status: string }) => {
          notified.push(event.status);
          return Promise.resolve();
        },
      } as unknown as NotificationDispatcherService;

      const remoteExec = {
        execAsync: (command: string) => {
          executed.push(command);
          return Promise.resolve({ stdout: '', stderr: '' });
        },
      } as unknown as RemoteExecService;

      const service = new VolumeBackupsService(
        null as never,
        null as never,
        remoteExec,
        null as never,
        runRecorder,
        null as never,
        dispatcher,
        null as never,
        SELF_HOSTED,
      );

      const error = await service['run'](
        stored,
        parent,
        destination,
        'wait',
      ).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      return { error, finished, notified, executed };
    };

    it('runs a row whose stored values are clean', async () => {
      const { error, finished, notified, executed } = await runWith(
        row('shop-data'),
      );

      expect(error).toBeNull();
      expect(finished).toEqual(['done']);
      expect(notified).toEqual(['success']);
      // It got past the guard and built the script the run host executes,
      // which is what the refusals below prove a poisoned row does not.
      expect(executed.join('\n')).toContain('docker run --rm');
    });

    it('refuses the run of a row whose volumeName cannot be given to a shell', async () => {
      const { error, finished, notified } = await runWith(row('a$(id)'));

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as Error).message).toContain('Volume backup vb-1');
      expect((error as Error).message).toContain('volumeName');
      // The stored payload is never echoed back: the message is journalled,
      // notified and rendered in the console, and repeating an injection into
      // all three puts it somewhere new for no gain.
      expect((error as Error).message).not.toContain('$(id)');
      // A scheduled run has nobody watching the response, so the refusal has
      // to land where an operator looks at backups — the run history.
      expect(finished).toEqual(['error']);
      expect(notified).toEqual(['error']);
    });

    it('refuses the run of a row whose prefix cannot be given to a shell', async () => {
      const { error } = await runWith(row('shop-data', 'daily;id'));

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as Error).message).toContain('prefix');
    });

    it('refuses the run of a row whose serviceName cannot be given to a shell', async () => {
      // The third field of the row that reaches a shell, and the one the
      // guard did not cover: a compose row's `serviceName` is
      // `{appName}_{serviceName}` in the object key and two `docker ps`
      // labels, and a row written before the charset existed has no write left
      // to validate it.
      const { error, finished, notified } = await runWith(
        row('shop-data', 'daily', {
          serviceType: 'compose',
          serviceName: 'api$(id)',
        }),
      );

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as Error).message).toContain('Volume backup vb-1');
      expect((error as Error).message).toContain('serviceName');
      expect((error as Error).message).not.toContain('$(id)');
      expect(finished).toEqual(['error']);
      expect(notified).toEqual(['error']);
    });

    it('runs a compose row whose serviceName is one a stack declares', async () => {
      const { error, finished } = await runWith(
        row('shop-data', 'daily', {
          serviceType: 'compose',
          serviceName: 'db.primary',
        }),
      );

      expect(error).toBeNull();
      expect(finished).toEqual(['done']);
    });

    it('runs a row that records no stack service either way', async () => {
      // The column is nullable, and `s3AppName` and `stopTarget` both read any
      // falsy value as "no stack service" — so `null` and `''` are absent
      // rather than poisoned, and a guard that refused them would stop every
      // application backup on the instance.
      for (const serviceName of [null, '']) {
        const { error, finished } = await runWith(
          row('shop-data', 'daily', { serviceName }),
        );

        expect(error).toBeNull();
        expect(finished).toEqual(['done']);
      }
    });

    it('builds no script and reaches no host for a refused row', async () => {
      const { executed } = await runWith(row('a$(id)'));

      // The only exec on this path is the staged-tarball cleanup, which is
      // best-effort and has nothing to clean up — and it carries the stored
      // name, so it is quoted too.
      for (const command of executed) {
        expect(command).not.toContain('docker run');
        expect(command).not.toContain('rclone');
        expect(command).not.toContain('$(id)');
      }
    });
  });
});
