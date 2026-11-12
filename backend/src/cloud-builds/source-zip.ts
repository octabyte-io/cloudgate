import { lstat, open, readdir, readFile, readlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * The source zip of a hosted cloud build (ADR-0047): the checkout the
 * platform host made, as the cloud's build service reads its source, beside
 * the few files Cloudgate's own build program needs. Written here, in this
 * process, rather than with a `zip` the platform host may not have, as
 * `applications/drop-archive.ts` reads one without an unzip dependency.
 *
 * - **No `.git`, at any depth.** A clone keeps its remote's URL in
 *   `.git/config`, and a git provider's token is in that URL
 *   (`oauth2:<token>@…`), so the folder never leaves Cloudgate: git tokens
 *   stay on the platform host (ADR-0047). A build reads the tree, not its
 *   history.
 * - **What a checkout holds, as it holds it**: each file's mode (a
 *   `gradlew`'s exec bit), each symlink as a symlink, each folder, empty ones
 *   too. Entries are sorted and dated 1980-01-01, so one tree zips alike.
 * - **Deflated, CRC-32 by `zlib`**, with zip64's end records once the tree
 *   holds more than 65,535 entries. A tree whose zip would pass 4 GB, or a
 *   file of 4 GB or more, is refused, naming the limit.
 */

/** A file Cloudgate adds to the zip beside the tree. */
export interface SourceZipFile {
  /** Its path in the zip, slash-separated. */
  readonly path: string;
  readonly content: string | Buffer;
  /** Its unix mode bits; `0o644` unless given. */
  readonly mode?: number;
}

export interface SourceZipInput {
  /**
   * The checkout, written under {@link under}; none for the build that
   * copies a ready-made image, whose zip is its program alone.
   */
  readonly tree?: { readonly path: string; readonly under: string };
  readonly files?: readonly SourceZipFile[];
}

/** What went in: entries (files, links and folders) and the zip's size. */
export interface SourceZipWritten {
  readonly entries: number;
  readonly bytes: number;
}

/** The one name that never goes into a source zip. */
const NEVER_ZIPPED = '.git';

const LIMIT = 0xffffffff;
const ZIP64_COUNT = 0xffff;
/** Made by unix (3), version 2.0; zip64 needs 4.5 to extract. */
const MADE_BY = (3 << 8) | 45;
const VERSION_NEEDED = 20;
const VERSION_NEEDED_ZIP64 = 45;
/** 1980-01-01 00:00, DOS date and time. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const DOS_TIME = 0;
const UTF8_NAMES = 0x0800;

const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

interface Entry {
  readonly name: string;
  readonly kind: 'file' | 'dir' | 'link';
  readonly mode: number;
  /** Where to read it: a file on disk, or the bytes themselves. */
  readonly from: string | Buffer | null;
}

interface Written {
  readonly name: Buffer;
  readonly crc: number;
  readonly compressed: number;
  readonly size: number;
  readonly method: number;
  readonly external: number;
  readonly offset: number;
}

/** Writes the zip to `file`, replacing it. */
export async function writeSourceZip(
  file: string,
  input: SourceZipInput,
): Promise<SourceZipWritten> {
  const entries = [
    ...(input.tree ? await treeEntries(input.tree.path, input.tree.under) : []),
    ...(input.files ?? []).map((one): Entry => ({
      name: one.path,
      kind: 'file',
      mode: one.mode ?? 0o644,
      from: Buffer.isBuffer(one.content)
        ? one.content
        : Buffer.from(one.content, 'utf8'),
    })),
  ];
  const handle = await open(file, 'w', 0o600);
  try {
    let offset = 0;
    // Written a megabyte at a time: a tree of small files is many entries.
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    const flush = async () => {
      if (pendingBytes === 0) return;
      await writeAll(handle, Buffer.concat(pending));
      pending = [];
      pendingBytes = 0;
    };
    const write = async (buffer: Buffer) => {
      if (offset + buffer.length > LIMIT) {
        throw new Error(
          'The source is too big to build in the cloud: its zip would pass 4 GB',
        );
      }
      pending.push(buffer);
      pendingBytes += buffer.length;
      offset += buffer.length;
      if (pendingBytes >= 1024 * 1024) await flush();
    };
    const written: Written[] = [];
    for (const entry of entries) {
      written.push(await writeEntry(entry, offset, write));
    }
    const directoryOffset = offset;
    for (const one of written) await write(centralHeader(one));
    const directorySize = offset - directoryOffset;
    const end: Buffer[] = [];
    if (written.length >= ZIP64_COUNT) {
      end.push(
        zip64End(written.length, directorySize, directoryOffset),
        zip64Locator(offset),
      );
    }
    end.push(endOfDirectory(written.length, directorySize, directoryOffset));
    // The end records are past the 4 GB check by design: they are small.
    const tail = Buffer.concat(end);
    pending.push(tail);
    pendingBytes += tail.length;
    offset += tail.length;
    await flush();
    return { entries: written.length, bytes: offset };
  } finally {
    await handle.close();
  }
}

async function writeAll(handle: FileHandle, buffer: Buffer): Promise<void> {
  let at = 0;
  while (at < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, at);
    at += bytesWritten;
  }
}

