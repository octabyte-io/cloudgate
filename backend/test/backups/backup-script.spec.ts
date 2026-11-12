import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import {
  BACKUP_RUN_FAILED_STEP,
  buildBackupScript,
  buildRestoreScript,
  getBackupTimestamp,
  getComposeContainerCommand,
  getServiceContainerCommand,
  normalizeS3Path,
} from '../../src/backups/commands';

// The container-search, path and wrapper-script helpers behind every database
// backup and restore — expected literals are the exact commands and scripts
// they emit.
describe('container search commands', () => {
  it('finds the running container of a swarm service', () => {
    expect(getServiceContainerCommand('main-db')).toBe(
      'docker ps -q --filter "status=running" --filter label\\=com.docker.swarm.service.name\\=main-db | head -n 1',
    );
  });

  it('finds a stack service container by namespace + service labels', () => {
    expect(getComposeContainerCommand('shop-stack', 'db', 'stack')).toBe(
      'docker ps -q --filter "status=running" --filter label\\=com.docker.stack.namespace\\=shop-stack --filter label\\=com.docker.swarm.service.name\\=shop-stack_db | head -n 1',
    );
  });

  it('finds a docker-compose service container by project + service labels', () => {
    expect(
      getComposeContainerCommand('shop-stack', 'db', 'docker-compose'),
    ).toBe(
      'docker ps -q --filter "status=running" --filter label\\=com.docker.compose.project\\=shop-stack --filter label\\=com.docker.compose.service\\=db | head -n 1',
    );
  });
});

describe('normalizeS3Path', () => {
  it('trims whitespace and slashes, appending one trailing slash', () => {
    expect(normalizeS3Path(' /daily/ ')).toBe('daily/');
    expect(normalizeS3Path('daily/full')).toBe('daily/full/');
    expect(normalizeS3Path('')).toBe('');
    expect(normalizeS3Path('/')).toBe('');
  });
});

describe('getBackupTimestamp', () => {
  it('renders an ISO timestamp with filename-safe separators', () => {
    expect(getBackupTimestamp(new Date('2026-07-23T10:20:30.456Z'))).toBe(
      '2026-07-23T10-20-30-456Z',
    );
  });
});

