import { BadRequestException } from '@nestjs/common';
import { quote } from 'shell-quote';
import type { ComposeType } from '../../compose/compose.schema';
import { boundedRcloneFlags } from '../../destinations/rclone-exec';
import type {
  BackupDatabaseType,
  DatabaseCredentials,
  EngineCommand,
} from './types';

// Helpers shared by backup, prune and restore: how the target container is
// found, how S3 object names are built, and the shell scripts the per-engine
// pipelines are wrapped in.

/**
 * `docker exec [-e NAME] -i $CONTAINER_ID <shell> -c <program>` — the one
 * wrapper the five engine builders emit their dump and restore pipelines
 * through (H-37).
 *
 * **Passing `credentials` is what makes the program authenticated**, and it is
 * the third argument rather than a boolean because the value and the
 * pass-through have to move together: the flag names
 * {@link DATABASE_PASSWORD_ENV} for `docker` to copy across, and the returned
 * {@link EngineCommand.env} is what carries the value to the execution. An
 * engine that omits it gets the shape postgres and libsql have always had, with
 * no `-e` and an empty env. See {@link DATABASE_PASSWORD_ENV} for the mechanism
 * and for the two alternatives this rejected.
 *
 * **Two shells, and the quoting this replaced defended neither.** The whole
 * thing is a word in a script `RemoteExecService` runs on the host, and the
 * program was spliced into a `"…"` there, so a `$(…)` or a backtick in a value
 * substituted on that *outer* shell before `docker` was reached. Inside the
 * program the values sat in `'…'`, which the outer shell had already stripped
 * of any meaning — so the inner quoting was decoration.
 *
 * Both levels are `quote()`d now, and it is here rather than in five files
 * because the wrapper is the thing they share and a fifth spelling of it is a
 * fifth chance to get one of them wrong (§1.4). The caller `quote()`s each
 * value into `program`, for the shell that will run *it*; this `quote()`s
 * `program` once, for the shell that runs `docker`.
 *
 * `database`, `databaseUser` and `databasePassword` are what travel in here.
 * `createBackupSchema.database` carries `DATABASE_NAME_REGEX`, which is about
 * the *flag* and *path* readings of that word rather than about this quoting;
 * the two credentials beside it carry no charset and never will, because a
 * password's whole job is to contain the characters a charset would refuse
 * (`composeMetadataSchema` argues it). So the quoting here is the defence for
 * all three, and the charset stands behind one of them:
 * `builders/build-strategy.ts` has the rule and the three earlier times it was
 * learned; this is the fourth surface.
 */
export const engineShellCommand = (
  shell: 'sh' | 'bash',
  program: string,
  credentials?: Pick<DatabaseCredentials, 'databasePassword'>,
): EngineCommand =>
  credentials === undefined
    ? { command: dockerExec(shell, program, []), env: {} }
    : {
        command: dockerExec(shell, program, [DATABASE_PASSWORD_ENV]),
        // `?? ''` for the reason `DatabaseCredentials` gives: an absent value
        // used to interpolate as the literal `undefined`, and an empty word is
        // the same refusal with a truthful command behind it. The variable is
        // always *present* so the pass-through is deterministic — `--password=`
        // and `-p''` are what the old commands emitted for an absent value, and
        // an empty assignment reproduces them exactly.
        env: { [DATABASE_PASSWORD_ENV]: credentials.databasePassword ?? '' },
      };

const dockerExec = (
  shell: 'sh' | 'bash',
  program: string,
  passThrough: readonly string[],
): string =>
  `docker exec ${passThrough.map((name) => `-e ${name} `).join('')}-i $CONTAINER_ID ${shell} -c ${quote([program])}`;

