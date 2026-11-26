import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildMomentRestoreScript,
  MOMENT_RESTORE_HALTED_EXIT_CODE,
  MOMENT_RESTORE_LEFT_STOPPED_EXIT_CODE,
} from '../../src/volume-backups/volume-backup-commands';
import type { MomentRestoreScriptOptions } from '../../src/volume-backups/volume-backup-commands';
import {
  expectValueIsInert,
  INERT_VALUE,
  SEPARATOR_PAYLOAD,
} from '../utils/shell-safety';

/**
 * A Stack backup's moment restore (ADR-0092, #165), **executed** under
 * `/bin/sh` with a stub `docker` and `rclone` that write every call to one
 * log, the shape `stack-backup-commands.spec.ts` uses for the backup.
 *
 * The stubs:
 * - `docker volume ls` answers the volume it is asked about, so each one
 *   exists; `docker ps -a` answers no container holding it.
 * - `docker run … tar xvf` fails for the volume named in `$STUB_UNTAR_FAILS`.
 * - `docker service ls` answers two services of the swarm stack, each at
 *   `$STUB_REPLICAS` replicas, or none with `$STUB_NO_SERVICES` set, as a
 *   swarm stack whose Stop removed every service answers.
 * - `rclone copyto` writes a non-empty file at its last argument, as a
 *   download does.
 */
const DOCKER_STUB = `#!/bin/sh
echo "docker $*" >> "$STUB_LOG"
case "$1 $2" in
	"volume ls")
		echo "\${5#name=^}" | tr -d '$'
		;;
	"service ls")
		if [ -z "$STUB_NO_SERVICES" ]; then
			printf '%s\\n' wiki_db wiki_app
		fi
		;;
	"service inspect")
		echo "$STUB_REPLICAS"
		;;
	"run --rm")
		case "$*" in
			*"$STUB_UNTAR_FAILS:/volume_data"*)
				if [ -n "$STUB_UNTAR_FAILS" ]; then
					echo "tar: ./data: Cannot write: No space left on device" >&2
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
if [ "$1" = lsjson ] && [ -n "$STUB_PROBE_FAILS" ]; then
	echo "Failed to lsjson: connection refused" >&2
	exit 1
fi
if [ "$1" = copyto ]; then
	for last in "$@"; do :; done
	mkdir -p "\${last%/*}"
	echo tarball > "$last"
fi
exit 0
`;

/** As `stack-backup-commands.spec.ts`'s: the real tools from the system
 * directories, never a wrapper some host puts first on `PATH`. */
function linkTools(binDir: string, names: string[]): void {
  for (const name of names) {
    const resolved = ['/bin', '/usr/bin']
      .map((dir) => path.join(dir, name))
      .find((candidate) => fs.existsSync(candidate));
    if (resolved) fs.symlinkSync(resolved, path.join(binDir, name));
  }
}

const MOMENT_KEY = 'wiki/nightly/2026-11-26T03-00-00-000Z/';

