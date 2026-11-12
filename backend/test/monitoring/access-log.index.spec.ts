import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  endOffsetFor,
  indexPathFor,
  loadAccessLogIndex,
  readAccessLogIndex,
  saveAccessLogIndex,
  seekOffsetFor,
} from '../../src/monitoring/access-log.index';
import { hourBucketFor } from '../../src/monitoring/access-log.parser';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-log-index-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A Traefik access-log line at `hour` on 2026-01-01, tagged `/r/<n>`. */
function line(
  n: number,
  hour: number,
  minute = 0,
  fields: Record<string, unknown> = {},
): string {
  const at = `2026-01-01T${String(hour).padStart(2, '0')}:${String(
    minute,
  ).padStart(2, '0')}:00Z`;
  return JSON.stringify({
    ServiceName: 'shop-web@docker',
    RequestPath: `/r/${n}`,
    StartUTC: at,
    time: at,
    ...fields,
  });
}

/** Byte offset of line `n` of `lines`, written one per line. */
function offsetOf(lines: string[], n: number): number {
  return lines.slice(0, n).reduce((sum, l) => sum + l.length + 1, 0);
}

function writeLog(lines: string[], name = 'access.log'): string {
  const logPath = path.join(dir, name);
  fs.writeFileSync(logPath, lines.length > 0 ? `${lines.join('\n')}\n` : '');
  return logPath;
}

// The index is the half a streaming read could not do: `processLogs`
// already buckets rows by UTC hour after the fact, so the same buckets carried
// as byte offsets turn "walk the file looking for the window" into a seek.
describe('readAccessLogIndex', () => {
  it('records one bucket per UTC hour, at the offset of that hour’s first line', async () => {
    const lines = [line(0, 6), line(1, 6, 30), line(2, 7), line(3, 9)];
    const logPath = writeLog(lines);

    const index = await readAccessLogIndex(logPath);

    expect(index.hours).toEqual([
      {
        hour: '2026-01-01T06:00:00Z',
        offset: 0,
        end: offsetOf(lines, 2),
        lines: 2,
      },
      {
        hour: '2026-01-01T07:00:00Z',
        offset: lines[0].length + 1 + lines[1].length + 1,
        end: offsetOf(lines, 3),
        lines: 1,
      },
      {
        hour: '2026-01-01T09:00:00Z',
        offset: lines.slice(0, 3).reduce((n, l) => n + l.length + 1, 0),
        end: offsetOf(lines, 4),
        lines: 1,
      },
    ]);
    // Every byte of a log that ends in a newline is accounted for.
    expect(index.indexedBytes).toBe(fs.statSync(logPath).size);
  });

  it('counts only rows the reader would keep, and skips unparseable ones', async () => {
    const logPath = writeLog([
      line(0, 6),
      'not json at all',
      JSON.stringify({
        ServiceName: 'cloudgate-service-app@file',
        StartUTC: '2026-01-01T06:10:00Z',
      }),
      line(1, 6),
    ]);

    const index = await readAccessLogIndex(logPath);

    expect(index.hours).toEqual([
      {
        hour: '2026-01-01T06:00:00Z',
        offset: 0,
        end: fs.statSync(logPath).size,
        lines: 2,
      },
    ]);
  });

  // Traefik's last line is routinely half-written. Indexing it would put a
  // bucket at an offset the next append moves, and `indexedBytes` past bytes
  // that are about to change — so the partial line is left for next time.
  it('stops at the last complete line, so a partial tail cannot corrupt it', async () => {
    const whole = [line(0, 6), line(1, 7)];
    const logPath = path.join(dir, 'access.log');
    const partial = '{"ServiceName":"shop-web@docker","Requ';
    fs.writeFileSync(logPath, `${whole.join('\n')}\n${partial}`);

    const index = await readAccessLogIndex(logPath);

    expect(index.indexedBytes).toBe(
      whole.reduce((n, l) => n + l.length + 1, 0),
    );
    expect(index.hours.map((h) => h.hour)).toEqual([
      '2026-01-01T06:00:00Z',
      '2026-01-01T07:00:00Z',
    ]);

    // Completing that line and appending another indexes both, from where the
    // first pass stopped — the partial line is not lost and not double-counted.
    fs.appendFileSync(
      logPath,
      `estPath":"/r/2","StartUTC":"2026-01-01T07:30:00Z"}\n${line(3, 8)}\n`,
    );
    const grown = await readAccessLogIndex(logPath, index);
    expect(grown.indexedBytes).toBe(fs.statSync(logPath).size);
    expect(grown.hours.map((h) => [h.hour, h.lines])).toEqual([
      ['2026-01-01T06:00:00Z', 1],
      ['2026-01-01T07:00:00Z', 2],
      ['2026-01-01T08:00:00Z', 1],
    ]);
  });

  it('extends an existing index over the appended bytes only', async () => {
    const logPath = writeLog([line(0, 6)]);
    const first = await readAccessLogIndex(logPath);
    const firstSize = fs.statSync(logPath).size;

    fs.appendFileSync(logPath, `${line(1, 7)}\n`);
    const second = await readAccessLogIndex(logPath, first);

    expect(second.bytesScanned).toBe(fs.statSync(logPath).size - firstSize);
    expect(second.hours.map((h) => h.hour)).toEqual([
      '2026-01-01T06:00:00Z',
      '2026-01-01T07:00:00Z',
    ]);
    expect(second.hours[0].offset).toBe(0);
    expect(second.rotated).toBe(false);
  });

  // The log is replaced under the reader by rotation (or by the truncate the
  // log-cleanup cron does). Every offset in the index then points into a file
  // that is gone, so it has to be thrown away rather than trusted.
  it('rebuilds and reports rotation when the log is replaced under it', async () => {
    const logPath = writeLog([line(0, 6), line(1, 7)]);
    const before = await readAccessLogIndex(logPath);

    fs.renameSync(logPath, `${logPath}.1`);
    writeLog([line(2, 20)]);
    const after = await readAccessLogIndex(logPath, before);

    expect(after.rotated).toBe(true);
    expect(after.hours.map((h) => h.hour)).toEqual(['2026-01-01T20:00:00Z']);
    expect(after.hours[0].offset).toBe(0);
    // What the console needs in order to say so out loud.
    expect(after.droppedBefore).toBe('2026-01-01T20:00:00Z');
  });

  it('rebuilds when the log is truncated in place, keeping the same inode', async () => {
    const logPath = writeLog([line(0, 6), line(1, 7), line(2, 8)]);
    const before = await readAccessLogIndex(logPath);

    // `tail -n 1 log > tmp && mv tmp log` is what the log-cleanup cron does;
    // this is the harsher in-place version of the same thing.
    fs.truncateSync(logPath, 0);
    fs.appendFileSync(logPath, `${line(3, 21)}\n`);
    const after = await readAccessLogIndex(logPath, before);

    expect(after.rotated).toBe(true);
    expect(after.hours.map((h) => h.hour)).toEqual(['2026-01-01T21:00:00Z']);
  });
});

