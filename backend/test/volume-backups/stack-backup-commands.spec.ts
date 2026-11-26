import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildMomentPruneCommand,
  buildStackBackupScript,
} from '../../src/volume-backups/volume-backup-commands';
import type { StackBackupScriptOptions } from '../../src/volume-backups/volume-backup-commands';
import {
  expectValueIsInert,
  INERT_VALUE,
  SEPARATOR_PAYLOAD,
} from '../utils/shell-safety';

/**
 * A Stack backup's script (ADR-0092), **executed** under `/bin/sh` with a
 * stub `docker` and `rclone` that write every call to one log, so what is
 * asserted is what the tools were asked to do, in order — the shape
 * `volume-backup-commands.spec.ts`'s executed block uses for one volume.
 *
 * The stubs:
 * - `docker ps -q` answers two running containers of the project;
 *   `docker service ls` two services of the swarm stack, each at
 *   `$STUB_REPLICAS` replicas.
 * - `docker run … tar` fails for the volume named in `$STUB_TAR_FAILS`.
 * - `rclone copyto` fails for the object named in `$STUB_UPLOAD_FAILS`.
 * - `rclone lsf --dirs-only` lists `$STUB_MOMENTS`, one per line.
 */
const DOCKER_STUB = `#!/bin/sh
echo "docker $*" >> "$STUB_LOG"
case "$1 $2" in
	"ps -q")
		printf '%s\\n' c1 c2
		;;
	"service ls")
		printf '%s\\n' wiki_db wiki_app
		;;
	"service inspect")
		echo "$STUB_REPLICAS"
		;;
	"run --rm")
		case "$*" in
			*"$STUB_TAR_FAILS:/volume_data"*)
				if [ -n "$STUB_TAR_FAILS" ]; then
					echo "tar: /volume_data: Cannot open" >&2
					exit 2
				fi
				;;
		esac
		;;
esac
exit 0
`;

const RCLONE_STUB = `#!/bin/sh
echo "rclone $*" >> "$STUB_LOG"
case "$1" in
	copyto)
		case "$3" in
			*"/$STUB_UPLOAD_FAILS")
				if [ -n "$STUB_UPLOAD_FAILS" ]; then
					echo "ERROR : Failed to copy: AccessDenied" >&2
					exit 1
				fi
				;;
		esac
		;;
	lsf)
		printf '%s' "$STUB_MOMENTS"
		;;
esac
exit 0
`;

/**
 * Links the real tools a script needs into a stub directory, from the system
 * directories rather than whatever `PATH` answers first, so a wrapper some
 * host puts in front of `rm` is not what the script runs. A shell builtin
 * (`printf` in dash) needs no link.
 */
function linkTools(binDir: string, names: string[]): void {
  for (const name of names) {
    const resolved = ['/bin', '/usr/bin']
      .map((dir) => path.join(dir, name))
      .find((candidate) => fs.existsSync(candidate));
    if (resolved) fs.symlinkSync(resolved, path.join(binDir, name));
  }
}

const MOMENT = '2026-11-26T03-00-00-000Z';
const BUCKET_MOMENT = `:s3:cloudgate-backups/wiki/nightly/${MOMENT}/`;