/**
 * The variable the three authenticating engines read their password out of, and
 * the reference they read it with — `"$CLOUDGATE_DB_PASSWORD"`, which is what
 * appears in the command instead of the password.
 *
 * **How it crosses into the container.** `docker exec -e NAME` — the flag with
 * *no* `=value` — copies the variable out of the docker client's own
 * environment. That is the load-bearing detail: `-e NAME=value` would put the
 * password straight back into the host's `docker exec` argv and therefore into
 * `ExecError.command`, which is the bug. So the value's whole journey is
 * `backup.metadata` → `RemoteExecOptions.env` → `export NAME='…'` on the SSH
 * channel (or the local child's `env`) → `docker exec -e NAME` → the inner
 * shell's `"$NAME"`. No layer of it is a word of any command string this tree
 * assembles, which is what `test/backups/backup-credential-never-carried.spec.ts`
 * asserts in both directions and `execRclone`'s guard refuses a regression of.
 *
 * **Measured against docker 29.3.1, because the spec's `docker` is a stub and a
 * stub can only be faithful to what was checked.** With the flag, the container
 * sees the value; *without* it the variable is unset inside the container, so
 * the pass-through is load-bearing rather than decorative; a value of
 * `a$(touch /pwned)` crosses as data and creates no file; and the docker
 * client's own argv on the host reads
 * `docker exec -e CLOUDGATE_DB_PASSWORD -i <id> sh -c …` — **the name, never the
 * value** — which is the host-process-table exposure this shape removes. Writing
 * `-e NAME=value` would put all of that back.
 *
 * The expansion is inside `"…"`, so a password containing `$(…)`, a backtick or
 * a `;` is data: a shell does not re-scan an expansion for substitutions. That
 * is the H-37 quoting proof moving along with the value rather than being
 * dropped, and the spec above re-runs it here.
 *
 * **Why not `MYSQL_PWD`, and why not a defaults file.** Both were weighed:
 *
 * - `MYSQL_PWD` would let `mysqldump` and `mariadb-dump` take the password with
 *   no flag at all, which is one strictly better thing: the value would not be a
 *   word of the *tool's* argv inside the container either. It is rejected on two
 *   counts. MySQL deprecated it in 8.4 and still says "expect it to be removed
 *   in a future version" at 9.7, and `database.constants.ts`' `dockerImage` is
 *   operator-writable — so the platform's answer to a secrets-hygiene ticket
 *   would rest on a mechanism its own vendor is removing, and a `mysql:10`
 *   somebody sets would take every mysql backup with it. And MySQL's reason for
 *   deprecating it is *precisely* environment visibility ("extremely insecure …
 *   your password is exposed to any other user who runs ps"), which under
 *   `docker exec -e` is an exposure this shape has anyway: the container's
 *   environment carries the value either way, so `MYSQL_PWD`'s only real gain is
 *   the container's own process table — an audience that is mysqld itself and
 *   whatever else is inside the database container, which already holds the data
 *   the password protects. It is not worth a deprecated dependency.
 * - A **defaults file** (`--defaults-extra-file`, and `mongodump --config`,
 *   which is the mongo equivalent and the only password mechanism the MongoDB
 *   Database Tools have besides the flag and an interactive TTY prompt) has to
 *   be materialized *inside the container*: `getCreateFileCommand` writes on the
 *   host, and these tools run under `docker exec`. Getting it there means a
 *   second exec whose command carries `base64(the password)` — covered by
 *   the `ENCODED_FILE_BODY` elision, and therefore exactly the mask answer
 *   ADR 0015 tells the next author not to reach for — plus an `umask`, a trap to
 *   remove it on every path, and a `--config` that is version
 *   gated at Database Tools 100.3.0. It would move the value from the
 *   container's argv to a file in the same container: the same audience, more
 *   machinery, and a new way for a restore to leave a credential on a disk.
 *
 * So the flag each tool documents stays, and only its *value* changes — which
 * is also what makes "the credential still reaches the tool" provable rather
 * than hoped for, since the authentication path is byte-identical to the one
 * that has been running.
 *
 * **What this does not buy, stated rather than discovered later.** The password
 * is a word of `mysqldump`/`mongodump`'s argv and a variable in their
 * environment *inside the database container*, readable from that container's
 * own `/proc`. What it takes away is every exposure outside it: the journal, the
 * notification body `BackupsService.notifyRun` sends, the run log, and the
 * Server's own process table, where any other user on the host could read it out
 * of `ps` while the dump ran.
 *
 * One variable for all three engines rather than `MYSQL_PWD`, `MARIADB_PWD` and
 * a mongo spelling: nothing downstream reads it by name except the program the
 * same builder emitted, so a per-engine name would be three constants saying one
 * thing. `CLOUDGATE_`-prefixed so it cannot collide with a variable the
 * database image itself means something by — `MYSQL_PWD` notably included.
 */
export const DATABASE_PASSWORD_ENV = 'CLOUDGATE_DB_PASSWORD';

/** How a program refers to {@link DATABASE_PASSWORD_ENV}. Quoted, so the value
 * is one word whatever it contains, and derived from the name rather than
 * spelled a second time in three builders (§1.4). */
export const DATABASE_PASSWORD_REF = `"$${DATABASE_PASSWORD_ENV}"`;

