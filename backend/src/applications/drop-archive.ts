import path from 'node:path';
import zlib from 'node:zlib';
import { BadRequestException } from '@nestjs/common';
import { quote } from 'shell-quote';
import { ownerOnlyDirectoryCommand } from '../common/files/owner-only';
import { buildHostServerId } from '../deployment-engine/build-host';
import { applicationsDirectoryOn } from '../deployment-engine/deployment-engine.paths';
import { execOnServer } from '../remote/exec-dispatch';
import type {
  ExecResult,
  RemoteExecService,
} from '../remote/remote-exec.service';

/**
 * Reading the zip a `drop` application is uploaded as, and turning it into the
 * shell command that materializes it on the build server. The archive is
 * attacker-supplied: every entry name is validated before it can reach a path,
 * so a "zip slip" entry (`../`, an absolute path, a Windows separator) is
 * refused rather than written outside the code directory.
 *
 * The reader is deliberately small — stored and deflated entries, which is
 * everything a browser or a `zip`/`Compress-Item` invocation produces — so
 * that no unzip dependency has to be added for one route.
 */

/** One archive member: a file with its payload, or a bare directory. */
export interface DropArchiveEntry {
  /** Slash-separated path relative to the code directory; never escapes it. */
  path: string;
  /** The file's bytes, or null for a directory entry. */
  content: Buffer | null;
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
/** A zip comment is a uint16 length, so the record starts within 64K + 22. */
const MAX_END_OF_CENTRAL_DIRECTORY_SEARCH =
  0xffff + END_OF_CENTRAL_DIRECTORY_SIZE;

const STORED = 0;
const DEFLATED = 8;

const ENCRYPTED_FLAG = 0x0001;
/** A zip64 record parks 0xffffffff in the 32-bit field it replaces. */
const ZIP64_SENTINEL = 0xffffffff;

/**
 * The archive's entries, in central-directory order. Throws
 * BadRequestException for anything unreadable or unsafe — an upload is user
 * input, so a malformed archive is a 400 and not a 500.
 */
export function readDropArchive(zip: Buffer): DropArchiveEntry[] {
  const centralDirectory = locateCentralDirectory(zip);
  const entries: DropArchiveEntry[] = [];

  let cursor = centralDirectory.offset;
  for (let index = 0; index < centralDirectory.entryCount; index += 1) {
    if (cursor + 46 > zip.length) {
      throw new BadRequestException(
        'The uploaded file is not a valid zip archive',
      );
    }
    if (zip.readUInt32LE(cursor) !== CENTRAL_FILE_HEADER) {
      throw new BadRequestException(
        'The uploaded file is not a valid zip archive',
      );
    }

    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const uncompressedSize = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString('utf-8');

    if ((flags & ENCRYPTED_FLAG) !== 0) {
      throw new BadRequestException('Encrypted zip archives are not supported');
    }
    if (
      compressedSize === ZIP64_SENTINEL ||
      uncompressedSize === ZIP64_SENTINEL ||
      localOffset === ZIP64_SENTINEL
    ) {
      throw new BadRequestException('Zip64 archives are not supported');
    }

    const entryPath = safeEntryPath(name, 'Zip entry');
    entries.push(
      name.endsWith('/')
        ? { path: entryPath, content: null }
        : {
            path: entryPath,
            content: inflateEntry(zip, localOffset, method, compressedSize),
          },
    );

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * The build-server command that materializes a drop: clear whatever the
 * previous drop left (an upload replaces, it never merges), then recreate the
 * tree. Payloads travel base64-encoded, the same way file mounts are written.
 */
export function dropArchiveCommand(
  destination: string,
  entries: DropArchiveEntry[],
): string {
  return [
    `rm -rf ${quote([destination])};`,
    `mkdir -p ${quote([destination])};`,
    ...entryWriteLines(destination, entries),
  ].join('\n');
}

/**
 * The lines that create `entries` under `destination`, an existing directory:
 * the directories first, then each file's bytes, base64 the way file mounts
 * are written. Shared by the full upload and the upload of only the changed
 * files, which writes into a copy of the current tree instead of an empty one.
 */
export function entryWriteLines(
  destination: string,
  entries: DropArchiveEntry[],
): string[] {
  const lines: string[] = [];
  const directories = new Set<string>();
  for (const entry of entries) {
    const full = path.posix.join(destination, entry.path);
    directories.add(entry.content === null ? full : path.posix.dirname(full));
  }
  for (const directory of [...directories].sort()) {
    if (directory !== destination)
      lines.push(`mkdir -p ${quote([directory])};`);
  }

  for (const entry of entries) {
    if (entry.content === null) continue;
    const full = path.posix.join(destination, entry.path);
    lines.push(
      `echo "${entry.content.toString('base64')}" | base64 -d > ${quote([full])};`,
    );
  }
  return lines;
}

/**
 * Where an upload lands: `{applicationsDirectoryOn(buildHostServerId)}/{appName}/code`,
 * byte for byte what `DeploymentEngineService` clones into and the build reads.
 *
 * The build host's own root, not this process's. `applicationsDirectory()`
 * resolved `CLOUDGATE_DIRECTORY` for every machine alike, so on an install
 * that sets it the upload unpacked the archive under a root the builder had
 * never heard of — and `codeDirectory` in `DeploymentEngineService`, which is
 * the other writer of this very path, had the same defect, which is why the
 * two moved together.
 */
export function dropCodeDirectory(application: {
  appName: string;
  serverId?: string | null;
  buildServerId?: string | null;
}): string {
  return path.posix.join(
    applicationsDirectoryOn(buildHostServerId(application)),
    application.appName,
    'code',
  );
}

/**
 * Writes an uploaded tree to `codeDirectory` on the build host
 * (`serverId`, `null` for the platform host), replacing whatever was there.
 * A tree of several MB lands whole. File modes and symlinks are not
 * kept: every file is written with the build host's umask.
 *
 * The Service directory is closed before the archive lands in it, as a
 * deploy's first step closes it: an uploaded tree can carry a `.env`, and the
 * upload runs before any deploy has. See `common/files/owner-only.ts`.
 */
export function materializeDrop(
  remoteExec: RemoteExecService,
  serverId: string | null | undefined,
  codeDirectory: string,
  entries: DropArchiveEntry[],
): Promise<ExecResult> {
  const command = `${ownerOnlyDirectoryCommand(path.posix.dirname(codeDirectory))};\n${dropArchiveCommand(codeDirectory, entries)}`;
  // On stdin, not as the shell's argument: every file's base64 is in
  // this one program, and Linux refuses a single argument over 128 KiB
  // (MAX_ARG_STRLEN) — on the platform host as `/bin/sh -c`, on a Server as
  // the `-c` sshd hands the login shell — so an upload past about 96 KiB of
  // content never started. Nothing in the program reads stdin: every
  // `base64 -d` reads its own `echo`'s pipe.
  return execOnServer(remoteExec, serverId, command, { programOnStdin: true });
}

/** The central directory's offset and entry count, off the trailing EOCD. */
function locateCentralDirectory(zip: Buffer): {
  offset: number;
  entryCount: number;
} {
  const from = Math.max(0, zip.length - MAX_END_OF_CENTRAL_DIRECTORY_SEARCH);
  for (
    let at = zip.length - END_OF_CENTRAL_DIRECTORY_SIZE;
    at >= from;
    at -= 1
  ) {
    if (zip.readUInt32LE(at) !== END_OF_CENTRAL_DIRECTORY) continue;

    const entryCount = zip.readUInt16LE(at + 10);
    const offset = zip.readUInt32LE(at + 16);
    if (entryCount === 0xffff || offset === ZIP64_SENTINEL) {
      throw new BadRequestException('Zip64 archives are not supported');
    }
    if (offset > zip.length) {
      throw new BadRequestException(
        'The uploaded file is not a valid zip archive',
      );
    }
    return { offset, entryCount };
  }
  throw new BadRequestException('The uploaded file is not a valid zip archive');
}

/** An entry's bytes, read through its local header (whose name/extra lengths
 * are the ones that locate the payload). */
function inflateEntry(
  zip: Buffer,
  localOffset: number,
  method: number,
  compressedSize: number,
): Buffer {
  if (
    localOffset + 30 > zip.length ||
    zip.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER
  ) {
    throw new BadRequestException(
      'The uploaded file is not a valid zip archive',
    );
  }

  const nameLength = zip.readUInt16LE(localOffset + 26);
  const extraLength = zip.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const end = start + compressedSize;
  if (end > zip.length) {
    throw new BadRequestException(
      'The uploaded file is not a valid zip archive',
    );
  }

  const payload = zip.subarray(start, end);
  if (method === STORED) return Buffer.from(payload);
  if (method !== DEFLATED) {
    throw new BadRequestException(
      `Zip compression method ${method} is not supported`,
    );
  }
  try {
    return zlib.inflateRawSync(payload);
  } catch {
    throw new BadRequestException('The uploaded zip archive is corrupt');
  }
}

/**
 * The entry name as a path that cannot leave the code directory. Every form of
 * zip slip is refused outright rather than sanitized away: silently rewriting
 * an escaping name would extract an archive that is not the one uploaded.
 *
 * `what` names the name in the refusal: a zip entry, or a path in the file
 * list an upload of only the changed files is compared and applied by, which
 * is held to the same rules.
 */
export function safeEntryPath(name: string, what: string): string {
  const rejected = (reason: string): never => {
    throw new BadRequestException(
      `${what} "${name}" ${reason} and would escape the application directory`,
    );
  };

  const trimmed = name.replace(/\/+$/, '');
  if (trimmed.length === 0) rejected('has an empty path');
  if (trimmed.includes('\0')) rejected('contains a null byte');
  // PKZIP mandates '/' as the separator, so a backslash is either an escape
  // attempt on Windows or a filename no build can rely on.
  if (trimmed.includes('\\')) rejected('contains a backslash');
  if (trimmed.startsWith('/')) rejected('is an absolute path');
  if (/^[A-Za-z]:/.test(trimmed)) rejected('names a drive');

  const segments = trimmed.split('/').filter((segment) => segment !== '.');
  if (segments.some((segment) => segment === '..')) {
    rejected('climbs out of the archive root');
  }
  if (segments.length === 0) rejected('has an empty path');

  const resolved = segments.join('/');
  // Belt and braces: whatever the rules above missed, joining must still land
  // under the destination.
  if (path.posix.normalize(`/${resolved}`) !== `/${resolved}`) {
    rejected('does not resolve to a path inside the archive root');
  }
  return resolved;
}