describe('buildBackupScript', () => {
  // The upload command the service builds, verbatim: `rclone rcat` and one
  // quoted object, with no `--s3-*` flags in it. The cleanup the pipefail fix added
  // reads the object's name back out of it, so a token stands in for it only in
  // the test that pins what happens when it cannot be read.
  const UPLOAD_TARGET =
    ':s3:cloudgate-backups/main-db/daily/2026-07-23T10-20-30-456Z.sql.gz';

  const options = {
    containerSearch: 'CONTAINER_SEARCH',
    dumpCommand: 'DUMP_COMMAND',
    // `backups.service.ts` `quote()`s this destination since H-36, and a
    // `:`-bearing word comes back backslash-escaped rather than double-quoted.
    rcloneCommand:
      'rclone rcat \\:s3\\:cloudgate-backups/main-db/daily/2026-07-23T10-20-30-456Z.sql.gz',
    logPath: '/etc/cloudgate/logs/main-db/dep-1.log',
    // Handed over rather than parsed back out of `rcloneCommand` (H-36) — the
    // parse could not survive the destination being quoted, and the caller
    // knows the key exactly.
    uploadTarget: UPLOAD_TARGET,
  };

  // The dump runs exactly once, straight into rclone, and
  // `set -eo pipefail` is what fails the run. A probe dump into /dev/null
  // ahead of it would make every backup of every engine pay for a snapshot
  // nobody kept, and the probe would speak for a different snapshot than the
  // one that landed.
  it('runs the engine dump exactly once, piped into the upload', () => {
    const script = buildBackupScript(options);
    expect(script.match(/DUMP_COMMAND/g)).toHaveLength(1);
    expect(script).toContain('set -eo pipefail;');
    expect(script).toContain(
      '$({ { DUMP_COMMAND || { echo "$DUMP_FAILED" >&2; exit 1; }; } | rclone rcat \\:s3\\:cloudgate-backups/main-db/daily/2026-07-23T10-20-30-456Z.sql.gz; } 2>&1 >/dev/null)',
    );
    expect(script).not.toContain('BACKUP_OUTPUT');
  });

  // The failure branch is shared by both halves of the pipe and used to
  // hard-code the upload's name, so a dump that could not connect was logged as
  // `Error: Upload to S3 failed` with pg_dump's own reason on the next line.
  it('names the dump rather than the upload when the dump is what failed', () => {
    const script = buildBackupScript(options);
    expect(script).toContain(
      'DUMP_FAILED="The dump exited non-zero, so anything that reached S3 is a truncated stream";',
    );
    expect(script).toContain(
      '*"$DUMP_FAILED"*) FAILED_STEP="Database dump failed";;',
    );
    // The upload keeps its own heading for the half it really does speak for.
    expect(script).toContain('*) FAILED_STEP="Upload to S3 failed";;');
    expect(script).toContain(
      'echo "[$(date)] ❌ Error: $FAILED_STEP" >> /etc/cloudgate/logs/main-db/dep-1.log;',
    );
  });

  // `rclone rcat` commits as it streams, so a failed run had already put
  // a 20-byte empty gzip in the bucket under a real-looking key that the
  // restore picker offered. Removed by name, the way a failed volume backup
  // removes the one tarball it staged.
  it('removes the object the failed run committed to S3, by name', () => {
    const script = buildBackupScript(options);
    expect(script).toContain(
      `rclone deletefile --retries 1 --low-level-retries 1 --timeout 10s --contimeout 5s \\:s3\\:cloudgate-backups/main-db/daily/2026-07-23T10-20-30-456Z.sql.gz >> /etc/cloudgate/logs/main-db/dep-1.log 2>&1 \\`,
    );
    // Named, and the two failure branches say different things. `deletefile`
    // exits non-zero both for a key that was never written and for a delete
    // that could not run, and the commonest reason this cleanup runs at all —
    // an unreachable bucket — is also the reason the delete fails. Reporting
    // "Nothing to remove" there would assert the bucket was clean while the
    // 20-byte object sat in it, which is the same class of defect.
    expect(script).toContain(
      `rclone lsf --retries 1 --low-level-retries 1 --timeout 10s --contimeout 5s \\:s3\\:cloudgate-backups/main-db/daily/2026-07-23T10-20-30-456Z.sql.gz`,
    );
    // Three `echo` arguments since H-36: `$(date)` in the literal halves has
    // to run and the key must not, and `echo` joins them with a single space,
    // so the line the operator reads is the one it always was.
    expect(script).toContain(
      `|| echo "[$(date)] ⚠️  Could not remove" \\:s3\\:cloudgate-backups/main-db/daily/2026-07-23T10-20-30-456Z.sql.gz "— delete it by hand" >> /etc/cloudgate/logs/main-db/dep-1.log;`,
    );
    expect(script).toContain(
      `echo "[$(date)] Removed the partial object from S3" >> /etc/cloudgate/logs/main-db/dep-1.log`,
    );
    expect(script).toContain(
      `echo "[$(date)] Nothing to remove in S3" >> /etc/cloudgate/logs/main-db/dep-1.log;`,
    );
    // Named, not globbed, and no `rclone delete` — which would purge a prefix
    // if the target ever stopped naming exactly one object.
    expect(script).not.toContain('rclone delete "');
    expect(script).not.toContain('*.sql.gz');
    // Nothing is deleted once the upload has succeeded.
    expect(
      script.slice(script.indexOf('✅ Upload to S3 completed')),
    ).not.toContain('deletefile');
  });

  it('names the object whatever shape the upload command takes', () => {
    // This used to be a tolerance test for a regex that read the key back out
    // of `rcloneCommand`, and its reasoning was the argument against itself:
    // every sibling rclone call in this tree has gained `boundedRcloneFlags` at
    // some point, and an anchored match would return null the day this one did,
    // leaving the bucket unguarded with only a log line to say so. H-36 made
    // the key a parameter, so the cleanup no longer depends on the upload
    // command's shape at all — flags, quoting or a rewrite of the line.
    const script = buildBackupScript({
      ...options,
      rcloneCommand: 'rclone rcat --retries 1 --timeout 30s SOMETHING-ELSE',
      uploadTarget: ':s3:bucket/key.sql.gz',
    });
    expect(script).toContain('rclone deletefile');
    expect(script).toContain('\\:s3\\:bucket/key.sql.gz');
  });

  it('says in the log when the committed object cannot be named', () => {
    const script = buildBackupScript({
      ...options,
      uploadTarget: null,
    });
    expect(script).not.toContain('deletefile');
    expect(script).toContain(
      'echo "[$(date)] ⚠️ The object this run may have committed to S3 could not be named from the upload command, so nothing was removed" >> /etc/cloudgate/logs/main-db/dep-1.log;',
    );
  });

  it('wraps container search and rclone upload with logging', () => {
    expect(buildBackupScript(options)).toBe(`
	set -eo pipefail;
	echo "[$(date)] Starting backup process..." >> /etc/cloudgate/logs/main-db/dep-1.log;
	echo "[$(date)] Executing backup command..." >> /etc/cloudgate/logs/main-db/dep-1.log;
	CONTAINER_ID=$(CONTAINER_SEARCH)

	if [ -z "$CONTAINER_ID" ]; then
		echo "[$(date)] ❌ Error: Container not found" >> /etc/cloudgate/logs/main-db/dep-1.log;
		echo "❌ Error: Container not found" >&2;
		exit 1;
	fi

	echo "[$(date)] Container Up: $CONTAINER_ID" >> /etc/cloudgate/logs/main-db/dep-1.log;

	echo "[$(date)] Starting upload to S3..." >> /etc/cloudgate/logs/main-db/dep-1.log;

	DUMP_FAILED="The dump exited non-zero, so anything that reached S3 is a truncated stream";

	# Dump straight into the upload — one dump per run — and capture the
	# exit status of the whole pipe (set -o pipefail is on, and inherited here).
	# Both halves' stderr is captured, not just rclone's: with the probe gone
	# this line is the only place the engine's own complaint can reach the log.
	# The dump's own \`||\` puts $DUMP_FAILED on that same stream, which is how the
	# branch below tells a dump failure from an upload failure — the pipe's
	# exit status cannot, and PIPESTATUS does not outlive the substitution. The
	# nesting is load-bearing: \`|\` binds tighter than \`||\`, so without the inner
	# brace group the marker would become the left-hand side of the pipe.
	PIPE_OUTPUT=$({ { DUMP_COMMAND || { echo "$DUMP_FAILED" >&2; exit 1; }; } | rclone rcat \\:s3\\:cloudgate-backups/main-db/daily/2026-07-23T10-20-30-456Z.sql.gz; } 2>&1 >/dev/null) || {
		case "$PIPE_OUTPUT" in
			*"$DUMP_FAILED"*) FAILED_STEP="Database dump failed";;
			*) FAILED_STEP="Upload to S3 failed";;
		esac
		echo "[$(date)] ❌ Error: $FAILED_STEP" >> /etc/cloudgate/logs/main-db/dep-1.log;
		echo "Error: $PIPE_OUTPUT" >> /etc/cloudgate/logs/main-db/dep-1.log;
		echo "[$(date)] Removing the object this run committed to S3..." >> /etc/cloudgate/logs/main-db/dep-1.log;
		if rclone lsf --retries 1 --low-level-retries 1 --timeout 10s --contimeout 5s \\:s3\\:cloudgate-backups/main-db/daily/2026-07-23T10-20-30-456Z.sql.gz >/dev/null 2>&1; then
			rclone deletefile --retries 1 --low-level-retries 1 --timeout 10s --contimeout 5s \\:s3\\:cloudgate-backups/main-db/daily/2026-07-23T10-20-30-456Z.sql.gz >> /etc/cloudgate/logs/main-db/dep-1.log 2>&1 \\
				&& echo "[$(date)] Removed the partial object from S3" >> /etc/cloudgate/logs/main-db/dep-1.log \\
				|| echo "[$(date)] ⚠️  Could not remove" \\:s3\\:cloudgate-backups/main-db/daily/2026-07-23T10-20-30-456Z.sql.gz "— delete it by hand" >> /etc/cloudgate/logs/main-db/dep-1.log;
		else
			echo "[$(date)] Nothing to remove in S3" >> /etc/cloudgate/logs/main-db/dep-1.log;
		fi;
		# The heading and the tool's own words on stderr as well: the log
		# is a file on the Server, and stderr is what reaches whoever pressed
		# Run now. The marker line is dropped — it tells the halves apart, and
		# the heading already says which one broke.
		printf '❌ Error: %s\\n' "$FAILED_STEP" >&2;
		printf '%s\\n' "$PIPE_OUTPUT" | grep -vxF "$DUMP_FAILED" >&2 || true;
		exit 1;
	}

	echo "[$(date)] ✅ Upload to S3 completed successfully" >> /etc/cloudgate/logs/main-db/dep-1.log;
	echo "Backup done ✅" >> /etc/cloudgate/logs/main-db/dep-1.log;
	`);
  });
});