describe('buildStackBackupScript, executed under /bin/sh', () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-stack-backup-')),
  );
  const binDir = path.join(root, 'bin');
  const logFile = path.join(root, 'stub-calls.log');
  const scriptFile = path.join(root, 'script.sh');
  const momentPath = path.join(
    root,
    'volume-backups',
    'volume-backup-x1',
    MOMENT,
  );
  const original = process.env.CLOUDGATE_DIRECTORY;

  beforeAll(() => {
    fs.mkdirSync(binDir);
    // No `flock`, so the lock preamble takes its `mkdir` fallback and its own
    // EXIT trap — which the stack's restart trap must not replace.
    linkTools(binDir, ['mkdir', 'rm', 'sleep', 'printf']);
    fs.writeFileSync(path.join(binDir, 'docker'), DOCKER_STUB, { mode: 0o755 });
    fs.writeFileSync(path.join(binDir, 'rclone'), RCLONE_STUB, { mode: 0o755 });
    process.env.CLOUDGATE_DIRECTORY = root;
  });

  afterAll(() => {
    if (original === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = original;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const optionsFor = (
    overrides: Partial<StackBackupScriptOptions> = {},
  ): StackBackupScriptOptions => ({
    serverId: null,
    appName: 'wiki',
    composeType: 'docker-compose',
    volumeNames: ['zeta-db', 'alpha-files'],
    momentPath,
    rcloneMoment: BUCKET_MOMENT,
    turnOff: true,
    lockMode: 'wait',
    ...overrides,
  });

  const run = (
    overrides: Partial<StackBackupScriptOptions> = {},
    stub: { tarFails?: string; uploadFails?: string } = {},
  ) => {
    fs.rmSync(logFile, { force: true });
    fs.rmSync(path.join(root, 'volume-backup-lock-alpha-files.dir'), {
      recursive: true,
      force: true,
    });
    fs.rmSync(path.join(root, 'volume-backup-lock-zeta-db.dir'), {
      recursive: true,
      force: true,
    });
    fs.writeFileSync(scriptFile, buildStackBackupScript(optionsFor(overrides)));
    const result = spawnSync('/bin/sh', [scriptFile], {
      encoding: 'utf8',
      env: {
        PATH: binDir,
        STUB_LOG: logFile,
        STUB_REPLICAS: '2',
        STUB_TAR_FAILS: stub.tarFails ?? '',
        STUB_UPLOAD_FAILS: stub.uploadFails ?? '',
      },
    });
    return {
      status: result.status ?? -1,
      output: `${result.stdout}${result.stderr}`,
      calls: fs.existsSync(logFile)
        ? fs.readFileSync(logFile, 'utf8').trimEnd().split('\n')
        : [],
    };
  };

  const tarOf = (calls: string[], volume: string) =>
    calls.findIndex(
      (call) =>
        call.startsWith('docker run --rm') &&
        call.includes(`-v ${volume}:/volume_data`),
    );

  describe.each([
    {
      composeType: 'docker-compose' as const,
      stops: ['docker stop c1 c2'],
      starts: ['docker start c1 c2'],
    },
    {
      composeType: 'stack' as const,
      stops: [
        'docker service update --replicas=0 wiki_db',
        'docker service update --replicas=0 wiki_app',
      ],
      starts: [
        'docker service update --replicas=2 --with-registry-auth wiki_db',
        'docker service update --replicas=2 --with-registry-auth wiki_app',
      ],
    },
  ])('a $composeType stack', ({ composeType, stops, starts }) => {
    it('stops the stack once, tars every volume, starts it once, then uploads each under the moment', () => {
      const { status, calls } = run({ composeType });

      expect(status).toBe(0);
      for (const call of [...stops, ...starts]) {
        expect(calls.filter((made) => made === call)).toHaveLength(1);
      }
      const lastStop = Math.max(...stops.map((call) => calls.indexOf(call)));
      const firstStart = Math.min(...starts.map((call) => calls.indexOf(call)));
      for (const volume of ['alpha-files', 'zeta-db']) {
        expect(tarOf(calls, volume)).toBeGreaterThan(lastStop);
        expect(tarOf(calls, volume)).toBeLessThan(firstStart);
      }
      const uploads = calls.filter((call) => call.startsWith('rclone copyto'));
      expect(uploads).toEqual([
        `rclone copyto ${momentPath}/alpha-files.tar ${BUCKET_MOMENT}alpha-files.tar`,
        `rclone copyto ${momentPath}/zeta-db.tar ${BUCKET_MOMENT}zeta-db.tar`,
      ]);
      expect(calls.indexOf(uploads[0])).toBeGreaterThan(
        Math.max(...starts.map((call) => calls.indexOf(call))),
      );
    });

    it('starts the stack again when a tar fails, and uploads nothing', () => {
      const { status, calls } = run(
        { composeType },
        { tarFails: 'alpha-files' },
      );

      expect(status).not.toBe(0);
      for (const call of starts) expect(calls).toContain(call);
      expect(calls.some((call) => call.startsWith('rclone'))).toBe(false);
    });
  });

  it('stops nothing with the switch off', () => {
    const { status, calls } = run({ turnOff: false });

    expect(status).toBe(0);
    expect(calls.some((call) => call.startsWith('docker stop'))).toBe(false);
    expect(calls.some((call) => call.startsWith('docker start'))).toBe(false);
    expect(tarOf(calls, 'alpha-files')).toBeGreaterThan(-1);
    expect(tarOf(calls, 'zeta-db')).toBeGreaterThan(-1);
  });

  it("removes the moment's partial folder when an upload fails", () => {
    const { status, calls, output } = run({}, { uploadFails: 'zeta-db.tar' });

    expect(status).not.toBe(0);
    expect(calls).toContain(`rclone purge ${BUCKET_MOMENT}`);
    expect(calls.indexOf(`rclone purge ${BUCKET_MOMENT}`)).toBeGreaterThan(
      calls.findIndex((call) => call.includes('zeta-db.tar')),
    );
    expect(output).toContain('❌ Stack backup failed');
  });

  it('keeps every value one inert word', () => {
    const built = (value: string) =>
      buildStackBackupScript(
        optionsFor({
          appName: value,
          volumeNames: [value, 'alpha-files'],
          rcloneMoment: `:s3:${value}/wiki/nightly/${MOMENT}/`,
        }),
      );

    expectValueIsInert(built(SEPARATOR_PAYLOAD), built(INERT_VALUE));
  });
});

describe('buildMomentPruneCommand, executed under /bin/sh', () => {
  it('keeps the newest three moments whole and purges the older ones', () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-moment-prune-')),
    );
    const binDir = path.join(root, 'bin');
    const logFile = path.join(root, 'stub-calls.log');
    fs.mkdirSync(binDir);
    linkTools(binDir, ['sort', 'tail', 'xargs', 'printf', 'grep']);
    fs.writeFileSync(path.join(binDir, 'rclone'), RCLONE_STUB, { mode: 0o755 });

    const moments = [
      '2026-11-22T03-00-00-000Z/',
      '2026-11-25T03-00-00-000Z/',
      '2026-11-23T03-00-00-000Z/',
      '2026-11-26T03-00-00-000Z/',
      '2026-11-24T03-00-00-000Z/',
    ];
    const result = spawnSync(
      '/bin/sh',
      [
        '-c',
        buildMomentPruneCommand({
          momentsPath: ':s3:cloudgate-backups/wiki/nightly/',
          keepLatestCount: 3,
        }),
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: binDir,
          STUB_LOG: logFile,
          STUB_MOMENTS: `${moments.join('\n')}\n`,
        },
      },
    );

    expect(result.status).toBe(0);
    const purged = fs
      .readFileSync(logFile, 'utf8')
      .trimEnd()
      .split('\n')
      .filter((call) => call.startsWith('rclone purge'))
      .sort();
    expect(purged).toEqual([
      'rclone purge :s3:cloudgate-backups/wiki/nightly/2026-11-22T03-00-00-000Z/',
      'rclone purge :s3:cloudgate-backups/wiki/nightly/2026-11-23T03-00-00-000Z/',
    ]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('counts and purges only folders named as moments, never another folder under the prefix', () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-moment-prune-')),
    );
    const binDir = path.join(root, 'bin');
    const logFile = path.join(root, 'stub-calls.log');
    fs.mkdirSync(binDir);
    linkTools(binDir, ['sort', 'tail', 'xargs', 'printf', 'grep']);
    fs.writeFileSync(path.join(binDir, 'rclone'), RCLONE_STUB, { mode: 0o755 });

    // `zz-manual-copy/` sorts above every moment, so a count that took it in
    // would keep it as one of the newest three and purge a third moment.
    const folders = [
      '2026-11-22T03-00-00-000Z/',
      'zz-manual-copy/',
      '2026-11-25T03-00-00-000Z/',
      '2026-11-23T03-00-00-000Z/',
      'archive/',
      '2026-11-26T03-00-00-000Z/',
      '2026-11-24T03-00-00-000Z/',
    ];
    const result = spawnSync(
      '/bin/sh',
      [
        '-c',
        buildMomentPruneCommand({
          momentsPath: ':s3:cloudgate-backups/wiki/nightly/',
          keepLatestCount: 3,
        }),
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: binDir,
          STUB_LOG: logFile,
          STUB_MOMENTS: `${folders.join('\n')}\n`,
        },
      },
    );

    expect(result.status).toBe(0);
    const purged = fs
      .readFileSync(logFile, 'utf8')
      .trimEnd()
      .split('\n')
      .filter((call) => call.startsWith('rclone purge'))
      .sort();
    expect(purged).toEqual([
      'rclone purge :s3:cloudgate-backups/wiki/nightly/2026-11-22T03-00-00-000Z/',
      'rclone purge :s3:cloudgate-backups/wiki/nightly/2026-11-23T03-00-00-000Z/',
    ]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
