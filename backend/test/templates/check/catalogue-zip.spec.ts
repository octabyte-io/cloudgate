import * as zlib from 'node:zlib';

import { readZip, writeZip } from '../../../src/templates/check/catalogue-zip';
import type {
  ZipFile,
  ZipLimits,
} from '../../../src/templates/check/catalogue-zip';
import { crc32, zipOf } from '../zip.fixture';
import type { ZipEntryFixture } from '../zip.fixture';

// Inflating is watched, not replaced, so a test can see where it stopped:
// node:zlib's own exports cannot be spied on in place.
jest.mock('node:zlib', () => {
  const actual = jest.requireActual<typeof import('node:zlib')>('node:zlib');
  return { ...actual, inflateRawSync: jest.fn(actual.inflateRawSync) };
});
const inflate = zlib.inflateRawSync as jest.MockedFunction<
  typeof zlib.inflateRawSync
>;
beforeEach(() => inflate.mockClear());

/**
 * The catalogue's zip reader and writer (ADR-0072). Every zip read here is
 * written by the tests' own `zipOf`, with one field broken at a time, so a
 * refusal is proved against bytes the reader did not make.
 */

const KB = 1024;
const MB = 1024 * KB;

/** Room enough for anything here, unless a test narrows one limit. */
const LIMITS: ZipLimits = {
  maxEntries: 100,
  maxTotalBytes: 10 * MB,
  fileCap: () => MB,
};

function reason(
  entries: readonly ZipEntryFixture[] | Buffer,
  limits: Partial<ZipLimits> = {},
): string {
  const bytes = Buffer.isBuffer(entries) ? entries : zipOf(entries);
  const result = readZip(bytes, { ...LIMITS, ...limits });
  if (result.ok) throw new Error('read, not refused');
  return result.reason;
}

function files(
  entries: readonly ZipEntryFixture[] | Uint8Array,
  limits: Partial<ZipLimits> = {},
): Record<string, string> {
  const bytes = entries instanceof Uint8Array ? entries : zipOf(entries);
  const result = readZip(bytes, { ...LIMITS, ...limits });
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return Object.fromEntries(
    result.files.map((file) => [
      file.path,
      Buffer.from(file.bytes).toString('utf8'),
    ]),
  );
}

/** Where a zip's end record starts: it has no comment here. */
const endOf = (zip: Buffer) => zip.byteLength - 22;