/** ISO instant with filename-safe separators. */
export const getBackupTimestamp = (now: Date = new Date()): string =>
  now.toISOString().replace(/[:.]/g, '-');

/** A clean `prefix/` (or '') S3 fragment. */
export const normalizeS3Path = (prefix: string): string => {
  const normalizedPrefix = prefix.trim().replace(/^\/+|\/+$/g, '');
  return normalizedPrefix ? `${normalizedPrefix}/` : '';
};

/**
 * The path segments of a bucket-relative key, refusing one that can climb out
 * of the prefix it appears to sit under.
 *
 * **This exists because a Service's dumps live under a prefix, and that prefix
 * is an authorization boundary.** Every dump this product writes
 * lands at `{appName}/{prefix}/{timestamp}.{ext}` —
 * `BackupsService.buildRunScript` builds it and `s3AppName` picks the leading
 * segment — so `BackupsService.checkBackupFileAccess` decides who may restore a
 * key by asking which Service owns that leading segment. A key carrying a `..`
 * segment makes the answer a lie: the segment it is checked under and the object
 * rclone resolves are different objects.
 *
 * **The write side needed it too, and that half was a finding rather than a
 * precaution.** {@link normalizeS3Path} strips leading and trailing slashes and
 * nothing else, and `createBackupSchema.prefix` is `z.string().min(1)`, so
 * `prefix: '../other-service/daily'` used to put a Service's dumps under a
 * *sibling's* prefix — and `BackupsService.pruneOldBackups`, which runs
 * `rclone delete` under `{appName}/{prefix}/`, used to delete there. That is why
 * this refuses rather than normalizes, on `cleanAppName`'s precedent (`db/columns.ts`):
 * a path rewritten to be safe is not the path the caller asked for, and a
 * backup row that disagrees with the objects it claims is worse than a 400.
 *
 * `BadRequestException` from a helper, on the same precedent — §2.5's built-ins
 * thrown where the value is, so the three call sites do not each carry a copy.
 * It is a *shape* check and it is not the authorization: what decides who may
 * read a dump is `BackupsService.checkBackupFileAccess`, and this only makes the
 * question well-posed.
 */
export const bucketKeySegments = (key: string): string[] => {
  if (hasTraversalSegment(key)) {
    throw new BadRequestException(`A bucket path ${BUCKET_TRAVERSAL_MESSAGE}`);
  }
  return key.split('/').filter((segment) => segment.length > 0);
};

/**
 * The rule {@link bucketKeySegments} refuses on, as a predicate — so a *stored*
 * key can be held to it without an exception being the only way to ask.
 *
 * `storedBackupShellSchema` needs it as a zod refinement rather than as a
 * throw, because a scheduled run reports every poisoned field of the row at
 * once and a `BadRequestException` from here would report the first. Split out
 * rather than spelled a second time in the DTO: the two are the same rule and
 * §2.4's "derive, never re-declare" is about exactly this, one layer down.
 */
export const hasTraversalSegment = (key: string): boolean =>
  key.split('/').some((segment) => segment === '.' || segment === '..');

/** Phrased to read both as this module's own sentence and as a zod field
 * message (§2.4's lowercase inline messages), since both say it. */
export const BUCKET_TRAVERSAL_MESSAGE = 'cannot contain a "." or ".." segment';

/**
 * The names a bucket's top-level prefix could be a Service's `appName` under.
 *
 * `s3AppName` writes a database backup's dumps under `{appName}/` and a compose
 * backup's under `{appName}_{serviceName}/`, and `serviceName` is the operator's
 * own compose service name — `COMPOSE_SERVICE_NAME_REGEX`, which
 * still admits `_` because Compose does — so the leading segment of a compose
 * dump's key is not an `appName` and has to be trimmed back to one. Every
 * `_`-separated head is a candidate because
 * `APP_NAME_REGEX` admits `_` in an `appName` too, so `a_b_c` is genuinely
 * ambiguous between the Service `a_b_c`, the Service `a_b` with stack service
 * `c`, and the Service `a` with stack service `b_c`.
 *
 * `BackupsService.checkBackupFileAccess` resolves *all* of them and requires
 * entitlement to every Service that answers, which is what makes the ambiguity
 * safe rather than exploitable — see its docblock for the shadowing attack that
 * decides it.
 */