describe('seekOffsetFor', () => {
  it('answers the offset of the first line that can be in the window', async () => {
    const lines = [line(0, 6), line(1, 7), line(2, 8)];
    const logPath = writeLog(lines);
    const index = await readAccessLogIndex(logPath);
    const offsetOf = (n: number) =>
      lines.slice(0, n).reduce((sum, l) => sum + l.length + 1, 0);

    // Mid-hour: the hour's own bucket, because a 07:30 line lives in hour 07
    // and the first hour-07 line is the earliest place it can be.
    expect(seekOffsetFor(index, Date.parse('2026-01-01T07:30:00Z'))).toBe(
      offsetOf(1),
    );
    // An hour with no traffic seeks past it, to the next hour that has some.
    expect(seekOffsetFor(index, Date.parse('2026-01-01T05:00:00Z'))).toBe(0);
    // Later than everything in the log: nothing to read.
    expect(seekOffsetFor(index, Date.parse('2026-01-01T23:00:00Z'))).toBe(
      index.indexedBytes,
    );
  });

  // Traefik writes a line when its request finishes, not when it started, so
  // hour H's first line can sit *after* hour H+1's. Taking the bucket's own
  // offset would then start the read past rows that belong in the window.
  it('takes the lowest offset of any hour at or after the window, not the hour’s own', async () => {
    const lines = [line(0, 8), line(1, 7), line(2, 9)];
    const logPath = writeLog(lines);
    const index = await readAccessLogIndex(logPath);

    // Hour 08 is first in the file even though hour 07 is earlier in time.
    expect(seekOffsetFor(index, Date.parse('2026-01-01T07:00:00Z'))).toBe(0);
  });

  it('starts at the top when there is no index yet', () => {
    expect(
      seekOffsetFor(
        {
          hours: [],
          indexedBytes: 0,
          fingerprint: '',
          rotated: false,
          bytesScanned: 0,
        },
        Date.parse('2026-01-01T07:00:00Z'),
      ),
    ).toBe(0);
  });
});