describe('buildRestoreScript', () => {
  it('pipes the rclone download into the restore command', () => {
    expect(
      buildRestoreScript({
        containerSearch: 'CONTAINER_SEARCH',
        restoreCommand: 'RESTORE_COMMAND',
        rcloneCommand: 'RCLONE_COMMAND',
        reachabilityProbe: 'PROBE_COMMAND',
        databaseType: 'postgres',
      }),
    ).toBe(
      'set -eo pipefail; CONTAINER_ID=$(CONTAINER_SEARCH) && PROBE_COMMAND > /dev/null ' +
        '&& RCLONE_COMMAND | RESTORE_COMMAND',
    );
  });

  // The download's retry budget is set to survive a link that is
  // degraded but moving, and the counter that buys that also governs a connect
  // that never completes — so the endpoint is asked about once, by something
  // whose whole job is to fail fast, before that budget can be spent on it. The
  // probe's own output is discarded: it is asking whether the endpoint answers,
  // not what is in the bucket, and on this branch its JSON would otherwise be
  // the first thing the engine's import ever read.
  it('asks whether the endpoint answers before the download can spend its retries', () => {
    const script = buildRestoreScript({
      containerSearch: 'CONTAINER_SEARCH',
      restoreCommand: 'RESTORE_COMMAND',
      rcloneCommand: 'RCLONE_COMMAND',
      reachabilityProbe: 'PROBE_COMMAND',
      databaseType: 'postgres',
    });

    expect(script.indexOf('PROBE_COMMAND')).toBeLessThan(
      script.indexOf('RCLONE_COMMAND'),
    );
    expect(script).toContain('PROBE_COMMAND > /dev/null');
    // Chained with `&&` under `set -e`, so a probe that fails ends the script
    // rather than being narrated past.
    expect(script).not.toContain('PROBE_COMMAND ||');
  });

  it('mongo: probes before the temp directory is made, so a dead endpoint stages nothing', () => {
    const script = buildRestoreScript({
      containerSearch: 'CONTAINER_SEARCH',
      restoreCommand: 'RESTORE_COMMAND',
      rcloneCommand: 'RCLONE_COMMAND',
      reachabilityProbe: 'PROBE_COMMAND',
      databaseType: 'mongo',
      backupFile: 'main-db/daily/dump.bson.gz',
    });

    expect(script.indexOf('PROBE_COMMAND')).toBeLessThan(
      script.indexOf('mktemp -d'),
    );
  });

  // Without `pipefail` the pipeline reports its last element only, so a
  // download that failed was answered by whatever the engine made of an empty
  // stream — and `mysql` and `mariadb` fed nothing exit 0, which recorded a
  // restore that restored nothing as a success. Every engine's restore opens
  // with it, mongo included, where there is no pipe to fail but also no reason
  // for one engine's script to start differently from the others'.
  it('opens every engine restore with pipefail', () => {
    for (const databaseType of [
      'postgres',
      'mysql',
      'mariadb',
      'mongo',
      'libsql',
    ] as const) {
      expect(
        buildRestoreScript({
          containerSearch: 'CONTAINER_SEARCH',
          restoreCommand: 'RESTORE_COMMAND',
          rcloneCommand: 'RCLONE_COMMAND',
          reachabilityProbe: 'PROBE_COMMAND',
          databaseType,
          backupFile: 'main-db/daily/dump.bson.gz',
        }),
      ).toMatch(/^set -eo pipefail; CONTAINER_ID=\$\(CONTAINER_SEARCH\)/);
    }
  });

  it('mongo: downloads to a temp dir, gunzips and feeds the archive file', () => {
    expect(
      buildRestoreScript({
        containerSearch: 'CONTAINER_SEARCH',
        restoreCommand: 'RESTORE_COMMAND',
        rcloneCommand: 'RCLONE_COMMAND',
        reachabilityProbe: 'PROBE_COMMAND',
        databaseType: 'mongo',
        backupFile: 'main-db/daily/2026-07-23T10-20-30-456Z.bson.gz',
      }),
    )
      .toBe(`set -eo pipefail; CONTAINER_ID=$(CONTAINER_SEARCH) && PROBE_COMMAND > /dev/null
RESTORE_DIR=$(mktemp -d "/tmp/cloudgate-restore.XXXXXX")
trap 'rm -rf "$RESTORE_DIR"' EXIT
RCLONE_COMMAND "$RESTORE_DIR"
cd "$RESTORE_DIR"
gunzip -f 2026-07-23T10-20-30-456Z.bson.gz
RESTORE_COMMAND < 2026-07-23T10-20-30-456Z.bson`);
  });
});