describe('readZip', () => {
  describe('a zip it reads', () => {
    it('returns each file with its bytes, stored or deflated', () => {
      const text = 'server { listen 80; }\n'.repeat(50);

      expect(
        files([
          { path: 'a.conf', bytes: 'stored' },
          {
            path: 'b.conf',
            bytes: text,
            method: 8,
            packed: zlib.deflateRawSync(Buffer.from(text)),
          },
        ]),
      ).toEqual({ 'a.conf': 'stored', 'b.conf': text });
    });

    it('checks a folder entry like a file and then leaves it out', () => {
      const asked: string[] = [];
      const fileCap = (path: string) => {
        asked.push(path);
        return path === 'refused/' ? { refused: 'holds refused/' } : MB;
      };

      expect(
        files(
          [
            { path: 'templates/', bytes: '' },
            { path: 'templates/a.conf', bytes: 'a' },
          ],
          { fileCap },
        ),
      ).toEqual({ 'templates/a.conf': 'a' });
      expect(asked).toEqual(['templates/', 'templates/a.conf']);
      expect(reason([{ path: 'refused/', bytes: '' }], { fileCap })).toBe(
        'holds refused/',
      );
    });

    it('reads a file of exactly its cap, stored or deflated', () => {
      const text = 'x'.repeat(KB);

      expect(
        files([{ path: 'a', bytes: text }], { fileCap: () => KB }).a,
      ).toHaveLength(KB);
      expect(
        files(
          [
            {
              path: 'a',
              bytes: text,
              method: 8,
              packed: zlib.deflateRawSync(Buffer.from(text)),
            },
          ],
          { fileCap: () => KB },
        ).a,
      ).toHaveLength(KB);
    });
  });

  describe('the zip as a whole', () => {
    it('refuses bytes that are not a zip', () => {
      expect(reason(Buffer.from('<html></html>'))).toBe('is not a zip file');
      expect(reason(Buffer.alloc(0))).toBe('is not a zip file');
    });

    it('refuses a ZIP64 file', () => {
      const zip = zipOf([{ path: 'a', bytes: 'a' }]);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      const withLocator = Buffer.concat([
        zip.subarray(0, endOf(zip)),
        locator,
        zip.subarray(endOf(zip)),
      ]);

      expect(reason(withLocator)).toBe(
        'is a ZIP64 file; a catalogue is a plain zip',
      );
    });

    it('refuses a zip split across several disks', () => {
      const onDisk = (field: number) => {
        const zip = zipOf([
          { path: 'a', bytes: 'a' },
          { path: 'b', bytes: 'b' },
        ]);
        zip.writeUInt16LE(1, endOf(zip) + field);
        return zip;
      };

      for (const field of [4, 6, 8]) {
        expect(reason(onDisk(field))).toBe(
          'is split across several files; a catalogue is one zip',
        );
      }
    });

    it('refuses a central directory that runs past the end record', () => {
      const zip = zipOf([{ path: 'a', bytes: 'a' }]);
      zip.writeUInt32LE(zip.readUInt32LE(endOf(zip) + 12) + 1, endOf(zip) + 12);

      expect(reason(zip)).toBe(
        'is damaged: its central directory runs past its end',
      );
    });

    it('refuses a central directory whose records do not add up', () => {
      const zip = zipOf([
        { path: 'a', bytes: 'a' },
        { path: 'b', bytes: 'b' },
      ]);
      // Claims one entry, so a whole record is left over.
      zip.writeUInt16LE(1, endOf(zip) + 8);
      zip.writeUInt16LE(1, endOf(zip) + 10);

      expect(reason(zip)).toBe(
        'is damaged: its central directory does not add up',
      );
    });

    it('refuses more entries than its cap, folders counted', () => {
      const entries = [
        { path: 'templates/', bytes: '' },
        { path: 'templates/a', bytes: 'a' },
        { path: 'templates/b', bytes: 'b' },
      ];

      expect(files(entries, { maxEntries: 3 })).toHaveProperty('templates/b');
      expect(reason(entries, { maxEntries: 2 })).toBe(
        'holds 3 entries; a catalogue holds at most 2',
      );
    });
  });

  describe('paths', () => {
    it.each([
      [
        '/etc/passwd',
        '"/etc/passwd", an absolute path; every path is inside the catalogue',
      ],
      ['templates/../x', '"templates/../x", a path that climbs out with ..'],
      ['..', '"..", a path that climbs out with ..'],
      [
        'templates\\x',
        '"templates\\\\x", a path with a backslash or a control character',
      ],
      [
        'templates/a\u0000b',
        '"templates/a\\u0000b", a path with a backslash or a control character',
      ],
      [
        'templates/a\nb',
        '"templates/a\\nb", a path with a backslash or a control character',
      ],
      [
        'templates/a\u007fb',
        '"templates/a\u007fb", a path with a backslash or a control character',
      ],
      ['templates//x', '"templates//x", a path that is not written plainly'],
      ['templates/./x', '"templates/./x", a path that is not written plainly'],
      ['templates//', '"templates//", a path that is not written plainly'],
    ])('refuses %j', (path, why) => {
      expect(reason([{ path, bytes: 'x' }])).toBe(`holds ${why}`);
    });

    it('refuses an entry with no name', () => {
      expect(reason([{ path: '', bytes: '' }])).toBe(
        'holds an entry with no name',
      );
    });

    it('refuses a name in neither UTF-8 nor plain ASCII', () => {
      // Without the UTF-8 flag, a byte over 0x7f is in some code page.
      expect(reason([{ path: 'logo-é.svg', bytes: 'x', flags: 0 }])).toBe(
        'holds an entry whose name is neither UTF-8 nor plain ASCII',
      );
      expect(files([{ path: 'plain.svg', bytes: 'x', flags: 0 }])).toEqual({
        'plain.svg': 'x',
      });
    });

    it('refuses the same path twice', () => {
      expect(
        reason([
          { path: 'a.conf', bytes: 'one' },
          { path: 'a.conf', bytes: 'two' },
        ]),
      ).toBe('holds a.conf twice');
    });

    it('refuses two paths that differ only in letter case', () => {
      expect(
        reason([
          { path: 'templates/ghost/logo.svg', bytes: 'one' },
          { path: 'templates/Ghost/logo.svg', bytes: 'two' },
        ]),
      ).toBe(
        'holds both templates/ghost/logo.svg and templates/Ghost/logo.svg, which differ only in letter case',
      );
    });
  });

  describe('entries', () => {
    it('refuses an encrypted entry, either kind', () => {
      for (const flags of [0x0801, 0x0840]) {
        expect(reason([{ path: 'a', bytes: 'x', flags }])).toBe(
          'holds a encrypted; a catalogue holds no encrypted file',
        );
      }
    });

    it('refuses a compression method other than stored or deflate', () => {
      for (const method of [12, 14, 93, 99]) {
        expect(reason([{ path: 'a', bytes: 'x', method }])).toBe(
          `holds a compressed by method ${method}; a catalogue uses only stored or deflate`,
        );
      }
    });

    it('refuses a symlink', () => {
      expect(
        reason([
          { path: 'templates/x', bytes: '/etc/passwd', unixMode: 0o120777 },
        ]),
      ).toBe(
        'holds templates/x as a symlink; a catalogue holds only plain files',
      );
    });

    it('refuses an entry that is not a plain file or folder', () => {
      expect(reason([{ path: 'fifo', bytes: '', unixMode: 0o010644 }])).toBe(
        'holds fifo, which is not a plain file; a catalogue holds only plain files',
      );
      expect(reason([{ path: 'dir/', bytes: '', unixMode: 0o100644 }])).toBe(
        'holds dir/, which is not a plain folder; a catalogue holds only plain files',
      );
    });

    it('refuses a folder entry with content', () => {
      expect(reason([{ path: 'dir/', bytes: 'x' }])).toBe(
        'holds dir/, a folder with content',
      );
    });

    it('refuses an entry whose local header is missing', () => {
      const zip = zipOf([{ path: 'a', bytes: 'x' }]);
      zip.writeUInt32LE(0, 0);

      expect(reason(zip)).toBe('is damaged: a has no local header');
    });

    it('refuses a name that differs between the local header and the central directory', () => {
      expect(
        reason([{ path: 'logo.svg', localPath: 'logo.sh', bytes: 'x' }]),
      ).toBe('is damaged: logo.svg is named differently in its local header');
    });

    it('refuses a method that differs between the local header and the central directory', () => {
      expect(reason([{ path: 'a', bytes: 'x', localMethod: 8 }])).toBe(
        'is damaged: a names two compression methods',
      );
    });

    it('refuses entries that share bytes', () => {
      // The first entry claims the second's header and data as its own.
      expect(
        reason([
          { path: 'a', bytes: 'x', declaredPackedSize: 1 + 30 + 1 + 1 },
          { path: 'b', bytes: 'y' },
        ]),
      ).toBe('is damaged: b overlaps a');
    });

    it('refuses an entry that runs into the central directory', () => {
      expect(reason([{ path: 'a', bytes: 'x', declaredPackedSize: 2 }])).toBe(
        'is damaged: a runs into the central directory',
      );
    });

    it('refuses a stored entry declaring a size other than its packed size', () => {
      expect(reason([{ path: 'a', bytes: 'xy', declaredSize: 1 }])).toBe(
        'is damaged: a is stored but declares two sizes',
      );
    });

    it('refuses a deflated entry that unpacks to a size other than it declares', () => {
      const text = 'abc'.repeat(100);

      expect(
        reason([
          {
            path: 'a',
            bytes: text,
            method: 8,
            packed: zlib.deflateRawSync(Buffer.from(text)),
            declaredSize: 299,
          },
        ]),
      ).toBe('is damaged: a is not the size it declares');
    });

    it('refuses a deflated entry that cannot be unpacked', () => {
      expect(
        reason([
          {
            path: 'a',
            bytes: 'x',
            method: 8,
            packed: Buffer.from([0xff, 0xff, 0xff, 0xff]),
          },
        ]),
      ).toBe('is damaged: a cannot be unpacked');
    });

    it('refuses an entry that fails its checksum, stored or deflated', () => {
      expect(
        reason([{ path: 'a', bytes: 'x', crc: crc32(Buffer.from('y')) }]),
      ).toBe('is damaged: a fails its checksum');
      expect(
        reason([
          {
            path: 'a',
            bytes: 'x',
            method: 8,
            packed: zlib.deflateRawSync(Buffer.from('x')),
            crc: 0,
          },
        ]),
      ).toBe('is damaged: a fails its checksum');
    });
  });

  describe('sizes', () => {
    it('refuses a file over its own cap', () => {
      expect(
        reason([{ path: 'logo.svg', bytes: 'x'.repeat(KB + 1) }], {
          fileCap: () => KB,
        }),
      ).toBe(
        'holds logo.svg, which is larger than 1 KB; that file is at most that',
      );
    });

    it('refuses files that together unpack past the total cap', () => {
      const entries = [
        { path: 'a', bytes: 'x'.repeat(600 * KB) },
        { path: 'b', bytes: 'x'.repeat(600 * KB) },
      ];

      expect(files(entries, { maxTotalBytes: 1200 * KB })).toHaveProperty('b');
      expect(reason(entries, { maxTotalBytes: 1200 * KB - 1 })).toBe(
        'unpacks to more than 1.2 MB; a catalogue unpacks to at most that',
      );
    });

    it('stops a zip bomb at the cap, whatever size it declares', () => {
      const zeros = Buffer.alloc(8 * MB);
      const bomb = zipOf([
        {
          path: 'logo.svg',
          bytes: Buffer.from('small'),
          method: 8,
          packed: zlib.deflateRawSync(zeros),
          declaredSize: 5,
          crc: crc32(zeros),
        },
      ]);

      expect(bomb.byteLength).toBeLessThan(16 * KB);
      expect(reason(bomb, { fileCap: () => 100 * KB })).toBe(
        'holds logo.svg, which is larger than 100 KB; that file is at most that',
      );
      // Inflating was told to stop at the cap, and it did: it threw rather
      // than return the 8 MB.
      expect(inflate).toHaveBeenCalledTimes(1);
      expect(inflate.mock.calls[0][1]).toEqual({ maxOutputLength: 100 * KB });
      expect(inflate.mock.results[0].type).toBe('throw');
    });

    it('stops a zip bomb at what is left of the total cap', () => {
      const zeros = Buffer.alloc(8 * MB);
      const bomb = {
        path: 'b',
        bytes: Buffer.from('small'),
        method: 8,
        packed: zlib.deflateRawSync(zeros),
        declaredSize: 5,
        crc: crc32(zeros),
      };

      expect(
        reason([{ path: 'a', bytes: 'x'.repeat(KB) }, bomb], {
          maxTotalBytes: 2 * MB,
          fileCap: () => 4 * MB,
        }),
      ).toBe('unpacks to more than 2 MB; a catalogue unpacks to at most that');
      expect(inflate.mock.calls[0][1]).toEqual({
        maxOutputLength: 2 * MB - KB,
      });
    });

    it('refuses a file declaring more than its cap without unpacking it', () => {
      expect(
        reason(
          [
            {
              path: 'a',
              bytes: 'x',
              method: 8,
              packed: zlib.deflateRawSync(Buffer.from('x')),
              declaredSize: KB + 1,
            },
          ],
          { fileCap: () => KB },
        ),
      ).toBe('holds a, which is larger than 1 KB; that file is at most that');
      expect(inflate).not.toHaveBeenCalled();
    });
  });
});

