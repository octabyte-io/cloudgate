import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { dropFileListSchema, UPLOAD_CONFLICT_CODE } from 'api-schemas';
import type { DropComparison, DropFile } from 'api-schemas';
import { quote } from 'shell-quote';

import { ownerOnlyDirectoryCommand } from '../common/files/owner-only';
import { execOnServer } from '../remote/exec-dispatch';
import type { RemoteExecService } from '../remote/remote-exec.service';
import { entryWriteLines, safeEntryPath } from './drop-archive';
import type { DropArchiveEntry } from './drop-archive';

/**
 * Uploading only the files that changed (spec #10): the build host's tree is
 * compared with the folder's file list, and the new tree is built beside the
 * current one and swapped in only once every file's fingerprint matches.
 *
 * **Compared against the files on the build host, never a saved list**
 * (ADR-0079). After a build the code directory can differ from what was
 * uploaded: a Patch overwrites files, the dockerfile build can write a `.env`,
 * and a git source clones into the same directory. So each comparison hashes
 * what is really there, and a file that differs is simply asked for again.
 *
 * **Both halves run on the build host, as the full upload does**
 * (`materializeDrop`, ADR-0018's `buildHostServerId`): the comparison reads the
 * tree the build will read, and the apply writes it there.
 */

/** The answer `sha256sum` gives for a path that is not a regular file. */
const NOT_A_FILE = '-';

/**
 * The exit the apply program takes when the tree it built does not match the
 * list. Any other failure is a failure part-way; both leave the previous tree
 * and answer the same conflict, and only the sentence differs.
 */
const MISMATCH_EXIT = 3;

/**
 * Reads the file list a `files` part carries: JSON, a {@link
 * dropFileListSchema}, each path held to the zip-slip rules a zip entry is and
 * written in its plain form, and no path twice. A list is user input, so
 * anything else is a 400.
 *
 * Parsed here rather than by the global pipe because it arrives as a file
 * part, which the pipe never sees: a big folder's list passes both the 100 kB
 * JSON body limit and multer's 1 MB field limit.
 */
export function readDropFileList(part: Buffer): DropFile[] {
  let json: unknown;
  try {
    json = JSON.parse(part.toString('utf-8'));
  } catch {
    throw new BadRequestException('The file list is not valid JSON');
  }
  const parsed = dropFileListSchema.safeParse(json);
  if (!parsed.success) {
    throw new BadRequestException({
      message: 'The file list is not a list of paths and SHA-256 fingerprints',
      details: parsed.error.issues,
    });
  }
  const seen = new Set<string>();
  for (const file of parsed.data) {
    // Refused rather than normalized: the paths compare answers are the ones
    // the CLI sent, and it looks its files up by them.
    if (safeEntryPath(file.path, 'File list path') !== file.path) {
      throw new BadRequestException(
        `File list path "${file.path}" is not written in its plain form`,
      );
    }
    if (seen.has(file.path)) {
      throw new BadRequestException(
        `File list path "${file.path}" is listed twice`,
      );
    }
    seen.add(file.path);
  }
  return parsed.data;
}

/**
 * The program that prints the tree under the current directory, one
 * NUL-ended `<sha256>  ./<path>` per regular file and `-  ./<path>` per
 * anything else that is not a directory (a symlink a git source checked out).
 * NUL-ended because a path may hold a newline, and `sha256sum -z` also turns
 * off its escaping of a backslash in a name.
 */
const TREE_LISTING =
  `find . ! -type d ! -type f -exec printf -- '${NOT_A_FILE}  %s\\000' {} + && ` +
  `find . -type f -exec sha256sum -z -- {} +`;

/** {@link TREE_LISTING}'s output, as {path: sha256 or `-`}. */
function parseTreeListing(stdout: string): Map<string, string> {
  const tree = new Map<string, string>();
  for (const line of stdout.split('\0')) {
    if (line.length === 0) continue;
    const match = /^([0-9a-f]{64}|-) [ *]\.\/([\s\S]+)$/.exec(line);
    if (!match) {
      throw new Error(`Unreadable line in the build host's file listing`);
    }
    tree.set(match[2], match[1]);
  }
  return tree;
}

/** The most bytes a tree's listing may answer: about 600,000 files. */
const LISTING_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * The files under `codeDirectory` on the build host (`serverId`, `null` for
 * the platform host) with the SHA-256 of each, as {path: sha256}. No tree yet
 * is an empty one.
 */
export async function readBuildHostTree(
  remoteExec: RemoteExecService,
  serverId: string | null | undefined,
  codeDirectory: string,
): Promise<Map<string, string>> {
  const code = quote([codeDirectory]);
  const { stdout } = await execOnServer(
    remoteExec,
    serverId,
    `if [ -d ${code} ]; then cd ${code} && ${TREE_LISTING}; fi`,
    { maxBuffer: LISTING_MAX_BUFFER },
  );
  return parseTreeListing(stdout);
}

/**
 * What the build host is missing of `files`, in the list's order, and how many
 * it holds already and holds beyond the list.
 */
export function compareDropFiles(
  files: DropFile[],
  tree: ReadonlyMap<string, string>,
): DropComparison {
  const missing = files
    .filter((file) => tree.get(file.path) !== file.sha256)
    .map((file) => file.path);
  const listed = new Set(files.map((file) => file.path));
  const deleted = [...tree.keys()].filter((p) => !listed.has(p)).length;
  return { missing, unchanged: files.length - missing.length, deleted };
}