/**
 * These run the generated mongo restore, rather than asserting strings about
 * it, in the same shape as `test/deployment-engine/volume-lock.spec.ts` — and
 * for the same reason: every `toBe` above passed while the bug was live.
 *
 * The bug: cleanup was the last link of an `&&` chain, and POSIX exempts
 * every command of an AND-OR list except the last from `set -e`, so a
 * `mongorestore` that exited non-zero simply stopped the chain and left the
 * whole decompressed archive on the host. `set -eo pipefail` cannot see
 * that, because the failing link is not the last one.
 *
 * `bash`, not `sh`, because the script opens with `pipefail` and installs an
 * `EXIT` trap — `backups.service.ts` passes `shell: '/bin/bash'` for exactly
 * this. Docker is stubbed rather than used: `containerSearch` echoes an id,
 * `rcloneCommand` copies a gzipped fixture into the directory it is handed, and
 * `restoreCommand` is `cat` or `false`. What is being proved is the shell's
 * control flow, which is where the residual came from; only a real
 * `mongorestore` can prove the trap against a real failure, and the trap fix's
 * acceptance run does that by hand.
 */
describe('the generated mongo restore, executed', () => {
  const root = fs.realpathSync(
    // Deliberately *not* prefixed `cloudgate-restore`: on Linux `os.tmpdir()`
    // is `/tmp`, and this fixture directory would then read as a leak below.
    fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-i182-fixture-')),
  );
  const scriptFile = path.join(root, 'restore.sh');
  const fixture = path.join(root, 'dump.bson.gz');
  const BODY = 'the archive contents';
  let preexisting: string[] = [];

  /** The temp directories the script may create, by its own prefix. A leaked
   * one is the whole defect, so the assertion is over `/tmp` itself. */
  const restoreDirs = (): string[] =>
    fs
      .readdirSync('/tmp')
      .filter((entry) => entry.startsWith('cloudgate-restore'));

  beforeAll(() => {
    fs.writeFileSync(fixture, zlib.gzipSync(Buffer.from(BODY)));
    // Another agent, or an earlier interrupted run, may own one already.
    preexisting = restoreDirs();
  });

  afterAll(() => {
    // Sweep anything this file created even when an assertion failed, so a red
    // run does not leave the litter it was written to detect.
    for (const entry of restoreDirs()) {
      if (!preexisting.includes(entry)) {
        fs.rmSync(path.join('/tmp', entry), { recursive: true, force: true });
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const run = (
    restoreCommand: string,
    rcloneCommand = `cp "${fixture}"`,
    /** The endpoint answered. `false` is the one that did not. */
    reachabilityProbe = 'true',
  ): { status: number; leaked: string[] } => {
    fs.writeFileSync(
      scriptFile,
      buildRestoreScript({
        containerSearch: 'echo cid',
        restoreCommand,
        rcloneCommand,
        reachabilityProbe,
        databaseType: 'mongo',
        backupFile: 'main-db/daily/dump.bson.gz',
      }),
    );
    const result = spawnSync('bash', [scriptFile], { encoding: 'utf8' });
    return {
      status: result.status ?? -1,
      leaked: restoreDirs().filter((entry) => !preexisting.includes(entry)),
    };
  };

  it('leaves nothing behind when the restore command fails', () => {
    const { status, leaked } = run('false');
    expect(status).not.toBe(0);
    expect(leaked).toEqual([]);
  });

  it('leaves nothing behind when the download fails', () => {
    // Fails before the archive exists: the trap is armed by then, and the
    // directory `mktemp` created has to go too.
    const { status, leaked } = run('cat >/dev/null', 'cp /no/such/archive.gz');
    expect(status).not.toBe(0);
    expect(leaked).toEqual([]);
  });

  // The probe is in front of `mktemp` rather than beside the
  // download, so a destination that is not answering costs this host no
  // directory at all — and, on the volume side, no lock.
  it('stages no temp directory when the endpoint does not answer', () => {
    const { status, leaked } = run(
      'cat >/dev/null',
      `cp "${fixture}"`,
      'false',
    );
    expect(status).not.toBe(0);
    expect(leaked).toEqual([]);
  });

  it('restores and cleans up when everything succeeds', () => {
    const output = path.join(root, 'restored.bson');
    const { status, leaked } = run(`cat > "${output}"`);
    expect(status).toBe(0);
    expect(leaked).toEqual([]);
    // The import really was fed the decompressed archive, not an empty stream.
    expect(fs.readFileSync(output, 'utf8')).toBe(BODY);
  });

  it('gives concurrent restores separate directories', () => {
    // The concurrent-restore shape, which a trap on the old fixed path would have
    // reintroduced: one run's cleanup must not be able to reach another run's archive.
    const dirOf = (script: string): string => {
      const file = path.join(root, 'echo-dir.sh');
      fs.writeFileSync(file, script);
      return spawnSync('bash', [file], { encoding: 'utf8' }).stdout.trim();
    };
    const script = buildRestoreScript({
      containerSearch: 'echo cid',
      restoreCommand: 'cat >/dev/null',
      rcloneCommand: `cp "${fixture}"`,
      reachabilityProbe: 'true',
      databaseType: 'mongo',
      backupFile: 'main-db/daily/dump.bson.gz',
    }).replace('cd "$RESTORE_DIR"', 'echo "$RESTORE_DIR"\ncd "$RESTORE_DIR"');
    expect(dirOf(script)).not.toBe(dirOf(script));
    expect(restoreDirs().filter((e) => !preexisting.includes(e))).toEqual([]);
  });
});

/**
 * The run's log is not the only reader of a failed dump any more. A
 * pressed **Run now** is answered with the step that broke and why, and the
 * backend can only say that if the script says it somewhere the exec seam
 * returns — the log is a file on the Server, and the script's stdout and stderr
 * are all the `ExecError` carries. So every failure branch writes its heading and
 * the tool's own words to stderr as well, and these run the generated script to
 * prove the stream carries them rather than pinning the text that writes them.
 */
describe('buildBackupScript, executed', () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-i498-fixture-')),
  );
  const scriptFile = path.join(root, 'backup.sh');
  const logPath = path.join(root, 'run.log');

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const run = (
    overrides: Partial<Parameters<typeof buildBackupScript>[0]>,
  ): { status: number; stderr: string; log: string } => {
    fs.rmSync(logPath, { force: true });
    fs.writeFileSync(
      scriptFile,
      buildBackupScript({
        containerSearch: 'echo cid',
        dumpCommand: 'echo the-dump',
        rcloneCommand: 'cat >/dev/null',
        logPath,
        // No object to clean up, so the branch never reaches for a real rclone.
        uploadTarget: null,
        ...overrides,
      }),
    );
    const result = spawnSync('bash', [scriptFile], { encoding: 'utf8' });
    return {
      status: result.status ?? -1,
      stderr: result.stderr,
      log: fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '',
    };
  };

  it('says on stderr that the upload failed, and what the destination said', () => {
    const result = run({
      rcloneCommand:
        'sh -c \'cat >/dev/null; echo "Failed to rcat: SignatureDoesNotMatch" >&2; exit 1\'',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      `❌ Error: ${BACKUP_RUN_FAILED_STEP.upload}\nFailed to rcat: SignatureDoesNotMatch\n`,
    );
    // The log keeps the lines it always had.
    expect(result.log).toContain('❌ Error: Upload to S3 failed');
    expect(result.log).toContain(
      'Error: Failed to rcat: SignatureDoesNotMatch',
    );
  });

  it('says on stderr that the dump failed, with the engine’s reason and not the marker', () => {
    const result = run({
      dumpCommand:
        'sh -c \'echo "pg_dump: error: connection refused" >&2; exit 1\'',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      `❌ Error: ${BACKUP_RUN_FAILED_STEP.dump}\npg_dump: error: connection refused\n`,
    );
    expect(result.log).toContain('❌ Error: Database dump failed');
  });

  it('says on stderr that there was no container to dump', () => {
    const result = run({ containerSearch: 'true' });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      `❌ Error: ${BACKUP_RUN_FAILED_STEP.container}\n`,
    );
  });

  it('writes nothing to stderr when the run succeeds', () => {
    const result = run({});
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.log).toContain('Backup done ✅');
  });
});
