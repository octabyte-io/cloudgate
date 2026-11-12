/**
 * A zip writer for the Template catalogue's tests, written apart from
 * `src/templates/check/catalogue-zip.ts` so a test's expected bytes do not
 * come from the code under test (CODING_STANDARDS §1.7). It writes only
 * what a test needs: stored files with a correct CRC, plus knobs to break
 * one field at a time.
 */

export interface ZipEntryFixture {
  readonly path: string;
  readonly bytes: Uint8Array | string;
  /** The central directory's external attributes; a plain 0o100644 file by default. */
  readonly unixMode?: number;
  /** General purpose flags; UTF-8 names (0x0800) by default. */
  readonly flags?: number;
  /** The compression method written; 0 (stored) by default. */
  readonly method?: number;
  /** The CRC written, in place of the right one. */
  readonly crc?: number;
  /** The unpacked size written, in place of the right one. */
  readonly declaredSize?: number;
  /** Packed bytes written in place of `bytes` (e.g. raw deflate). */
  readonly packed?: Uint8Array;
  /** The packed size written, in place of the packed bytes' own length. */
  readonly declaredPackedSize?: number;
  /** The name written in the local header, in place of `path`. */
  readonly localPath?: string;
  /** The compression method written in the local header, in place of `method`. */
  readonly localMethod?: number;
}

/** A zip of `entries`, in the order given. */
export function zipOf(entries: readonly ZipEntryFixture[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const bytes =
      typeof entry.bytes === 'string'
        ? Buffer.from(entry.bytes, 'utf8')
        : Buffer.from(entry.bytes);
    const packed = entry.packed ? Buffer.from(entry.packed) : bytes;
    const name = Buffer.from(entry.path, 'utf8');
    const flags = entry.flags ?? 0x0800;
    const method = entry.method ?? 0;
    const crc = entry.crc ?? crc32(bytes);
    const size = entry.declaredSize ?? bytes.byteLength;
    const packedSize = entry.declaredPackedSize ?? packed.byteLength;
    const localName =
      entry.localPath === undefined
        ? name
        : Buffer.from(entry.localPath, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(entry.localMethod ?? method, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packedSize, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(localName.byteLength, 26);
    locals.push(local, localName, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packedSize, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.byteLength, 28);
    const mode =
      entry.unixMode ?? (entry.path.endsWith('/') ? 0o040755 : 0o100644);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + localName.byteLength + packed.byteLength;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/**
 * The bytes of a `catalogue.zip` (format 2) holding `folders`: the index
 * written out by hand, then each folder's files under `templates/<id>/`.
 */
export function catalogueZip(
  folders: readonly {
    readonly id: string;
    readonly revision?: string;
    readonly files: Readonly<Record<string, string | { base64: string }>>;
  }[],
): Buffer {
  const entries: ZipEntryFixture[] = [
    {
      path: 'catalogue.json',
      bytes: JSON.stringify({
        format: 2,
        templates: folders.map((folder) => ({
          id: folder.id,
          revision: folder.revision ?? 'c0ffee1',
        })),
      }),
    },
  ];
  for (const folder of folders) {
    for (const [path, content] of Object.entries(folder.files)) {
      entries.push({
        path: `templates/${folder.id}/${path}`,
        bytes:
          typeof content === 'string'
            ? content
            : Buffer.from(content.base64, 'base64'),
      });
    }
  }
  return zipOf(entries);
}

/** CRC-32 (IEEE), bit by bit: slow, and plainly not the table the source uses. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
