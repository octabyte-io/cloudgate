import { quote } from 'shell-quote';
import { volumeBackupLockPathOn } from './deployment-engine.paths';

/**
 * The lock that serializes the operations that mutate one Docker volume.
 *
 * It lives here, as one builder, rather than beside any of its call sites,
 * because there are four: the volume backup, the volume restore, a compose
 * stack's Remove containers and an Application Delete's
 * `?deleteVolumes=true` (`applications/application-volumes.ts`). The preamble used to be written inline in the
 * turn-off backup script, its only user then; copying it twice more is how a
 * lock ends up with three keying rules.
 *
 * **Keyed by volume, not by service.** A service key (`appName`, or
 * `${appName}_${serviceName}` for a compose service) is the wrong identity for
 * the resource being contended: two volume-backup rows can name one volume
 * under different services, and one volume can be mounted by two compose
 * services, and under a service key those cases do not serialize. The
 * deliberate cost is the mirror image: two turn-off backups of *different*
 * services that share a volume wait for each other, where a service key would
 * let them run together.
 */

/**
 * How a caller that finds the lock held behaves — decided by how the caller was
 * invoked, not by what it is.
 *
 * A scheduled backup has nobody waiting on an HTTP response, so it blocks and
 * runs when the volume is free. Every synchronous caller — a restore, Remove
 * containers, a manually triggered backup run — fails fast, because the
 * alternative is an HTTP request held open for however long a tar of somebody's
 * volume takes. The two backup paths share one run core, so the mode travels as
 * an explicit parameter; it cannot be inferred inside the script builder.
 */
export type VolumeLockMode = 'wait' | 'fail-fast';

/**
 * The exit status a fail-fast acquisition exits with when the lock is held.
 *
 * It has to be distinguishable from ordinary script failure at the exit-code
 * level, because the services answer it with **409 Conflict** and everything
 * else with a 500 or a 400. 75 is `EX_TEMPFAIL` from `sysexits.h` — "try again
 * later", which is exactly the claim — and is outside both the 1–2 range shells
 * and coreutils use for their own errors and the 126–128+N range reserved for
 * "not executable" and signals. `1` was rejected for the obvious reason: every
 * `set -e` abort in these scripts already exits 1.
 */
export const VOLUME_LOCK_BUSY_EXIT_CODE = 75;

/**
 * The line a fail-fast acquisition prints before exiting, carrying the volume
 * name so a caller holding several locks can say *which* one was busy.
 *
 * The name rather than the lock path: the path is an implementation detail of
 * this file, and the name is what the 409's message has to contain.
 */
export const VOLUME_LOCK_BUSY_MARKER = 'Volume lock busy: ';

/**
 * The lock file for one volume, on the machine that holds the volume.
 *
 * **One expression, and that is what makes it a lock**. The path was
 * `volumeBackupLockPath()` — `localCloudgateDirectory()` — for every machine
 * alike, while every script carrying it is dispatched to a Server. Before
 * converting it the question worth asking was whether the three takers already
 * disagreed, because a lock two callers spell differently is not a lock and
 * that would be a hole in the lock's serialization rather than a wrong root. They
 * did not: all three reach the path through this function and nothing else in
 * the product spells it, and all three scripts go to the same machine — a
 * backup and a restore to `ServiceParent.serverId`, Remove containers to
 * `compose.serverId`, which for the rows that can contend over one volume are
 * the same column of the same row. So the lock held as written, and this is a root
 * fix.
 *
 * **What the wrong root did cost.** Unlike the staging tree beside it, nothing
 * creates this file's parent: `exec 9>"$LOCK_PATH"` fails outright on a Server
 * where the local root does not exist, and the `mkdir` fallback below reads the
 * same missing directory as the *busy* branch — so a host without `flock`
 * answered 409 "volume is busy" about a lock nobody held.
 */
export const volumeLockPathFor = (
  serverId: string | null,
  volumeName: string,
): string => `${volumeBackupLockPathOn(serverId)}-${volumeName}`;

export interface VolumeLockOptions {
  /** The machine the wrapped script will run on — the Server whose root the
   * lock files are under, `null` for the platform host (ADR-0008). A required
   * field rather than a defaulted one, for {@link volumeLockPathFor}'s reason:
   * the takers agree because there is one expression, and a default is a second
   * one that looks like the first. */
  serverId: string | null;
  /** The volumes to hold for the duration of the body. Deduplicated and
   * sorted, so two callers naming the same set acquire in the same order and
   * cannot deadlock against each other. */
  volumeNames: string[];
  mode: VolumeLockMode;
}

/**
 * Wraps a script body in an acquisition of every named volume's lock.
 *
 * An empty `volumeNames` returns the body untouched — Remove containers on a
 * project with no turn-off-enabled volume-backup rows has no lock to take, and
 * must keep behaving exactly as it did before this existed.
 *
 * More than one volume nests: each level acquires its lock and runs the next
 * inside a **subshell**, which is what lets every level reuse file descriptor 9.
 * Numbering the descriptors instead (`exec 10>`, `exec 11>`…) reads better and
 * is not portable — a multi-digit descriptor in a redirection is
 * implementation-defined in POSIX, and `execAsyncRemote` feeds these scripts to
 * `sh -s`. The subshell keeps its parent's descriptor open, so the outer lock is
 * held across the inner acquisition rather than released by it, and each level's
 * `mkdir`-fallback trap sees its own copy of `$LOCK_DIR`.
 */
