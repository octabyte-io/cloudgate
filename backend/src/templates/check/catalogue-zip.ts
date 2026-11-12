import { deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * The zip a **Template catalogue** is published as (ADR-0072), read and
 * written in memory with nothing but `node:zlib`.
 *
 * Written here rather than taken from a zip library, because what a library
 * does by default is what ADR-0072 refuses: extract to disk, follow a
 * symlink, trust the sizes a header declares, or accept ZIP64, encryption and
 * every compression method. The reader below takes only the small part of
 * the format a catalogue needs, and refuses the rest by name. It is also
 * bundled into the CLI (`cli/build.mjs`), where one more dependency would be
 * one more thing every `npx` install downloads.
 */

/** A file read out of a zip: its path and its unpacked bytes. */
export interface ZipFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface ZipLimits {
  /** At most this many entries, directories included. */
  readonly maxEntries: number;
  /** At most this many bytes unpacked, all files together. */
  readonly maxTotalBytes: number;
  /**
   * The cap on one file at `path`, in bytes, or a reason the zip may not
   * hold that path at all. Asked of every entry before anything is
   * unpacked, so a refused path costs no inflating; asked of a folder too
   * (its path ends in `/`), whose cap is unused.
   */
  readonly fileCap: (path: string) => number | { readonly refused: string };
}

export type ZipRead =
  | { readonly ok: true; readonly files: readonly ZipFile[] }
  | { readonly ok: false; readonly reason: string };

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;

const STORED = 0;
const DEFLATE = 8;

const ENCRYPTED = 0x0001;
const STRONG_ENCRYPTION = 0x0040;
const UTF8_NAMES = 0x0800;

const UNIX = 3;
const FILE_TYPE = 0o170000;
const REGULAR = 0o100000;
const DIRECTORY = 0o040000;
const SYMLINK = 0o120000;

/** The end record is 22 bytes, then a comment of at most 65,535. */
const END_MIN = 22;
const END_SEARCH = END_MIN + 0xffff;

/**
 * The files in `bytes`, each unpacked within its cap, or the first reason
 * the zip is refused as a whole.
 *
 * Every size is counted while unpacking and checked against what the zip
 * declared, never taken from it: inflating stops where a file passes its
 * cap or the total passes `maxTotalBytes`, so a small zip that unpacks to
 * gigabytes is stopped there. Entries are read through the central directory
 * and each must match its local header, so a name hidden in only one of the
 * two cannot slip past. Directory entries are checked like files and then
 * dropped: only files are returned.
 */
export function readZip(bytes: Uint8Array, limits: ZipLimits): ZipRead {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const refuse = (reason: string): ZipRead => ({ ok: false, reason });

  const end = findEnd(data);
  if (end < 0) return refuse('is not a zip file');
  if (end >= 20 && data.readUInt32LE(end - 20) === ZIP64_LOCATOR) {
    return refuse('is a ZIP64 file; a catalogue is a plain zip');
  }
  if (data.readUInt16LE(end + 4) !== 0 || data.readUInt16LE(end + 6) !== 0) {
    return refuse('is split across several files; a catalogue is one zip');
  }
  const count = data.readUInt16LE(end + 10);
  if (count !== data.readUInt16LE(end + 8)) {
    return refuse('is split across several files; a catalogue is one zip');
  }
  if (count > limits.maxEntries) {
    return refuse(
      `holds ${count} entries; a catalogue holds at most ${limits.maxEntries}`,
    );
  }
  const directorySize = data.readUInt32LE(end + 12);
  const directoryStart = data.readUInt32LE(end + 16);
  if (directoryStart + directorySize > end) {
    return refuse('is damaged: its central directory runs past its end');
  }

  const entries: Entry[] = [];
  const seen = new Map<string, string>();
  let at = directoryStart;
  for (let index = 0; index < count; index++) {
    const entry = readEntry(data, at, directoryStart + directorySize);
    if (typeof entry === 'string') return refuse(entry);
    const clash = seen.get(entry.path.toLowerCase());
    if (clash !== undefined) {
      return refuse(
        clash === entry.path
          ? `holds ${entry.path} twice`
          : `holds both ${clash} and ${entry.path}, which differ only in letter case`,
      );
    }
    seen.set(entry.path.toLowerCase(), entry.path);
    entries.push(entry);
    at = entry.next;
  }
  if (at !== directoryStart + directorySize) {
    return refuse('is damaged: its central directory does not add up');
  }

  // Every entry's place is checked before any is unpacked, and no two may
  // share bytes: overlapping entries are how a small zip claims to hold the
  // same compressed data many times over.
  const byPlace = [...entries].sort((a, b) => a.offset - b.offset);
  for (const [index, entry] of byPlace.entries()) {
    const local = localProblem(data, entry, directoryStart);
    if (local) return refuse(local);
    const previous = byPlace[index - 1];
    if (previous && entry.offset < previous.dataStart + previous.packedSize) {
      return refuse(`is damaged: ${entry.path} overlaps ${previous.path}`);
    }
  }

  const caps = new Map<Entry, number>();
  for (const entry of entries) {
    const cap = limits.fileCap(entry.path);
    if (typeof cap !== 'number') return refuse(cap.refused);
    caps.set(entry, cap);
  }

  const files: ZipFile[] = [];
  let total = 0;
  for (const entry of entries) {
    if (entry.directory) continue;
    const cap = caps.get(entry) ?? 0;
    const room = Math.min(cap, limits.maxTotalBytes - total);
    const unpacked = unpack(data, entry, room);
    if (unpacked === 'too large') {
      return refuse(
        room < cap
          ? `unpacks to more than ${megabytes(limits.maxTotalBytes)} MB; a catalogue unpacks to at most that`
          : `holds ${entry.path}, which is larger than ${kilobytes(cap)} KB; that file is at most that`,
      );
    }
    if ('problem' in unpacked) return refuse(unpacked.problem);
    total += unpacked.byteLength;
    files.push({ path: entry.path, bytes: unpacked });
  }
  return { ok: true, files };
}

/**
 * A zip of `files`, as `cg-templates` CI publishes one: sorted by path,
 * deflated where that is smaller, UTF-8 names, plain files only, and a fixed
 * date, so the same folders always make the same bytes.
 */
export function writeZip(files: readonly ZipFile[]): Uint8Array {
  const sorted = [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of sorted) {
    const name = Buffer.from(file.path, 'utf8');
    const deflated = deflateRawSync(file.bytes);
    const stored = deflated.byteLength >= file.bytes.byteLength;
    const packed = stored ? Buffer.from(file.bytes) : deflated;
    const crc = crc32(file.bytes);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(stored ? STORED : DEFLATE, 8);
    local.writeUInt16LE(0, 10); // 00:00
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.byteLength, 18);
    local.writeUInt32LE(file.bytes.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    locals.push(local, name, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE((UNIX << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(stored ? STORED : DEFLATE, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.byteLength, 20);
    central.writeUInt32LE(file.bytes.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    // A plain file, readable by all and executable by none.
    central.writeUInt32LE(((REGULAR | 0o644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.byteLength + name.byteLength + packed.byteLength;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(END_MIN);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(directory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

interface Entry {
  readonly path: string;
  readonly directory: boolean;
  readonly method: number;
  readonly crc: number;
  readonly packedSize: number;
  readonly size: number;
  /** Where its local header starts. */
  readonly offset: number;
  /** The central directory's raw name bytes, which the local header must repeat. */
  readonly rawName: Buffer;
  /** Where its packed bytes start, once its local header is read. */
  dataStart: number;
  /** Where the next central directory record starts. */
  readonly next: number;
}

/** The end record's place, searching back over a comment; -1 with none. */
function findEnd(data: Buffer): number {
  const lowest = Math.max(0, data.byteLength - END_SEARCH);
  for (let at = data.byteLength - END_MIN; at >= lowest; at--) {
    if (
      data.readUInt32LE(at) === END &&
      at + END_MIN + data.readUInt16LE(at + 20) === data.byteLength
    ) {
      return at;
    }
  }
  return -1;
}

/** One central directory record, or why the zip is refused. */
function readEntry(data: Buffer, at: number, limit: number): Entry | string {
  if (at + 46 > limit || data.readUInt32LE(at) !== CENTRAL) {
    return 'is damaged: its central directory does not add up';
  }
  const madeBy = data.readUInt16LE(at + 4) >> 8;
  const flags = data.readUInt16LE(at + 8);
  const method = data.readUInt16LE(at + 10);
  const nameLength = data.readUInt16LE(at + 28);
  const next =
    at +
    46 +
    nameLength +
    data.readUInt16LE(at + 30) +
    data.readUInt16LE(at + 32);
  if (next > limit) return 'is damaged: its central directory does not add up';

  const rawName = data.subarray(at + 46, at + 46 + nameLength);
  const path = nameOf(rawName, flags);
  if (path === null) {
    return 'holds an entry whose name is neither UTF-8 nor plain ASCII';
  }
  const pathProblem = unsafePath(path);
  if (pathProblem) return pathProblem;

  if (flags & (ENCRYPTED | STRONG_ENCRYPTION)) {
    return `holds ${path} encrypted; a catalogue holds no encrypted file`;
  }
  if (method !== STORED && method !== DEFLATE) {
    return `holds ${path} compressed by method ${method}; a catalogue uses only stored or deflate`;
  }
  const directory = path.endsWith('/');
  if (madeBy === UNIX) {
    const type = (data.readUInt32LE(at + 38) >>> 16) & FILE_TYPE;
    if (type === SYMLINK) {
      return `holds ${path} as a symlink; a catalogue holds only plain files`;
    }
    const expected = directory ? DIRECTORY : REGULAR;
    if (type !== 0 && type !== expected) {
      return `holds ${path}, which is not a plain ${directory ? 'folder' : 'file'}; a catalogue holds only plain files`;
    }
  }
  const packedSize = data.readUInt32LE(at + 20);
  const size = data.readUInt32LE(at + 24);
  if (directory && (packedSize !== 0 || size !== 0)) {
    return `holds ${path}, a folder with content`;
  }
  return {
    path,
    directory,
    method,
    crc: data.readUInt32LE(at + 16),
    packedSize,
    size,
    offset: data.readUInt32LE(at + 42),
    rawName,
    dataStart: -1,
    next,
  };
}

/**
 * The entry's name, as UTF-8 when the zip says so and as ASCII otherwise.
 * Null for a name in some other code page, which would read differently on
 * different machines.
 */
function nameOf(raw: Buffer, flags: number): string | null {
  if (!(flags & UTF8_NAMES) && raw.some((byte) => byte > 0x7f)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return null;
  }
}

/**
 * Why an entry's path could land outside the folder it is unpacked into, or
 * read differently on another system; null when it cannot. A trailing `/`
 * marks a folder and is the only empty segment allowed.
 */
function unsafePath(path: string): string | null {
  const shown = JSON.stringify(path);
  if (path === '') return 'holds an entry with no name';
  if (path.startsWith('/')) {
    return `holds ${shown}, an absolute path; every path is inside the catalogue`;
  }
  // eslint-disable-next-line no-control-regex -- control characters are what this refuses
  if (/[\\\x00-\x1f\x7f]/.test(path)) {
    return `holds ${shown}, a path with a backslash or a control character`;
  }
  const segments = path.replace(/\/$/, '').split('/');
  if (segments.some((segment) => segment === '..')) {
    return `holds ${shown}, a path that climbs out with ..`;
  }
  if (segments.some((segment) => segment === '' || segment === '.')) {
    return `holds ${shown}, a path that is not written plainly`;
  }
  return null;
}

/** Why the local header disagrees with the central directory; null if not. */
function localProblem(
  data: Buffer,
  entry: Entry,
  directoryStart: number,
): string | null {
  const at = entry.offset;
  if (at + 30 > directoryStart || data.readUInt32LE(at) !== LOCAL) {
    return `is damaged: ${entry.path} has no local header`;
  }
  const nameLength = data.readUInt16LE(at + 26);
  const name = data.subarray(at + 30, at + 30 + nameLength);
  if (!name.equals(entry.rawName)) {
    return `is damaged: ${entry.path} is named differently in its local header`;
  }
  if (data.readUInt16LE(at + 8) !== entry.method) {
    return `is damaged: ${entry.path} names two compression methods`;
  }
  entry.dataStart = at + 30 + nameLength + data.readUInt16LE(at + 28);
  if (entry.dataStart + entry.packedSize > directoryStart) {
    return `is damaged: ${entry.path} runs into the central directory`;
  }
  return null;
}

/**
 * The entry's bytes, unpacked and checked against its declared size and
 * CRC; 'too large' past `cap`, or the problem that keeps it from being read.
 */
function unpack(
  data: Buffer,
  entry: Entry,
  cap: number,
): Uint8Array | { readonly problem: string } | 'too large' {
  if (entry.size > cap) return 'too large';
  const packed = data.subarray(
    entry.dataStart,
    entry.dataStart + entry.packedSize,
  );
  let bytes: Buffer;
  if (entry.method === STORED) {
    if (entry.packedSize !== entry.size) {
      return {
        problem: `is damaged: ${entry.path} is stored but declares two sizes`,
      };
    }
    bytes = packed;
  } else {
    try {
      // Stops at the cap whatever the zip declared: one byte past it is
      // enough to know the file is too large.
      bytes = inflateRawSync(packed, { maxOutputLength: Math.max(cap, 1) });
    } catch (error) {
      // By its code, not `instanceof RangeError`: zlib's error is made in
      // Node's own realm, so under a test runner's vm context (Jest) the
      // check was false and a zip bomb read as a damaged entry.
      if ((error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE') {
        return 'too large';
      }
      return { problem: `is damaged: ${entry.path} cannot be unpacked` };
    }
    if (bytes.byteLength > cap) return 'too large';
  }
  if (bytes.byteLength !== entry.size) {
    return { problem: `is damaged: ${entry.path} is not the size it declares` };
  }
  if (crc32(bytes) !== entry.crc) {
    return { problem: `is damaged: ${entry.path} fails its checksum` };
  }
  return bytes;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * The zip's CRC-32. Its own, not `zlib.crc32`, which arrived in Node 22.2:
 * the CLI that bundles this promises any Node 22.
 */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function megabytes(bytes: number): string {
  return String(Math.round((bytes / (1024 * 1024)) * 10) / 10);
}

function kilobytes(bytes: number): string {
  return String(Math.ceil(bytes / 1024));
}
