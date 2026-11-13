import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { CliError } from './errors.js';
import { EXIT } from './exit-codes.js';
import type { UploadFile } from './upload-files.js';

/**
 * The upload as the server reads it: a zip in the multipart part `zip` of
 * `POST /applications/:id/drop`, unpacked by `readDropArchive`
 * (`backend/src/applications/drop-archive.ts`), which reads stored and
 * deflated entries and no Zip64.
 *
 * Written here, not taken from a package, because the published CLI has no
 * runtime dependencies (`cli/build.mjs`); a writer is the small half of the
 * format. Every entry is deflated, named in UTF-8 (flag bit 11), and carries
 * no mode: the server keeps none (CLI spec, Out of Scope).
 */
export function packUpload(
  root: string,
  files: readonly Pick<UploadFile, 'path' | 'size'>[],
): Buffer {
  if (files.length > MAX_ENTRIES) {
    throw new CliError(
      `the folder has ${files.length} files to upload, more than the ${MAX_ENTRIES} one upload can hold`,
      EXIT.failed,
      'Leave some out with a .cloudgateignore.',
    );
  }
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const content = readFileSync(join(root, file.path));
    const compressed = deflateRawSync(content);
    const name = Buffer.from(file.path, 'utf8');
    const crc = crc32(content);
    if (
      content.length > MAX_SIZE ||
      compressed.length > MAX_SIZE ||
      offset > MAX_SIZE
    ) {
      throw new CliError(
        `the upload passes 4 GB at ${file.path}, more than one upload can hold`,
        EXIT.failed,
        'Leave some files out with a .cloudgateignore.',
      );
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0, deflate
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(DEFLATE, 8);
    local.writeUInt16LE(0, 10); // time: none kept
    local.writeUInt16LE(DOS_EPOCH, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // needed
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(DEFLATE, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_EPOCH, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    // extra, comment, disk, internal and external attributes: all 0.
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const MAX_ENTRIES = 0xffff;
const MAX_SIZE = 0xffffffff;
const UTF8_NAMES = 0x0800;
const DEFLATE = 8;
/** 1980-01-01, the earliest date a zip can say. */
const DOS_EPOCH = (0 << 9) | (1 << 5) | 1;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * CRC-32, by table: `zlib.crc32` arrived in Node 22.2, and the CLI runs on
 * every Node 22.
 */
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
