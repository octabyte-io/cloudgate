import zlib from 'node:zlib';

/**
 * A PKZIP archive assembled field by field, for the specs that upload one.
 *
 * **Why a writer by hand rather than a dependency**, which is the first
 * question this file has to answer:
 *
 * - **A library cannot produce the archives under test.** `readDropArchive` is
 *   a zip-slip refusal — the cases that matter are entry names a well-behaved
 *   zip tool declines to write: `../../../etc/cloudgate/evil.js`,
 *   `/etc/passwd`, `..\\..\\windows\\evil.js`. Every writer normalizes or
 *   rejects those on the way out, because emitting them is the bug. So the
 *   fixture for a refusal has to be laid out by hand; once that is true for the
 *   interesting half, a second mechanism for the harmless half only buys a way
 *   for the two to disagree.
 * - **No zip library is a dependency of this repo, and that is deliberate.**
 *   `applications/drop-archive.ts` says so in its own docblock — its reader is
 *   kept to stored and deflated entries *"so that no unzip dependency has to be
 *   added for one route"*. Adding one to `devDependencies` to exercise the code
 *   written to avoid it is the wrong trade in the wrong direction.
 * - **`totp.ts`'s precedent, for the same reason it exists.** A hand-written
 *   implementation on the test side means the subject is checked against the
 *   format rather than against another copy of itself: this writer lays out the
 *   local header, central directory and end-of-central-directory records from
 *   the specification, and `readDropArchive` parses them back with no shared
 *   line of code between the two.
 *
 * Extracted to `test/utils/`: `applications/applications-drop.e2e-spec.ts`
 * and `deployment-engine/drop-deploy.e2e-spec.ts` each carried a copy, the
 * second a cut-down one whose central-directory offset was hard-coded to zero —
 * correct only for a single-entry archive, and the kind of quiet divergence two
 * copies of a byte layout produce. The fuller writer is the one that survived;
 * the caller that wanted one entry passes one.
 */

/** One archive member: a file with its payload, or a bare directory. */
export interface ZipEntry {
  /**
   * The entry name, written verbatim — no normalization, no separator
   * rewriting, no refusal. That is the point of the file: an escape has to
   * reach the parser exactly as an attacker would send it. A trailing `/`
   * makes it a directory entry, as it does in a real archive.
   */
  name: string;
  content: string;
  /** Deflate the payload instead of storing it verbatim. */
  deflate?: boolean;
}

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

const STORED = 0;
const DEFLATED = 8;

export function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf-8');
    const raw = Buffer.from(entry.content, 'utf-8');
    const method = entry.deflate ? DEFLATED : STORED;
    const payload = entry.deflate ? zlib.deflateRawSync(raw) : raw;
    const crc = zlib.crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_FILE_HEADER, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_FILE_HEADER, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    // Where this entry's *local* header starts. The reader follows it to find
    // the payload, so it is the one field a copy of this writer got wrong by
    // hard-coding zero.
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // central directory start disk
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralDirectory, end]);
}