export const bucketPrefixCandidates = (segment: string): string[] => {
  const candidates = [segment];
  for (
    let at = segment.lastIndexOf('_');
    at > 0;
    at = segment.lastIndexOf('_', at - 1)
  ) {
    candidates.push(segment.slice(0, at));
  }
  return candidates;
};

/**
 * The running container backing a swarm service (databases deploy as
 * single-replica services).
 *
 * The label word is `quote()`d (H-35). It goes into `$(…)` inside
 * `buildBackupScript`, which goes to `RemoteExecService`, and a `"…"` is not a
 * defence: a `$(…)` or a backtick substitutes inside double quotes exactly as
 * it does in a bare word. `appName` is held to `APP_NAME_REGEX` at its mint and
 * that stands *behind* the quoting rather than in place of it —
 * `builders/build-strategy.ts` carries the rule and the three times this tree
 * has had to learn it.
 */
export const getServiceContainerCommand = (appName: string): string =>
  `docker ps -q --filter "status=running" --filter ${quote([`label=com.docker.swarm.service.name=${appName}`])} | head -n 1`;

/**
 * The running container of one service inside a compose project or swarm stack.
 *
 * Same quoting, and until the charset it was the only thing standing (H-35):
 * `serviceName` was `z.string().optional()` on `createBackupSchema` and
 * `createVolumeBackupSchema` alike — no charset, no mint, nothing between the
 * request body and this word. It was the compose-side twin of the `volumeName`
 * H-19 found reaching `mkdir` unquoted, and both schemas now hold it to
 * `COMPOSE_SERVICE_NAME_REGEX`, which stands behind this quoting rather than in
 * place of it.
 */
export const getComposeContainerCommand = (
  appName: string,
  serviceName: string,
  composeType: ComposeType | null,
): string => {
  if (composeType === 'stack') {
    return `docker ps -q --filter "status=running" --filter ${quote([`label=com.docker.stack.namespace=${appName}`])} --filter ${quote([`label=com.docker.swarm.service.name=${appName}_${serviceName}`])} | head -n 1`;
  }
  return `docker ps -q --filter "status=running" --filter ${quote([`label=com.docker.compose.project=${appName}`])} --filter ${quote([`label=com.docker.compose.service=${serviceName}`])} | head -n 1`;
};

export interface PruneCommandOptions {
  /** `:s3:{bucket}/{s3AppName}/{prefix}/` — where the backups live. */
  backupFilesPath: string;
  /** rclone lsf --include pattern for this backup kind's files. */
  include: string;
  keepLatestCount: number;
}

/** Runs after every successful backup: lists the backup files, keeps the newest
 * keepLatestCount, deletes the rest. Backup names sort chronologically, so
 * reverse-sort and drop the first N. Shared by database (Phase 35) and volume
 * backups.
 *
 * No credential parameter, by construction: the destination's `--s3-*`
 * flags would otherwise be interpolated into both rclone calls, and this
 * command is logged — twice over, since a prune failure is also written to the
 * console. The caller passes `getS3CredentialsEnv` to the execution instead, so
 * there is nothing here for a later change to put back. */
export const buildPruneCommand = ({
  backupFilesPath,
  include,
  keepLatestCount,
}: PruneCommandOptions): string => {
  // Both words carry a value and both are `quote()`d (H-36). `backupFilesPath`
  // was **bare**, and it is `:s3:{bucket}/{s3AppName}/{prefix}/` — `prefix` is
  // `z.string().min(1)` on both create DTOs, so a `;` in it ended this command
  // and started another on whichever host the prune runs on. `include` was in
  // double quotes, which stops a space and not a `$(…)`.
  //
  // The `{}` stays inside the quoted word rather than beside it: `xargs -I{}`
  // substitutes its placeholder anywhere in the argument, quotes included, so
  // one word is both correct and the only spelling that keeps a path with a
  // space in it a single argument.
  const list = `rclone lsf --include ${quote([include])} ${quote([backupFilesPath])}`;
  const pickUnwanted = `sort -r | tail -n +$((${keepLatestCount}+1)) | xargs -I{}`;
  const remove = `rclone delete ${quote([`${backupFilesPath}{}`])}`;
  return `${list} | ${pickUnwanted} ${remove}`;
};