/** NUL-ended records as one base64 word for an `echo … | base64 -d`. */
const nulRecords = (records: string[]) =>
  Buffer.from(
    records.map((record) => `${record}\0`).join(''),
    'utf-8',
  ).toString('base64');

/**
 * The build-host program that applies an upload of only the changed files to
 * `codeDirectory`.
 *
 * In a working directory beside the code directory (inside the Service
 * directory, closed first as the full upload closes it), it copies the current
 * tree, removes every path that is not a regular file in `files`, removes the
 * directories that leaves empty, writes `entries`, and lists the result. Only
 * when that listing is exactly `files` — every path, every fingerprint, nothing
 * more — does it swap the new tree in. Anything else exits non-zero, and the
 * `trap` takes the working directory away with the half-built tree in it, so
 * the code directory is never a half-updated mix.
 *
 * **The swap is two moves, and the trap guards the gap between them.** The
 * previous tree moves into the working directory, then the new one into its
 * place. A second move that fails, or a shell stopped by a signal between the
 * two, would otherwise leave no code directory and the trap's `rm -rf` taking
 * the previous tree with it. So the trap first moves the previous tree back
 * whenever the code directory is missing, and removes the working directory
 * only once the code directory is there again: if even that move back fails,
 * the previous tree stays in the working directory rather than being deleted.
 * Rejected: `mv --exchange` (one atomic `renameat2`), which needs coreutils
 * 9.5, newer than the distributions a Server runs.
 *
 * `set -e` makes every step a gate. A pipeline's earlier command can fail
 * unseen, and whatever it then left undone is a tree that does not match the
 * listing, which the comparison refuses. The working directory's name is
 * random so that two uploads at once never build in the same place.
 */
export function applyDropChangesCommand(
  codeDirectory: string,
  files: DropFile[],
  entries: DropArchiveEntry[],
): string {
  const serviceDirectory = path.posix.dirname(codeDirectory);
  const token = randomBytes(8).toString('hex');
  const work = path.posix.join(serviceDirectory, `.upload-${token}`);
  const tree = `${work}/tree`;
  const [q, w, t] = [quote([codeDirectory]), quote([work]), quote([tree])];
  const previous = `${work}/previous`;
  const p = quote([previous]);
  const plainPaths = files.map((file) => `./${file.path}`);
  const cleanUp = [
    `if [ -d ${p} ] && [ ! -e ${q} ]; then mv ${p} ${q}; fi`,
    `if [ -e ${q} ] || [ ! -d ${p} ]; then rm -rf ${w}; fi`,
  ].join('; ');
  return [
    'set -e',
    ownerOnlyDirectoryCommand(serviceDirectory),
    `trap ${quote([cleanUp])} EXIT`,
    // A signal leaves through `exit`, so the EXIT trap runs for it too.
    `trap 'exit 1' HUP INT TERM`,
    `mkdir ${w} ${t}`,
    `if [ -d ${q} ]; then cp -a ${q}/. ${t}/; fi`,
    `cd ${t}`,
    // Whatever is not a regular file in the list goes: a symlink, and every
    // file the folder no longer has.
    `find . ! -type d ! -type f -exec rm -f -- {} +`,
    `echo "${nulRecords(plainPaths)}" | base64 -d | LC_ALL=C sort -z > ${w}/wanted`,
    `find . -type f -print0 | LC_ALL=C sort -z > ${w}/present`,
    `LC_ALL=C comm -z -23 ${w}/present ${w}/wanted | xargs -0 -r rm -f --`,
    `find . -mindepth 1 -depth -type d -empty -delete`,
    ...entryWriteLines(tree, entries),
    `echo "${nulRecords(files.map((file) => `${file.sha256}  ./${file.path}`))}" | base64 -d | LC_ALL=C sort -z > ${w}/expected`,
    `{ ${TREE_LISTING}; } | LC_ALL=C sort -z > ${w}/actual`,
    `cmp -s ${w}/expected ${w}/actual || exit ${MISMATCH_EXIT}`,
    'cd /',
    `if [ -d ${q} ]; then mv ${q} ${p}; fi`,
    `mv ${t} ${q}`,
  ].join('\n');
}

/**
 * Applies an upload of only the changed files on the build host (`serverId`,
 * `null` for the platform host): `entries` are the zip's files, `files` the
 * whole folder. Answers once the new tree is in place; a mismatch or a
 * failure part-way is a 409 {@link UPLOAD_CONFLICT_CODE}, with the previous
 * tree as it was.
 */
export async function applyDropChanges(
  remoteExec: RemoteExecService,
  serverId: string | null | undefined,
  codeDirectory: string,
  files: DropFile[],
  entries: DropArchiveEntry[],
): Promise<void> {
  try {
    // On stdin for `materializeDrop`'s reason: the zip's files are in it.
    await execOnServer(
      remoteExec,
      serverId,
      applyDropChangesCommand(codeDirectory, files, entries),
      { programOnStdin: true },
    );
  } catch (error) {
    const mismatch =
      (error as { exitCode?: number } | null)?.exitCode === MISMATCH_EXIT;
    throw new ConflictException({
      code: UPLOAD_CONFLICT_CODE,
      message: mismatch
        ? 'The files on the build host changed since they were compared, so the upload was not applied; compare again and upload what it asks for'
        : 'The upload could not be applied on the build host, and its previous files are as they were; compare again and upload what it asks for',
    });
  }
}
