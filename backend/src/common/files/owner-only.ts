import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { quote } from 'shell-quote';

/**
 * The one statement of how Cloudgate writes something only the account that
 * wrote it may read.
 *
 * **Why this exists.** The backend runs as root and the console as the
 * unprivileged `cloudgate` user, and that split is the whole of what keeps a
 * console compromise from reading the platform's secrets. Every writer under
 * the platform tree used to take the process umask, so a custom certificate's
 * `privkey.key`, a file mount's content and every stack's and Application's
 * `.env` landed `0644` in `0755` directories — readable by `cloudgate` and by
 * every other local account, while the database copy of the same bytes was
 * `enc:v1:`. `acme.json` (Traefik's, `0600`) and the local SSH key
 * (`local-server-setup.service.ts`, `0700`) were the only two that were not.
 *
 * **Two shapes, because the reader decides which one a file can have.**
 *
 * - An **owner-only file** (`0600` in a `0700` directory) when the reader is
 *   root: Traefik, which runs as root in its container and reads the
 *   certificate files through its bind mount.
 * - An **owner-only directory** (`0700`) around a file whose own mode is left
 *   alone, when the reader is somebody else's process. A file mount is
 *   bind-mounted into a container that may run as any user — Dex runs as
 *   `1001`, and a `0600 root` config file is one it cannot open — and an
 *   Application's `.env` sits in the build context, where a `COPY . .` carries
 *   the file's mode into the image for whatever `USER` the image runs as. A
 *   bind mount is resolved by the daemon, as root, when the container starts,
 *   so the directories *above* the source are never checked from inside the
 *   container: `0700` on them shuts out every local account without touching
 *   what the workload can read. Rejected: `0600` on every producer, which is
 *   what the ticket first proposed and would have broken exactly the file
 *   mount the U14 run found carrying Dex's client secret.
 *
 * **Every function tightens what is already there, not only what it creates.**
 * `mode` on `mkdirSync`/`writeFileSync` and the shell's `umask` apply only at
 * creation, so a directory or a key an earlier version wrote at `0755`/`0644`
 * keeps that mode through any number of rewrites unless something `chmod`s it.
 * An existing file is tightened *before* the new bytes go in, so there is no
 * moment at which new secret content sits under the old mode.
 *
 * `test/coding-standards/platform-file-modes.spec.ts` is the census that holds
 * every writer under the platform tree to one of these, or to a written reason
 * it needs neither.
 */

/** A file only its owner reads: root, for every writer that uses it. */
export const OWNER_ONLY_FILE_MODE = 0o600;

/** A directory only its owner enters. */
export const OWNER_ONLY_DIRECTORY_MODE = 0o700;

/**
 * Creates `directory` (and any missing parents) and makes `directory` itself
 * `0700`, whatever mode it had. The parents keep theirs: the tree above is
 * `0755` on purpose, and one closed directory is enough to shut out a reader.
 */
export function makeOwnerOnlyDirectorySync(directory: string): void {
  fs.mkdirSync(directory, {
    recursive: true,
    mode: OWNER_ONLY_DIRECTORY_MODE,
  });
  fs.chmodSync(directory, OWNER_ONLY_DIRECTORY_MODE);
}

/**
 * Writes `data` to `file` as `0600` inside a `0700` directory, on this host.
 */
export function writeOwnerOnlyFileSync(
  file: string,
  data: string | NodeJS.ArrayBufferView,
): void {
  makeOwnerOnlyDirectorySync(path.dirname(file));
  // Before the write: an existing file keeps its mode through `writeFileSync`.
  if (fs.existsSync(file)) fs.chmodSync(file, OWNER_ONLY_FILE_MODE);
  fs.writeFileSync(file, data, { mode: OWNER_ONLY_FILE_MODE });
}

/**
 * The shell form of {@link makeOwnerOnlyDirectorySync}, for a program that
 * runs on a Server or through `execAsync`. No trailing `;` — the caller
 * sequences it.
 */
export function ownerOnlyDirectoryCommand(directory: string): string {
  const quoted = quote([directory]);
  return `mkdir -p ${quoted} && chmod 700 ${quoted}`;
}

/**
 * The shell form of {@link writeOwnerOnlyFileSync}: `content` written to `file`
 * as `0600` inside a `0700` directory.
 *
 * The file is `touch`ed and `chmod`ed before a byte of `content` reaches it, so
 * an existing file is tightened first and a new one is empty for as long as it
 * has the umask's mode — inside a directory already closed. Rejected: a
 * `(umask 077 && …)` subshell, which only covers a file the write creates, and
 * a bare `umask 077`, which would leak into the rest of the caller's program.
 * The write itself is still `echo "<base64>" | base64 -d > <path>`, the shape
 * every file write in the tree has, so `common/logging/error-payloads.ts` goes
 * on eliding the payload from a failed command's message. No trailing `;`.
 */
export function writeOwnerOnlyFileCommand(
  file: string,
  content: string,
): string {
  const quoted = quote([file]);
  const payload = Buffer.from(content, 'utf-8').toString('base64');
  return [
    ownerOnlyDirectoryCommand(path.dirname(file)),
    `touch ${quoted}`,
    `chmod 600 ${quoted}`,
    `echo "${payload}" | base64 -d > ${quoted}`,
  ].join(' && ');
}

/**
 * Writes `data` to `file` as `0600` **in a directory left as it is**, on the
 * platform host: written whole to a temporary sibling created `0600`, then renamed over
 * `file`.
 *
 * For a file whose directory cannot be closed: an AI model's gateway-only
 * router carries its upstream secret and has to sit at the top of Traefik's
 * `dynamic/` directory, the one level the file provider watches, and closing
 * `dynamic/` would change what every Application's routing file sits in to
 * settle one. {@link writeOwnerOnlyFileSync}'s order (tighten, then write)
 * leans on its closed directory for a new file's moment under the umask; here
 * there is no such moment, because the temporary file is created `0600` and
 * exclusively, and the rename puts that mode and the whole content in place at
 * once. The rename is also what keeps a watcher from reading half a file. The
 * sibling's name ends in a random suffix, not `.yml`, so Traefik never loads
 * it.
 */
export function replaceOwnerOnlyFileSync(
  file: string,
  data: string | NodeJS.ArrayBufferView,
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(6).toString('hex')}`;
  fs.writeFileSync(temporary, data, {
    mode: OWNER_ONLY_FILE_MODE,
    flag: 'wx',
  });
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * The shell form of {@link replaceOwnerOnlyFileSync}: `mktemp`, which creates
 * its file `0600` whatever the umask, then the `echo "<base64>" | base64 -d`
 * write every file write in the tree has, then `mv -f` over `file`. A failed
 * write removes the temporary file and fails the command. No trailing `;`.
 */
export function replaceOwnerOnlyFileCommand(
  file: string,
  content: string,
): string {
  const payload = Buffer.from(content, 'utf-8').toString('base64');
  return [
    `tmp=$(mktemp ${quote([`${file}.XXXXXX`])})`,
    `{ { echo "${payload}" | base64 -d > "$tmp" && mv -f "$tmp" ${quote([file])}; } || { rm -f "$tmp"; false; }; }`,
  ].join(' && ');
}