describe('writeZip', () => {
  const FILES: ZipFile[] = [
    { path: 'catalogue.json', bytes: Buffer.from('{"format":2}') },
    {
      path: 'templates/ghost/files/nginx.conf',
      bytes: Buffer.from('server { listen 80; }\n'.repeat(100)),
    },
    { path: 'templates/ghost/logo.png', bytes: Buffer.from([0x89, 0, 1, 2]) },
  ];

  it('writes a zip readZip reads back to the same files', () => {
    const read = readZip(writeZip(FILES), LIMITS);

    expect(read.ok && read.files).toEqual(
      FILES.map(({ path, bytes }) => ({ path, bytes: Buffer.from(bytes) })),
    );
  });

  it('writes the same bytes for the same files, in any order', () => {
    expect(Buffer.from(writeZip([...FILES].reverse()))).toEqual(
      Buffer.from(writeZip(FILES)),
    );
  });

  it('marks every file a plain file readable by all and executable by none', () => {
    const zip = Buffer.from(writeZip(FILES));
    const end = endOf(zip);
    let at = zip.readUInt32LE(end + 16);
    const modes: number[] = [];
    for (let index = 0; index < zip.readUInt16LE(end + 10); index++) {
      expect(zip.readUInt32LE(at)).toBe(0x02014b50);
      expect(zip.readUInt16LE(at + 4) >> 8).toBe(3); // made on Unix
      modes.push(zip.readUInt32LE(at + 38) >>> 16);
      at +=
        46 +
        zip.readUInt16LE(at + 28) +
        zip.readUInt16LE(at + 30) +
        zip.readUInt16LE(at + 32);
    }

    expect(modes).toEqual([0o100644, 0o100644, 0o100644]);
  });
});