export interface BackupScriptOptions {
  /** Command echoing the target container id (container-search helpers). */
  containerSearch: string;
  /** The engine's dump-and-compress pipeline (builder.dump). */
  dumpCommand: string;
  /** `rclone rcat` and the S3 object destination — credentials travel in the
   * environment the script is executed with, never in this string. */
  rcloneCommand: string;
  /** Log file the run appends progress to (the deployment record's). */
  logPath: string;
  /**
   * The S3 object `rclone rcat` streams into, so the failure branch can remove
   * it by name — `null` when the caller cannot name it.
   *
   * **Passed, not parsed** (H-36). It used to be recovered from
   * `rcloneCommand` with `/rclone\s+rcat\b.*\s"([^"]+)"\s*$/`, which was a
   * reasonable reading of a string this module also owned — until the
   * destination had to be `quote()`d, at which point a legitimate `:s3:` word
   * stops being double-quoted and the regex answers `null` for every run. The
   * old docblock had already made the argument against itself: it warned that
   * an anchored match "would have started returning `null` the day this one
   * did, leaving the bucket unguarded with only a log line to say so". The
   * caller builds the destination and knows it exactly; asking it is the fix
   * the regex was a workaround for.
   *
   * `null` keeps its meaning and its loud branch, which is now a claim about
   * the *caller* rather than about a parse.
   */
  uploadTarget: string | null;
}

/** The wrapper script a backup run executes — find the container, then stream
 * dump | rclone to S3, logging each step into the deployment's log file.
 *
 * One dump per run. The run used to pipe the engine's whole pipeline
 * into `/dev/null` first as a probe and then run the identical pipeline again
 * into `rclone rcat`, so every backup of every engine dumped twice and threw
 * the first away. The probe could not speak for the snapshot that landed either
 * — they are two different snapshots, and it is the second, unprobed one that
 * reaches the bucket. The pipeline's own exit status says everything the probe
 * said: `set -eo pipefail` is on, so a dump that fails anywhere in the pipe
 * fails the run, and the upload branch already captures and logs the output.
 *
 * Two things the original design did not cover, both found on the box:
 *
 * - The exit status speaks for the *run*; it does not speak for the **bucket**.
 * `rclone rcat` commits as it streams, so a dump that never connected
 *   still left a 20-byte empty gzip under a real-looking key, which nothing
 *   listing the bucket could tell from a dump and which the restore picker
 *   offered. The failure branch now removes that object by name — the shape
 *   `volume-backups` uses for a failed run's staged tarball: named
 *   rather than globbed, and best-effort, because the dump's failure is what
 *   this run reports and a cleanup with nothing to clean is not a second
 *   failure. Bringing back the `/dev/null` probe was the alternative and is
 *   still refused: it pays for a second whole dump, and it does not even cover
 *   the case — a dump that starts cleanly and dies at 90% passes any probe and
 *   commits a truncated object anyway. The probe guarded the bucket by
 *   accident; the cleanup guards it on purpose.
 * - The branch is shared by both halves of the pipe, so it was announcing
 *   `Upload to S3 failed` above the engine's own connection error. It
 *   now names the half that broke: the dump's `||` marks the stream it
 *   truncated on the same stderr the branch reads, which is what makes the two
 *   distinguishable at all — `PIPESTATUS` does not survive the command
 *   substitution, and a heading that hedged ("dump or upload") would still make
 *   an operator read the body to learn whether to fix their database or their
 *   destination. */
/**
 * The heading each failure branch of {@link buildBackupScript} writes — to the
 * run's log, as it always has, and now as the first line of the
 * script's stderr too, so the backend can answer a pressed Run now with the
 * step that broke (`backups/run-failure.ts` reads it back). One set of words
 * for both, so the toast and the log cannot drift apart.
 */
export const BACKUP_RUN_FAILED_STEP = {
  container: 'Container not found',
  dump: 'Database dump failed',
  upload: 'Upload to S3 failed',
} as const;

/** The line the dump's own `||` adds to the pipe's stderr — how the
 * failure branch tells the two halves apart, and not itself a reason. */
export const DUMP_FAILED_MARKER =
  'The dump exited non-zero, so anything that reached S3 is a truncated stream';

