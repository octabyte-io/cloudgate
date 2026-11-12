import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliError } from '../src/errors.js';
import { packUpload } from '../src/zip.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cloudgate-zip-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, content: string | Buffer): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/**
 * Reads an archive the way the server does (`readDropArchive` in
 * `backend/src/applications/drop-archive.ts`): the end record, then the
 * central directory, then each entry through its local header. Written from
 * the zip format, not from `zip.ts`, so the two can disagree.
 */
function readZip(zip: Buffer): Record<string, string> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThan(-1);
  const count = zip.readUInt16LE(end + 10);
  let cursor = zip.readUInt32LE(end + 16);
  const entries: Record<string, string> = {};
  for (let index = 0; index < count; index += 1) {
    expect(zip.readUInt32LE(cursor)).toBe(0x02014b50);
    const method = zip.readUInt16LE(cursor + 10);
    const crc = zip.readUInt32LE(cursor + 16);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const local = zip.readUInt32LE(cursor + 42);
    const name = zip.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    const start =
      local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + compressedSize);
    const content = method === 8 ? inflateRawSync(raw) : raw;
    expect(content.length).toBe(size);
    expect(crc32(content)).toBe(crc);
    entries[name] = content.toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** CRC-32 (IEEE), bit by bit: slow and obviously the definition. */
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

describe('packUpload', () => {
  it('packs the chosen files, and only those, at their paths', () => {
    write('index.js', 'console.log("hi");\n');
    write('src/deep/a.txt', 'a'.repeat(5000));
    write('empty', '');
    write('not-chosen.txt', 'left out');

    const zip = packUpload(root, [
      { path: 'empty', size: 0 },
      { path: 'index.js', size: 19 },
      { path: 'src/deep/a.txt', size: 5000 },
    ]);

    expect(readZip(zip)).toEqual({
      empty: '',
      'index.js': 'console.log("hi");\n',
      'src/deep/a.txt': 'a'.repeat(5000),
    });
  });

  it('keeps a name outside ASCII', () => {
    write('café/menü.txt', 'ok');

    expect(
      readZip(packUpload(root, [{ path: 'café/menü.txt', size: 2 }])),
    ).toEqual({ 'café/menü.txt': 'ok' });
  });

  it('refuses more files than an archive without Zip64 holds, which the server does not read', () => {
    const many = Array.from({ length: 65_536 }, (_, index) => ({
      path: `f${index}`,
      size: 0,
    }));

    expect(() => packUpload(root, many)).toThrow(CliError);
  });
});