export const withVolumeLock = (
  { serverId, volumeNames, mode }: VolumeLockOptions,
  body: string,
): string => {
  const names = [...new Set(volumeNames)].sort();
  if (names.length === 0) return body;

  let script = body;
  for (let index = names.length - 1; index >= 0; index -= 1) {
    const level = lockLevel(serverId, names[index], mode, script);
    // Every level but the outermost runs inside a lock its parent holds, so it
    // needs its own subshell to reuse descriptor 9.
    script = index === 0 ? level : `(\n${level}\n)\n`;
  }
  return script;
};

/**
 * One volume's acquisition, wrapping `body`.
 *
 * The body's exit status is captured and re-exited with, rather than letting the
 * closing `echo` become the script's status. Not defensive tidiness — without it
 * this wrapper *hides failures*, and `set -e` does not save it: POSIX exempts
 * every command of an AND-OR list except the last, so a body of the shape
 * `cd DIR && docker compose rm …` whose `cd` fails carries on to the release
 * `echo` and the script exits 0. `Remove containers` has exactly that shape, so
 * wrapping it turned "the project directory is gone" from a 500 into a 201 that
 * reported the containers removed. Unwrapped, the same body exits 1 because the
 * AND-OR list is the last thing in the script — which is why the bug only
 * appeared once there was something after it.
 */
const lockLevel = (
  serverId: string | null,
  volumeName: string,
  mode: VolumeLockMode,
  body: string,
): string => {
  const lockPath = volumeLockPathFor(serverId, volumeName);

  // `flock` is the real implementation; the `mkdir` fallback stays because a
  // stripped host may not have util-linux. The fallback has a fail-fast form
  // too: its wait form is a spinlock that loops forever by construction, which
  // is the one thing a synchronous caller must not do.
  const acquire =
    mode === 'wait'
      ? `		if command -v flock >/dev/null 2>&1; then
			exec 9>"$LOCK_PATH"
			flock 9
		else
			LOCK_DIR="$LOCK_PATH.dir"
			while ! mkdir "$LOCK_DIR" 2>/dev/null; do
				echo ${quote([`Waiting for volume lock: ${volumeName}`])}
				sleep 5
			done
			trap 'rm -rf "$LOCK_DIR"' EXIT
		fi`
      : `		if command -v flock >/dev/null 2>&1; then
			exec 9>"$LOCK_PATH"
			if ! flock -n 9; then
				echo ${quote([`${VOLUME_LOCK_BUSY_MARKER}${volumeName}`])}
				exit ${VOLUME_LOCK_BUSY_EXIT_CODE}
			fi
		else
			LOCK_DIR="$LOCK_PATH.dir"
			if ! mkdir "$LOCK_DIR" 2>/dev/null; then
				echo ${quote([`${VOLUME_LOCK_BUSY_MARKER}${volumeName}`])}
				exit ${VOLUME_LOCK_BUSY_EXIT_CODE}
			fi
			trap 'rm -rf "$LOCK_DIR"' EXIT
		fi`;

  // **The release `echo` and the `exit` below are the happy path's only.**
  // `set -e` is in force from the first line, so a body that aborts ends the
  // script at the failure rather than falling through — no restore or backup
  // that fails ever prints "Volume lock released". Nothing is leaked by that:
  // the `flock` fd closes with the shell and the `mkdir` fallback has its own
  // EXIT trap, so the lock is freed either way, and the status the caller reads
  // is the body's either way too. What is lost is one line of narration.
  //
  // Written down because it has been re-derived once from a failing assertion
  // (X10's fix loop, writing `toContain('Volume lock released')` into an
  // abort's test): a test on this path asserts the lock, not the echo. Moving
  // the echo above the body, or into a trap, is the fix if the narration is
  // ever wanted — and both are larger than they look, since a `trap … EXIT`
  // here would replace the fallback's own.
  return `
		set -e

		LOCK_PATH=${quote([lockPath])}

		echo ${quote([`Waiting for volume lock: ${volumeName}`])}

${acquire}

		echo ${quote([`Volume lock acquired: ${volumeName}`])}

		${body}
		VOLUME_LOCK_BODY_STATUS=$?

		echo ${quote([`Volume lock released: ${volumeName}`])}
		exit $VOLUME_LOCK_BODY_STATUS
	`;
};

/**
 * Whether a failed execution failed *because* a volume lock was held, rather
 * than for any of the reasons that deserve a 500.
 *
 * Read off the exit code and not the output: the volume-backup run redirects its
 * whole script into the run's log file (`… >> {logPath} 2>&1`), so there is no
 * stdout on the error to match against — only the status.
 */
export const isVolumeLockBusyError = (error: unknown): boolean =>
  (error as { exitCode?: number } | null | undefined)?.exitCode ===
  VOLUME_LOCK_BUSY_EXIT_CODE;

/**
 * The busy volume's name off a failed execution, for a caller that held several
 * locks and does not otherwise know which one refused. Null when the output did
 * not reach us — see `isVolumeLockBusyError`.
 */
export const busyVolumeNameFrom = (error: unknown): string | null => {
  const { stdout, stderr } =
    (error as { stdout?: string; stderr?: string } | null | undefined) ?? {};
  for (const output of [stdout, stderr]) {
    const index = output?.lastIndexOf(VOLUME_LOCK_BUSY_MARKER);
    if (output && index !== undefined && index >= 0) {
      const name = output
        .slice(index + VOLUME_LOCK_BUSY_MARKER.length)
        .split('\n')[0]
        .trim();
      if (name) return name;
    }
  }
  return null;
};

/** The 409's sentence, naming the volume that is busy. Sentence-case, no
 * trailing period, and it names the entity, per §2.5 — an operator reads it. */
export const volumeLockBusyMessage = (volumeName: string): string =>
  `Volume '${volumeName}' is busy: a volume backup, a restore or Remove containers holds its lock — try again once that finishes`;