export const buildBackupScript = ({
  containerSearch,
  dumpCommand,
  rcloneCommand,
  logPath,
  uploadTarget,
}: BackupScriptOptions): string => {
  // Every `>>` target in this script is the same word, quoted once (H-33).
  // Sixteen redirects took `logPath` bare, and the path is
  // `{logsDirectoryOn}/{appName}/{deploymentId}.log` — an `appName` held to
  // `APP_NAME_REGEX` three modules away, which is the reliance H-12 and H-19
  // were both about. `builders/build-strategy.ts` states the ordering: the
  // quoting is the defence and the charset stands behind it.
  const log = quote([logPath]);
  const target = uploadTarget === null ? null : quote([uploadTarget]);
  // Bounded, while the `rcat` it cleans up after deliberately is not.
  // The distinction is not the endpoint, it is what the call is: the upload is a
  // transfer whose length is the point and has to be allowed to run for as long
  // as the database is big, while this is one DELETE on the way to answering a
  // caller already waiting on a failed run. `10s` for the same reason the
  // one-object probe uses it — a single delete that has gone quiet for ten
  // seconds is not going to finish.
  const cleanUpPartialObject = (
    uploadTarget
      ? [
          `echo "[$(date)] Removing the object this run committed to S3..." >> ${log};`,
          // `|| echo "Nothing to remove"` was wrong on the branch that matters
          // `deletefile` exits non-zero both when the key was
          // never written and when the delete could not run — and the commonest
          // reason this cleanup runs at all is an unreachable bucket, which is
          // also the reason the delete fails. So the old line asserted the
          // bucket was clean in exactly the case where a 20-byte object was
          // sitting in it, which is the class of untrue log line to avoid. `rclone lsf`
          // answers whether the key is there, so the two cases are told apart and the
          // operator is given the instruction they
          // need in the second one.
          `if rclone lsf ${boundedRcloneFlags({ idle: '10s' })} ${target} >/dev/null 2>&1; then`,
          `\trclone deletefile ${boundedRcloneFlags({ idle: '10s' })} ${target} >> ${log} 2>&1 \\`,
          `\t\t&& echo "[$(date)] Removed the partial object from S3" >> ${log} \\`,
          // Three `echo` arguments rather than one interpolated message:
          // `$(date)` in the literal halves has to run, and `${target}` must
          // not. `echo` joins its arguments with a single space, so the line an
          // operator reads is unchanged.
          `\t\t|| echo "[$(date)] ⚠️  Could not remove" ${target} "— delete it by hand" >> ${log};`,
          `else`,
          `\techo "[$(date)] Nothing to remove in S3" >> ${log};`,
          `fi;`,
        ]
      : [
          // Loud rather than silent: a caller that stops naming its upload
          // destination leaves the bucket unguarded again, and the log is where
          // that shows up. The wording still says "from the upload command"
          // because that is where the caller gets it — it is now handed over
          // rather than parsed back out (H-36).
          `echo "[$(date)] ⚠️ The object this run may have committed to S3 could not be named from the upload command, so nothing was removed" >> ${log};`,
        ]
  ).join('\n\t\t');

  return `
	set -eo pipefail;
	echo "[$(date)] Starting backup process..." >> ${log};
	echo "[$(date)] Executing backup command..." >> ${log};
	CONTAINER_ID=$(${containerSearch})

	if [ -z "$CONTAINER_ID" ]; then
		echo "[$(date)] ❌ Error: ${BACKUP_RUN_FAILED_STEP.container}" >> ${log};
		echo "❌ Error: ${BACKUP_RUN_FAILED_STEP.container}" >&2;
		exit 1;
	fi

	echo "[$(date)] Container Up: $CONTAINER_ID" >> ${log};

	echo "[$(date)] Starting upload to S3..." >> ${log};

	DUMP_FAILED="${DUMP_FAILED_MARKER}";

	# Dump straight into the upload — one dump per run — and capture the
	# exit status of the whole pipe (set -o pipefail is on, and inherited here).
	# Both halves' stderr is captured, not just rclone's: with the probe gone
	# this line is the only place the engine's own complaint can reach the log.
	# The dump's own \`||\` puts $DUMP_FAILED on that same stream, which is how the
	# branch below tells a dump failure from an upload failure — the pipe's
	# exit status cannot, and PIPESTATUS does not outlive the substitution. The
	# nesting is load-bearing: \`|\` binds tighter than \`||\`, so without the inner
	# brace group the marker would become the left-hand side of the pipe.
	PIPE_OUTPUT=$({ { ${dumpCommand} || { echo "$DUMP_FAILED" >&2; exit 1; }; } | ${rcloneCommand}; } 2>&1 >/dev/null) || {
		case "$PIPE_OUTPUT" in
			*"$DUMP_FAILED"*) FAILED_STEP="${BACKUP_RUN_FAILED_STEP.dump}";;
			*) FAILED_STEP="${BACKUP_RUN_FAILED_STEP.upload}";;
		esac
		echo "[$(date)] ❌ Error: $FAILED_STEP" >> ${log};
		echo "Error: $PIPE_OUTPUT" >> ${log};
		${cleanUpPartialObject}
		# The heading and the tool's own words on stderr as well: the log
		# is a file on the Server, and stderr is what reaches whoever pressed
		# Run now. The marker line is dropped — it tells the halves apart, and
		# the heading already says which one broke.
		printf '❌ Error: %s\\n' "$FAILED_STEP" >&2;
		printf '%s\\n' "$PIPE_OUTPUT" | grep -vxF "$DUMP_FAILED" >&2 || true;
		exit 1;
	}

	echo "[$(date)] ✅ Upload to S3 completed successfully" >> ${log};
	echo "Backup done ✅" >> ${log};
	`;
};