describe('buildMomentRestoreScript, executed under /bin/sh', () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-moment-restore-')),
  );
  const binDir = path.join(root, 'bin');
  const logFile = path.join(root, 'stub-calls.log');
  const scriptFile = path.join(root, 'script.sh');
  const original = process.env.CLOUDGATE_DIRECTORY;

  beforeAll(() => {
    fs.mkdirSync(binDir);
    // No `flock`, so every lock takes the `mkdir` fallback and its own EXIT
    // trap, which the restore's own report trap must not replace.
    linkTools(binDir, [
      'mkdir',
      'rm',
      'sleep',
      'printf',
      'wc',
      'tr',
      'grep',
      'cut',
      'cat',
    ]);
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
    overrides: Partial<MomentRestoreScriptOptions> = {},
  ): MomentRestoreScriptOptions => ({
    serverId: null,
    appName: 'wiki',
    bucket: 'cloudgate-backups',
    momentKey: MOMENT_KEY,
    volumeNames: ['zeta-db', 'alpha-files'],
    heldVolumeNames: ['zeta-db', 'alpha-files'],
    lifecycle: {
      composeType: 'docker-compose',
      remove: 'docker compose -p wiki rm --stop --force',
      start: 'docker compose -p wiki up -d',
    },
    ...overrides,
  });

  const run = (
    overrides: Partial<MomentRestoreScriptOptions> = {},
    stub: {
      untarFails?: string;
      probeFails?: boolean;
      noServices?: boolean;
    } = {},
  ) => {
    fs.rmSync(logFile, { force: true });
    for (const volume of ['alpha-files', 'zeta-db']) {
      fs.rmSync(path.join(root, `volume-backup-lock-${volume}.dir`), {
        recursive: true,
        force: true,
      });
    }
    fs.writeFileSync(
      scriptFile,
      buildMomentRestoreScript(optionsFor(overrides)),
    );
    const result = spawnSync('/bin/sh', [scriptFile], {
      encoding: 'utf8',
      env: {
        PATH: binDir,
        STUB_LOG: logFile,
        STUB_REPLICAS: '2',
        STUB_UNTAR_FAILS: stub.untarFails ?? '',
        STUB_PROBE_FAILS: stub.probeFails ? '1' : '',
        STUB_NO_SERVICES: stub.noServices ? '1' : '',
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

  /** Where the volume is replaced: its `docker volume rm`. */
  const replaceOf = (calls: string[], volume: string) =>
    calls.indexOf(`docker volume rm ${volume} --force`);

  it('removes the containers, restores every volume in name order, then starts the stack', () => {
    const { status, calls, output } = run();

    expect(status).toBe(0);
    const remove = calls.indexOf('docker compose -p wiki rm --stop --force');
    const start = calls.indexOf('docker compose -p wiki up -d');
    expect(remove).toBeGreaterThan(-1);
    expect(replaceOf(calls, 'alpha-files')).toBeGreaterThan(remove);
    expect(replaceOf(calls, 'zeta-db')).toBeGreaterThan(
      replaceOf(calls, 'alpha-files'),
    );
    expect(start).toBeGreaterThan(replaceOf(calls, 'zeta-db'));
    for (const volume of ['alpha-files', 'zeta-db']) {
      expect(
        calls.some(
          (call) =>
            call.startsWith('rclone copyto') &&
            call.endsWith(
              ` :s3:cloudgate-backups/${MOMENT_KEY}${volume}.tar ${root}/volume-backups/${volume}/${MOMENT_KEY}${volume}.tar`,
            ),
        ),
      ).toBe(true);
    }
    for (const step of [
      'Remove containers',
      'Restore alpha-files',
      'Restore zeta-db',
      'Start',
    ]) {
      expect(output).toContain(`Step started: ${step}`);
      expect(output).toContain(`Step done: ${step}`);
    }
  });

  it('takes every volume lock in name order before removing anything', () => {
    const { output } = run();

    const alpha = output.indexOf('Volume lock acquired: alpha-files');
    const zeta = output.indexOf('Volume lock acquired: zeta-db');
    expect(alpha).toBeGreaterThan(-1);
    expect(zeta).toBeGreaterThan(alpha);
    expect(output.indexOf('Step started: Remove containers')).toBeGreaterThan(
      zeta,
    );
  });

  it('stops a swarm stack and starts each service again at the replica count it had', () => {
    const { status, calls, output } = run({
      lifecycle: { composeType: 'stack' },
    });

    expect(status).toBe(0);
    const stops = [
      'docker service update --replicas=0 wiki_db',
      'docker service update --replicas=0 wiki_app',
    ];
    const starts = [
      'docker service update --replicas=2 --with-registry-auth wiki_db',
      'docker service update --replicas=2 --with-registry-auth wiki_app',
    ];
    for (const call of [...stops, ...starts]) expect(calls).toContain(call);
    const lastStop = Math.max(...stops.map((call) => calls.indexOf(call)));
    const firstStart = Math.min(...starts.map((call) => calls.indexOf(call)));
    expect(replaceOf(calls, 'alpha-files')).toBeGreaterThan(lastStop);
    expect(firstStart).toBeGreaterThan(replaceOf(calls, 'zeta-db'));
    expect(calls.some((call) => call.includes('docker compose'))).toBe(false);
    expect(output).toContain('Step done: Stop');
  });

  it('restores a swarm stack that was not running and leaves it stopped, saying so', () => {
    const { status, calls, output } = run(
      { lifecycle: { composeType: 'stack' } },
      { noServices: true },
    );

    expect(status).toBe(MOMENT_RESTORE_LEFT_STOPPED_EXIT_CODE);
    expect(replaceOf(calls, 'alpha-files')).toBeGreaterThan(-1);
    expect(replaceOf(calls, 'zeta-db')).toBeGreaterThan(-1);
    // Nothing was scaled, either way.
    expect(calls.some((call) => call.startsWith('docker service update'))).toBe(
      false,
    );
    expect(output).toContain('Step done: Start');
    expect(output).toContain('Start or Deploy');
    expect(output).not.toContain('❌');
  });

  it('stops at a failed volume, leaves the stack stopped, and names what was restored and what was not', () => {
    const { status, calls, output } = run({}, { untarFails: 'zeta-db' });

    expect(status).toBe(MOMENT_RESTORE_HALTED_EXIT_CODE);
    expect(calls).not.toContain('docker compose -p wiki up -d');
    expect(output).toContain('❌ Moment restore stopped at Restore zeta-db');
    expect(output).toContain('Restored: alpha-files');
    expect(output).toContain('Not restored: zeta-db');
    expect(output).toContain('The stack is left stopped');
  });

  it('restores nothing when Remove containers fails partway through its list', () => {
    // `set -e` passes over a failure anywhere but the last command of an
    // AND-OR list, which is the shape Remove containers' `cd … && …` has.
    const { status, calls, output } = run({
      lifecycle: {
        composeType: 'docker-compose',
        remove: `cd ${root}/no-project-directory && docker compose -p wiki rm --stop --force`,
        start: 'docker compose -p wiki up -d',
      },
    });

    expect(status).toBe(MOMENT_RESTORE_HALTED_EXIT_CODE);
    expect(replaceOf(calls, 'alpha-files')).toBe(-1);
    expect(output).toContain('❌ Moment restore stopped at Remove containers');
    expect(output).toContain('Restored: none');
  });

  it('stops before taking any lock or removing anything when the destination does not answer', () => {
    const { status, calls, output } = run({}, { probeFails: true });

    expect(status).not.toBe(0);
    expect(status).not.toBe(MOMENT_RESTORE_HALTED_EXIT_CODE);
    expect(calls).not.toContain('docker compose -p wiki rm --stop --force');
    expect(output).not.toContain('Volume lock acquired');
  });

  it('restores nothing after the first volume fails', () => {
    const { status, calls, output } = run({}, { untarFails: 'alpha-files' });

    expect(status).toBe(MOMENT_RESTORE_HALTED_EXIT_CODE);
    expect(replaceOf(calls, 'zeta-db')).toBe(-1);
    expect(output).toContain('Restored: none');
    expect(output).toContain('Not restored: alpha-files, zeta-db');
  });

  it('leaves a swarm stack at 0 replicas after a failed volume', () => {
    const { status, calls } = run(
      { lifecycle: { composeType: 'stack' } },
      { untarFails: 'alpha-files' },
    );

    expect(status).not.toBe(0);
    expect(
      calls.some((call) =>
        call.startsWith('docker service update --replicas=2'),
      ),
    ).toBe(false);
  });

  it('keeps every value one inert word', () => {
    // The shell's comment lines go first: `shell-quote` reads a `#` as a
    // comment running to the end of the whole input, so the restore body's
    // own comments would hide everything after them from the comparison.
    const built = (value: string) =>
      buildMomentRestoreScript(
        optionsFor({
          appName: value,
          bucket: value,
          momentKey: `${value}/nightly/2026-11-26T03-00-00-000Z/`,
          volumeNames: [value, 'zeta-db'],
          heldVolumeNames: [value, 'zeta-db'],
        }),
      ).replace(/^\s*#.*$/gm, '');

    expectValueIsInert(built(SEPARATOR_PAYLOAD), built(INERT_VALUE));
  });
});