/** Every folder, file and link under `root`, but `.git`, sorted, under `under`. */
async function treeEntries(root: string, under: string): Promise<Entry[]> {
  const entries: Entry[] = [
    { name: under, kind: 'dir', mode: 0o755, from: null },
  ];
  const walk = async (directory: string, prefix: string) => {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      if (name === NEVER_ZIPPED) continue;
      const full = path.join(directory, name);
      const stat = await lstat(full);
      const mode = stat.mode & 0o7777;
      if (stat.isSymbolicLink()) {
        entries.push({
          name: `${prefix}${name}`,
          kind: 'link',
          mode: 0o777,
          from: Buffer.from(await readlink(full), 'utf8'),
        });
      } else if (stat.isDirectory()) {
        entries.push({
          name: `${prefix}${name}/`,
          kind: 'dir',
          mode,
          from: null,
        });
        await walk(full, `${prefix}${name}/`);
      } else if (stat.isFile()) {
        if (stat.size >= LIMIT) {
          throw new Error(
            `The source is too big to build in the cloud: ${prefix.slice(under.length)}${name} is 4 GB or more`,
          );
        }
        entries.push({
          name: `${prefix}${name}`,
          kind: 'file',
          mode,
          from: full,
        });
      }
      // A socket or a device in a checkout is no source; it is left out.
    }
  };
  await walk(root, under);
  return entries;
}

async function writeEntry(
  entry: Entry,
  offset: number,
  write: (buffer: Buffer) => Promise<void>,
): Promise<Written> {
  const data =
    entry.from === null
      ? Buffer.alloc(0)
      : Buffer.isBuffer(entry.from)
        ? entry.from
        : await readFile(entry.from);
  // A folder and a link are stored; a file deflated unless that grows it.
  const deflated = entry.kind === 'file' ? zlib.deflateRawSync(data) : null;
  const stored = deflated === null || deflated.length >= data.length;
  const body = stored ? data : deflated;
  const name = Buffer.from(entry.name, 'utf8');
  const typeBits =
    entry.kind === 'dir' ? S_IFDIR : entry.kind === 'link' ? S_IFLNK : S_IFREG;
  const one: Written = {
    name,
    crc: zlib.crc32(data),
    compressed: body.length,
    size: data.length,
    method: stored ? 0 : 8,
    // Unix mode in the high half; MS-DOS's directory bit for a folder.
    external:
      (((typeBits | entry.mode) << 16) >>> 0) +
      (entry.kind === 'dir' ? 0x10 : 0),
    offset,
  };
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(VERSION_NEEDED, 4);
  header.writeUInt16LE(UTF8_NAMES, 6);
  header.writeUInt16LE(one.method, 8);
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(one.crc, 14);
  header.writeUInt32LE(one.compressed, 18);
  header.writeUInt32LE(one.size, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  await write(Buffer.concat([header, name, body]));
  return one;
}

function centralHeader(one: Written): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(MADE_BY, 4);
  header.writeUInt16LE(VERSION_NEEDED, 6);
  header.writeUInt16LE(UTF8_NAMES, 8);
  header.writeUInt16LE(one.method, 10);
  header.writeUInt16LE(DOS_TIME, 12);
  header.writeUInt16LE(DOS_DATE, 14);
  header.writeUInt32LE(one.crc, 16);
  header.writeUInt32LE(one.compressed, 20);
  header.writeUInt32LE(one.size, 24);
  header.writeUInt16LE(one.name.length, 28);
  header.writeUInt16LE(0, 30); // extra
  header.writeUInt16LE(0, 32); // comment
  header.writeUInt16LE(0, 34); // disk
  header.writeUInt16LE(0, 36); // internal attributes
  header.writeUInt32LE(one.external, 38);
  header.writeUInt32LE(one.offset, 42);
  return Buffer.concat([header, one.name]);
}

function endOfDirectory(count: number, size: number, offset: number): Buffer {
  const end = Buffer.alloc(22);
  const entries = Math.min(count, ZIP64_COUNT);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries, 8);
  end.writeUInt16LE(entries, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return end;
}

function zip64End(count: number, size: number, offset: number): Buffer {
  const end = Buffer.alloc(56);
  end.writeUInt32LE(0x06064b50, 0);
  end.writeBigUInt64LE(44n, 4);
  end.writeUInt16LE(MADE_BY, 12);
  end.writeUInt16LE(VERSION_NEEDED_ZIP64, 14);
  end.writeUInt32LE(0, 16);
  end.writeUInt32LE(0, 20);
  end.writeBigUInt64LE(BigInt(count), 24);
  end.writeBigUInt64LE(BigInt(count), 32);
  end.writeBigUInt64LE(BigInt(size), 40);
  end.writeBigUInt64LE(BigInt(offset), 48);
  return end;
}

function zip64Locator(zip64EndOffset: number): Buffer {
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeUInt32LE(0, 4);
  locator.writeBigUInt64LE(BigInt(zip64EndOffset), 8);
  locator.writeUInt32LE(1, 16);
  return locator;
}