export interface RestoreScriptOptions {
  /** Command echoing the target container id (container-search helpers). */
  containerSearch: string;
  /** The engine's import command (builder.restore). */
  restoreCommand: string;
  /** The rclone download: `rclone cat … | gunzip` piped straight into the
   * import, except mongo where it is an `rclone copy …` handed the per-run
   * temp directory to download into. */
  rcloneCommand: string;
  /**
   * A bounded listing of the same key, run first purely to find out whether the
   * endpoint answers. Required rather than optional: `rcloneCommand`'s
   * retry budget is chosen so a *degraded* link still assembles, and that is
   * only affordable because something in front refuses an *absent* one — a
   * caller that forgot this would silently get the slow shape back.
   */
  reachabilityProbe: string;
  databaseType: BackupDatabaseType;
  /** S3 object key of the dump — mongo only, to name the downloaded file. */
  backupFile?: string;
}

/** `mktemp -d` template, not a directory: the trailing `XXXXXX` is what makes
 * every mongo restore its own directory. Still one greppable constant,
 * and still a deterministic string, so the golden test stays possible. */
const RESTORE_TEMP_DIR_TEMPLATE = '/tmp/cloudgate-restore.XXXXXX';

/** Pipes the download into the import — except mongorestore, which wants a
 * seekable archive file, so mongo downloads to a temp directory, gunzips and
 * redirects the file in.
 *
 * Opens with `set -eo pipefail`, and **the shell has to be bash** — the caller
 * passes `shell: '/bin/bash'` for this, the way the backup run does. `pipefail`
 * is not POSIX; under `/bin/sh` the `set` line is a no-op or an error depending
 * on the host's `sh`, and "simplifying" the shell back restores the bug in
 * silence, which is why it is written down here rather than left to the option.
 *
 * What the bug was: without `pipefail` a pipeline reports the status of
 * its **last** element only, and every non-mongo restore is
 * `rclone cat … | gunzip | <the engine's import>`. So a download that failed —
 * an unreachable bucket, a mistyped key, a 403 — was not what the run reported:
 * the import was, and an import handed an empty stream does not necessarily
 * fail. `mysql` and `mariadb` fed nothing exit 0, so those restores were
 * recorded as **successful while restoring nothing**, the same shape as the
 * volume restore emptying a volume it could not fetch a tarball for. `pipefail`
 * moves that verdict to the first thing that actually broke.
 *
 * `pipefail` only ever adds the statuses of the elements that are *not* last,
 * which here means `rclone cat` and `gunzip` — the import's own exit code
 * already decided the run and still does. The one new way to fail is therefore
 * an import that stops reading before its input ends, which would send EPIPE
 * back up the pipe; none of the five do (`pg_restore`, `mysql`, `mariadb` and
 * `tar xzf -` all read to end of stream, and mongo is not piped at all), and a
 * `|| true` to paper over it would put the bug straight back.
 *
 * The one place that reasoning has a real edge is the container search, which is
 * itself a pipeline — `docker ps -q --filter … | head -n 1` — and `head` does
 * stop reading early. Under `pipefail` a producer still writing when `head`
 * leaves takes SIGPIPE and fails the substitution: measured, `seq 1 2000000 |
 * head -n 1` exits 141. What keeps this safe is the filter, which narrows the
 * listing to one service's containers, so `docker ps` is finished before `head`
 * is — measured at exit 0 — and the backup script has run this same prelude
 * under `pipefail` from the start. Widening that filter, or dropping the
 * `head -n 1`, is what would break it.
 *
 * The mongo branch is newline-separated statements with an `EXIT` trap rather
 * than an `&&` chain, and that is the second bug written into this function.
 * The chain ended in `rm -rf`, and POSIX exempts every command of an
 * AND-OR list except the last from `set -e`, so a `mongorestore` that exited
 * non-zero stopped the chain *before* the cleanup and left the entire
 * decompressed archive on the host — a multi-GB residual per failed restore,
 * a known class of leak. `pipefail` cannot see it either, for the same reason:
 * the failing link is not the last one. An `EXIT` trap runs on every path,
 * success and failure alike, which is why appending another `&&` was rejected —
 * it would have been the same bug one link further along.
 *
 * The directory is per-run, `mktemp -d`, and that is not incidental to the trap
 * — it is what makes the trap safe. The old path was the fixed
 * `/tmp/cloudgate-restore`, shared by every mongo restore on the host, and the
 * chain opened by `rm -rf`-ing it, so two concurrent restores already destroyed
 * each other. A trap on that shared path would have added a second way: a
 * failing run would delete a *healthy* concurrent run's archive on its way out,
 * which is exactly the shape once written up for `rm -rf {volumeBackupPath}/*.tar`.
 * Scoping the trap to this run's own files inside the shared directory was the
 * alternative, and it was rejected as strictly weaker — it leaves the opening
 * `rm -rf` of a shared path in place, and it cannot clean up a `mktemp`-free
 * directory nobody owns. A per-run directory removes the leading `rm -rf` and
 * the `mkdir -p` as well, since what `mktemp` just created is empty by
 * construction, and nothing outlives its own run. There is still no restore
 * lock for databases — nothing here is the equivalent of `withVolumeLock` — so
 * concurrent mongo restores are made non-destructive by this, not serialized.
 *
 * The trap must not call `exit`. Bash carries the script's own status out
 * through an `EXIT` trap, and that status is what `execRclone` reports and what
 * `backups.service.ts` turns into the caller's refusal; an `exit` in the trap
 * would overwrite the engine's verdict with the `rm`'s. Removing
 * `"$RESTORE_DIR"` while the shell is `cd`'d into it is fine — it is an
 * absolute path, where `rm -rf .` would be refused — so the trap needs no
 * `cd /`. And the trap is armed *after* `mktemp`, so `$RESTORE_DIR` always
 * names something real by the time it can fire. */