describe('the index on disk', () => {
  // It cannot be a .json/.yml/.toml: the log lives in Traefik's `dynamic/`
  // directory, whose file provider tries to parse every config-shaped file it
  // finds there.
  it('sits beside the log under an extension Traefik’s file provider ignores', () => {
    const logPath = '/etc/cloudgate/traefik/dynamic/access.log';
    expect(indexPathFor(logPath)).toBe(
      '/etc/cloudgate/traefik/dynamic/access.log.hours',
    );
    expect(indexPathFor(logPath)).not.toMatch(/\.(ya?ml|toml|json)$/);
  });

  it('round-trips, so the first ranged read after a restart still seeks', async () => {
    const logPath = writeLog([line(0, 6), line(1, 7)]);
    const built = await readAccessLogIndex(logPath);
    saveAccessLogIndex(logPath, built);

    const loaded = loadAccessLogIndex(logPath);
    expect(loaded?.hours).toEqual(built.hours);
    expect(loaded?.indexedBytes).toBe(built.indexedBytes);

    // And a reload over an unchanged file scans nothing at all.
    const reused = await readAccessLogIndex(logPath, loaded ?? undefined);
    expect(reused.bytesScanned).toBe(0);
  });

  it('rebuilds an index written before its buckets knew where they end', async () => {
    const logPath = writeLog([line(0, 6)]);
    const built = await readAccessLogIndex(logPath);
    fs.writeFileSync(
      indexPathFor(logPath),
      JSON.stringify({
        ...built,
        hours: built.hours.map(({ hour, offset, lines }) => ({
          hour,
          offset,
          lines,
        })),
      }),
    );

    expect(loadAccessLogIndex(logPath)).toBeNull();
  });

  it('survives a corrupt index file by rebuilding', async () => {
    const logPath = writeLog([line(0, 6)]);
    fs.writeFileSync(indexPathFor(logPath), 'not json');

    expect(loadAccessLogIndex(logPath)).toBeNull();
    const rebuilt = await readAccessLogIndex(logPath, undefined);
    expect(rebuilt.hours).toHaveLength(1);
  });
});

describe('hourBucketFor', () => {
  it('is the key processLogs buckets by', () => {
    expect(hourBucketFor('2026-01-01T07:34:12.918273645Z')).toBe(
      '2026-01-01T07:00:00Z',
    );
  });

  it('answers null for a timestamp it cannot read', () => {
    expect(hourBucketFor('')).toBeNull();
    expect(hourBucketFor('yesterday')).toBeNull();
  });
});

describe('endOffsetFor', () => {
  // A request is written when it finishes. A long download, long poll or
  // WebSocket that started in hour 07 lands behind the lines of hour 08 and
  // later, and a read of hour 07 that stopped at the first run of newer lines
  // would never reach it.
  it('reaches the line of a request that started in the window and landed late', async () => {
    const lines = [
      line(0, 7),
      ...Array.from({ length: 150 }, (_, n) => line(n + 1, 8)),
      line(999, 7, 59, { Duration: 2 * 3_600_000_000_000 }),
      line(1000, 9),
    ];
    const logPath = writeLog(lines);
    const index = await readAccessLogIndex(logPath);

    expect(
      endOffsetFor(
        index,
        Date.parse('2026-01-01T07:00:00Z'),
        Date.parse('2026-01-01T07:59:59Z'),
      ),
    ).toBe(offsetOf(lines, lines.length - 1));
  });

  it('answers the end of the last indexed line for a window with no end', async () => {
    const lines = [line(0, 6), line(1, 7)];
    const logPath = writeLog(lines);
    const index = await readAccessLogIndex(logPath);

    expect(
      endOffsetFor(
        index,
        Date.parse('2026-01-01T07:00:00Z'),
        Number.POSITIVE_INFINITY,
      ),
    ).toBe(index.indexedBytes);
  });

  it('answers 0 for a window that covers no indexed hour', async () => {
    const logPath = writeLog([line(0, 6)]);
    const index = await readAccessLogIndex(logPath);

    expect(
      endOffsetFor(
        index,
        Date.parse('2026-01-01T09:00:00Z'),
        Date.parse('2026-01-01T10:00:00Z'),
      ),
    ).toBe(0);
  });
});
