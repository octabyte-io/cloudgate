import * as path from 'node:path';
import { quote } from 'shell-quote';

/**
 * Where Traefik writes its access log under a Traefik root: the file
 * `accessLog.filePath` names, `dynamic/access.log`.
 *
 * One derivation for everything that touches the file — the platform host's
 * rotation, a Server's rotation and age cleanup, and the Requests page's read
 * of a Server's log (`ServerAccessLogService`) — so the reader can never be
 * pointed at a file the rotation does not keep bounded.
 */
export function accessLogPathUnder(traefikRoot: string): string {
  return path.join(traefikRoot, 'dynamic', 'access.log');
}

/**
 * The two shell programs a Server's access-log rotation sends over SSH.
 *
 * The platform host's rotation (`TraefikFilesService.rotateAccessLog`) does the
 * same steps with `fs`; a Server's log is only reachable as a program, so these
 * are the same rules worded for a remote shell. Programs rather than argv
 * because both need a branch (`if [ -e … ]`), and every path in them goes
 * through `quote()` at this builder (CODING_STANDARDS.md §2.9) — the path is
 * derived from the Server's Traefik root rather than a caller, but a builder
 * that quotes nothing is the shape that shipped a bug twice.
 */

/**
 * Prints the log's size in bytes, or `0` when there is no log.
 *
 * `0` rather than a failing read, so "the log is on in traefik.yml but
 * Traefik has not written a line yet" reads as a small log, not as an
 * unreachable Server. `wc -c <` rather than `stat -c %s`: `stat`'s flags differ
 * between GNU and BSD, and `wc -c` on a regular file is answered from its size
 * (coreutils seeks rather than reads), so a 100 MiB log is not read to be
 * measured.
 */
export function accessLogSizeCommand(logPath: string): string {
  const log = quote([logPath]);
  return `if [ -f ${log} ]; then wc -c < ${log}; else echo 0; fi`;
}

/**
 * Shifts the backups along, oldest first, and moves the live log to `.1`.
 *
 * Oldest first so nothing is overwritten before it has moved: `.N` is removed,
 * then `.N-1` → `.N` down to `.1` → `.2`, and the live log → `.1` last. `set -e`
 * so a failed shift stops before the live log is moved onto a backup that is
 * still there. The signal is not in this program — it is a separate exec, so
 * the rename is known to have happened before Traefik is told to reopen, and a
 * rename that worked with a signal that did not is reported as exactly that.
 */
export function accessLogShiftCommand(
  logPath: string,
  backups: number,
): string {
  const at = (n: number) => quote([`${logPath}.${n}`]);
  const lines = ['set -e', `rm -f ${at(backups)}`];
  for (let n = backups - 1; n >= 1; n -= 1) {
    lines.push(`if [ -e ${at(n)} ]; then mv -f ${at(n)} ${at(n + 1)}; fi`);
  }
  lines.push(`mv -f ${quote([logPath])} ${at(1)}`);
  return lines.join('\n');
}

/**
 * Deletes the older files (`.1` … `.backups`) whose last change is more than
 * `maxAgeMinutes` ago, printing each path it deleted, one a line.
 *
 * Only the numbered names, so the live log is never a candidate however quiet
 * it is (ADR-0057). Age is the file's mtime, which for a log is its newest
 * line. `find FILE -mmin +N` rather than date arithmetic in the shell: GNU,
 * BSD and BusyBox `find` all take `-mmin`, while `stat`'s and `date`'s flags
 * differ between them. Minutes rather than `-mtime +30`, which rounds the age
 * down to whole days and so keeps a file until it is 31 days old.
 */
export function accessLogAgedBackupsCommand(
  logPath: string,
  backups: number,
  maxAgeMinutes: number,
): string {
  const files: string[] = [];
  for (let n = 1; n <= backups; n += 1) files.push(`${logPath}.${n}`);
  return [
    `for f in ${quote(files)}; do`,
    `  if [ -f "$f" ] && [ -n "$(find "$f" -mmin +${maxAgeMinutes})" ]; then rm -f "$f" && echo "$f"; fi`,
    'done',
  ].join('\n');
}

/**
 * Reads a Server's traefik.yml, saying first whether there is one: the first
 * line is `present` (the file follows) or `absent` (nothing follows), and
 * {@link traefikConfigFromRead} takes it apart.
 *
 * A Server added and never set up has no traefik.yml, and the rotation passes
 * it over the way the platform host's read passes over a missing file, rather
 * than reporting it as a failure every cron run. A bare `cat` cannot say that:
 * it exits non-zero for a missing file just as the exec does for an
 * unreachable Server, and telling the two apart afterwards means reading an
 * error message. Here absence is an answer on stdout with a zero exit, so every
 * rejection left — no connection, a `cat` refused a file that is there — is a
 * real failure the caller logs by Server name.
 */
export function traefikConfigReadCommand(configPath: string): string {
  const file = quote([configPath]);
  return `if [ -f ${file} ]; then echo present; cat ${file}; else echo absent; fi`;
}

/**
 * {@link traefikConfigReadCommand}'s output as the file's contents, or null
 * when the Server has no traefik.yml. A first line that is neither answer is
 * not this program's output, and is thrown rather than read as either.
 */
export function traefikConfigFromRead(stdout: string): string | null {
  const newline = stdout.indexOf('\n');
  const marker = newline === -1 ? stdout : stdout.slice(0, newline);
  if (marker === 'absent') return null;
  if (marker === 'present') return stdout.slice(newline + 1);
  throw new Error(`Unexpected answer reading traefik.yml: ${marker}`);
}