export const buildRestoreScript = ({
  containerSearch,
  restoreCommand,
  rcloneCommand,
  reachabilityProbe,
  databaseType,
  backupFile,
}: RestoreScriptOptions): string => {
  // The probe's own output is discarded and only its status is read: it
  // is asking whether the endpoint answers, not what is in the bucket, and on
  // the piped branch its JSON would otherwise be the first thing the engine's
  // import ever saw. A key that is simply absent exits 0 here and stays what it
  // was — the engine's refusal to report, which `pipefail` is what carries out.
  //
  // A failing probe ends both branches, by two different mechanisms, and the
  // difference is worth knowing because `set -e` is not what does it on the
  // piped one. There the whole script is a single AND-OR list, and POSIX exempts
  // every element of one except the last from `set -e` — but `&&` short-circuits
  // regardless, so the download and the import never run and the list's status
  // *is* the probe's. On mongo's branch the probe is the last element of the
  // list and statements follow it, so `set -e` is what stops it, before
  // `mktemp`. Either way stdout has narrated nothing and rclone's own line is on
  // stderr, which is what `rcloneFailureMessage` answers the caller with.
  const prelude = `set -eo pipefail; CONTAINER_ID=$(${containerSearch}) && ${reachabilityProbe} > /dev/null`;
  if (databaseType !== 'mongo') {
    return `${prelude} && ${rcloneCommand} | ${restoreCommand}`;
  }

  const fileName = backupFile?.split('/').pop() || 'backup.sql.gz';
  const decompressedName = fileName.replace('.gz', '');
  // Both names are `quote()`d (H-36). They are the last segment of
  // `restoreBackupSchema`'s `backupFile`, which is `z.string().min(1)` — no
  // charset anywhere on the way here — and a `"…"` never stopped a `$(…)`. The
  // `"$RESTORE_DIR"` words around them are the shell's own variable and stay as
  // they are: expanding a variable inside double quotes does not re-scan the
  // value for substitutions.
  return `${prelude}
RESTORE_DIR=$(mktemp -d "${RESTORE_TEMP_DIR_TEMPLATE}")
trap 'rm -rf "$RESTORE_DIR"' EXIT
${rcloneCommand} "$RESTORE_DIR"
cd "$RESTORE_DIR"
gunzip -f ${quote([fileName])}
${restoreCommand} < ${quote([decompressedName])}`;
};
