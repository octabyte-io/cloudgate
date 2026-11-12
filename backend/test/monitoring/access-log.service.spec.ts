import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AccessLogService,
  UNFILTERED_LINE_LIMIT,
  linesFromEnd,
} from '../../src/monitoring/access-log.service';
import { processLogs } from '../../src/monitoring/access-log.parser';
import type { PermissionService } from '../../src/rbac/permission.service';

// Reading the access log touches no database and no permission — the instance
// authority both queries now take is the only thing that does, and it is covered
// over the real database in monitoring.e2e-spec.ts. Everything here is a real
// file on disk, because what the old reader got wrong was which *end* of the file it read.
function service(): AccessLogService {
  return new AccessLogService({} as PermissionService);
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-access-log-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A Traefik access-log line. `n` is carried in the path so rows are tellable apart. */
function line(n: number, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ServiceName: 'shop-web@docker',
    RequestHost: 'shop.example.com',
    RequestPath: `/r/${n}`,
    RequestMethod: 'GET',
    DownstreamStatus: 200,
    // One request a minute, counting forward — so line n is newer than line n-1,
    // which is the ordering Traefik's append gives a real log.
    StartUTC: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString(),
    time: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString(),
    ...fields,
  });
}

/** Writes `lines` as a log file and answers its path. */
function writeLog(lines: string[], name = 'access.log'): string {
  const logPath = path.join(dir, name);
  fs.writeFileSync(logPath, lines.length > 0 ? `${lines.join('\n')}\n` : '');
  return logPath;
}

/** The `/r/<n>` numbers of the lines a read came back with, in the order read. */
function pathsIn(raw: string | null): number[] {
  if (raw === null) return [];
  return raw
    .split('\n')
    .filter((each) => each.trim() !== '')
    .map((each) => {
      const log = JSON.parse(each) as { RequestPath: string };
      return Number(log.RequestPath.replace('/r/', ''));
    });
}

describe('AccessLogService.readAccessLog, with no date range', () => {
  // The defect: the read streamed from the top of the file and broke at 500, so
  // a screen opened with no filter showed the 500 *oldest* requests ever logged —
  // and `parseRawConfig` then sorted them time-desc, which made them look like
  // the recent past. 500 was always reaching for "the newest 500".
  it('answers the newest lines, not the oldest, when the log is longer than the cap', async () => {
    const total = UNFILTERED_LINE_LIMIT + 120;
    const logPath = writeLog(
      Array.from({ length: total }, (_, index) => line(index)),
    );

    const numbers = pathsIn(await service().readAccessLog(undefined, logPath));

    expect(numbers).toHaveLength(UNFILTERED_LINE_LIMIT);
    // The newest `UNFILTERED_LINE_LIMIT` lines of the file, in file order.
    expect(numbers[0]).toBe(total - UNFILTERED_LINE_LIMIT);
    expect(numbers[numbers.length - 1]).toBe(total - 1);
  });

  it('answers the whole log when it is shorter than the cap', async () => {
    const logPath = writeLog(
      Array.from({ length: 7 }, (_, index) => line(index)),
    );

    expect(pathsIn(await service().readAccessLog(undefined, logPath))).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
  });

  // Traefik's own last line is routinely half-written, and a rotated-then-appended
  // log can have anything in the middle. A garbage line must cost one line, not
  // the read: reading backwards means the bad line is passed on the way to good
  // ones, so swallowing it has to keep the walk going.
  it('steps over malformed lines mid-stream and keeps counting valid ones', async () => {
    const logPath = writeLog([
      line(0),
      'not json at all',
      line(1),
      '{"RequestPath": "/r/2", trailing garbage}',
      line(3),
      '',
      '   ',
      line(4),
      // A half-written final line, which is what a live Traefik leaves behind.
      '{"ServiceName":"shop-web@docker","Request',
    ]);

    expect(pathsIn(await service().readAccessLog(undefined, logPath))).toEqual([
      0, 1, 3, 4,
    ]);
  });

  // The old `readAll` branch handed the file over verbatim, dashboard lines and
  // garbage included, and left the filtering to `parseRawConfig`. Now the reader
  // decides, so both modes have to agree with the parser about what a row is.
  it('never returns the dashboard’s own traffic', async () => {
    const logPath = writeLog([
      line(0),
      line(1, { ServiceName: 'cloudgate-service-app@file' }),
      line(2),
    ]);

    const raw = await service().readAccessLog(undefined, logPath);
    expect(raw).not.toContain('cloudgate-service-app@file');
    expect(pathsIn(raw)).toEqual([0, 2]);
  });

  it('answers null for a log that is not there and an empty string for an empty one', async () => {
    expect(
      await service().readAccessLog(undefined, path.join(dir, 'missing.log')),
    ).toBeNull();
    expect(await service().readAccessLog(undefined, writeLog([]))).toBe('');
  });
});

describe('AccessLogService.readAccessLog, with a date range', () => {
  const window = {
    start: '2026-01-01T00:00:00Z',
    end: '2026-01-02T00:00:00Z',
  };
  const inside = (n: number, hour: number) =>
    line(n, { StartUTC: `2026-01-01T${String(hour).padStart(2, '0')}:00:00Z` });
  const before = (n: number) => line(n, { StartUTC: '2025-11-01T00:00:00Z' });
  const after = (n: number) => line(n, { StartUTC: '2026-03-01T00:00:00Z' });

  // The defect: any range at all took the `fs.readFileSync(logPath, 'utf8')`
  // branch, so the caller got the entire log and `parseRawConfig` did the
  // filtering afterwards. The range is the filter, and it belongs in the read.
  it('answers only the lines inside the window', async () => {
    const logPath = writeLog([
      before(0),
      inside(1, 6),
      before(2),
      inside(3, 12),
      after(4),
      inside(5, 23),
    ]);

    const raw = await service().readAccessLog(window, logPath);
    expect(pathsIn(raw)).toEqual([1, 3, 5]);
    expect(raw).not.toContain('2025-11-01');
    expect(raw).not.toContain('2026-03-01');
  });

  // The old reader walked backwards and gave up once it was far enough past the *start* of
  // the window, which cost it any in-window line stranded behind a long run of
  // older ones — the compromise that bought "a window costs the window". The
  // hour index makes the read start at the window's first hour instead, so
  // the stranded line is now the first thing it sees and the compromise is gone.
  it('finds a line inside the window stranded behind a run of older ones', async () => {
    const stranded = inside(999, 12);
    const logPath = writeLog([
      stranded,
      ...Array.from({ length: 150 }, (_, index) => before(index)),
      inside(1, 22),
      inside(2, 23),
    ]);

    expect(pathsIn(await service().readAccessLog(window, logPath))).toEqual([
      999, 1, 2,
    ]);
  });

  // Traefik writes a line when its request *finishes* and stamps `StartUTC`
  // when it *started*. A two-hour download that started at 23:00 is written
  // behind every request that started after the window closed, and the reader
  // used to stop after 100 of those and drop it. It belongs to hour 23.
  it('counts a request that started in the window and was written after it, in its start hour', async () => {
    const justAfter = (n: number) =>
      line(n, { StartUTC: '2026-01-02T00:05:00Z' });
    const logPath = writeLog([
      inside(0, 6),
      ...Array.from({ length: 150 }, (_, index) => justAfter(index + 1)),
      line(999, {
        StartUTC: '2026-01-01T23:00:00Z',
        Duration: 2 * 3_600_000_000_000,
      }),
      justAfter(1000),
    ]);

    const raw = await service().readAccessLog(window, logPath);

    expect(pathsIn(raw)).toEqual([0, 999]);
    expect(processLogs(raw ?? '', window)).toEqual([
      { hour: '2026-01-01T06:00:00Z', count: 1 },
      { hour: '2026-01-01T23:00:00Z', count: 1 },
    ]);
  });

  // Lines are in completion order, so a request that started before the
  // window is routinely written among the window's own. It is no evidence about
  // where the window is, and must not truncate it.
  it('tolerates a short run of out-of-order lines without truncating the window', async () => {
    const logPath = writeLog([
      inside(0, 1),
      ...Array.from({ length: 40 }, (_, index) => before(index + 100)),
      inside(1, 22),
    ]);

    expect(pathsIn(await service().readAccessLog(window, logPath))).toEqual([
      0, 1,
    ]);
  });

  // A start earlier than anything in the log has nothing to stop at, so this is
  // the one case that still walks the whole file — the case the old code took for
  // *every* range. It must at least walk it a chunk at a time and answer in file
  // order rather than materialising it.
  it('answers the whole log for a window that starts before the log does', async () => {
    const total = 900;
    const logPath = writeLog(
      Array.from({ length: total }, (_, index) => inside(index, 12)),
    );

    const numbers = pathsIn(
      await service().readAccessLog(
        { start: '2019-01-01T00:00:00Z', end: window.end },
        logPath,
      ),
    );
    // Not capped at UNFILTERED_LINE_LIMIT: the pager's totalCount has to be a
    // count of the window, not of what the read felt like fetching.
    expect(numbers).toHaveLength(total);
    expect(numbers[0]).toBe(0);
    expect(numbers[total - 1]).toBe(total - 1);
  });

  it('takes an open-ended window, with only one bound sent', async () => {
    const logPath = writeLog([before(0), inside(1, 6), after(2)]);

    expect(
      pathsIn(await service().readAccessLog({ start: window.start }, logPath)),
    ).toEqual([1, 2]);
    expect(
      pathsIn(await service().readAccessLog({ end: window.end }, logPath)),
    ).toEqual([0, 1]);
  });
});

// `readAll` used to be computed by each caller, and they disagreed: `start &&
// end` in getStatsLogs, `start || end` in getStats. So a window with one bound
// made the table read the oldest 500 lines while the chart above it read the
// whole file — two figures on one screen, from two different slices of the log.
describe('the two queries read the same slice', () => {
  function authorizedService(): AccessLogService {
    return new AccessLogService({
      checkInstanceAuthority: () => Promise.resolve(),
    } as unknown as PermissionService);
  }

  const ctx = {
    user: { id: 'u1' },
    session: { activeOrganizationId: 'org1' },
  };

  it('agrees on the total for a window with only a start bound', async () => {
    const logPath = writeLog([
      line(0, { StartUTC: '2025-11-01T00:00:00Z' }),
      line(1, { StartUTC: '2026-01-01T06:00:00Z' }),
      line(2, { StartUTC: '2026-01-01T07:00:00Z' }),
    ]);
    const dateRange = { start: '2026-01-01T00:00:00Z' };
    const accessLog = authorizedService();
    // The real read, against the temp log rather than accessLogPath() — the
    // default path is the only thing standing in for here.
    const reader = service();
    jest
      .spyOn(accessLog, 'readWindow')
      .mockImplementation((range) => reader.readWindow(range, logPath));

    const logs = await accessLog.getStatsLogs(ctx, { dateRange });
    const stats = await accessLog.getStats(ctx, { dateRange });

    expect(logs.totalCount).toBe(2);
    expect(stats.reduce((sum, hour) => sum + hour.count, 0)).toBe(2);
  });
});

// Reading a file's lines from the end is where this could go quietly wrong: a
// chunk boundary falls wherever it falls, and getting it wrong loses or splices
// a line somewhere in the middle of a log nobody reads by hand. Every case here
// uses a chunk size small enough to land boundaries inside lines on purpose.
describe('AccessLogService.loggingOn', () => {
  const at = (config: string | null) => {
    const configPath = path.join(dir, 'traefik.yml');
    if (config !== null) fs.writeFileSync(configPath, config);
    return service().loggingOn(configPath);
  };

  it('answers on for a traefik.yml with an accessLog block naming a file', () => {
    expect(
      at('accessLog:\n  filePath: /etc/cloudgate/traefik/dynamic/access.log\n'),
    ).toBe(true);
  });

  it('answers off for a traefik.yml with no accessLog block, and for none at all', () => {
    expect(at('entryPoints:\n  web:\n    address: ":80"\n')).toBe(false);
    expect(at(null)).toBe(false);
  });
});

describe('linesFromEnd', () => {
  async function collect(logPath: string, chunkBytes?: number) {
    const lines: string[] = [];
    for await (const line of linesFromEnd(logPath, chunkBytes))
      lines.push(line);
    return lines;
  }

  it('yields every line last to first, whatever the chunk size', async () => {
    const logPath = writeLog(['one', 'two', 'three', 'four', 'five']);

    // A trailing newline makes the last "line" the empty string after it, which
    // is a real line of the file and is the reader's caller's problem to skip.
    for (const chunkBytes of [1, 2, 3, 7, 64 * 1024]) {
      expect(await collect(logPath, chunkBytes)).toEqual([
        '',
        'five',
        'four',
        'three',
        'two',
        'one',
      ]);
    }
  });

  it('reads a last line that has no newline after it', async () => {
    const logPath = path.join(dir, 'partial.log');
    fs.writeFileSync(logPath, 'first\nsecond\nthird');

    expect(await collect(logPath, 4)).toEqual(['third', 'second', 'first']);
  });

  // The reason the carried remainder is a Buffer and not a string: decode half a
  // UTF-8 sequence and the character is gone for good, replaced by U+FFFD. A
  // request path with a non-ASCII byte in it is enough to hit this, and Traefik
  // logs whatever path the client sent.
  it('keeps a multi-byte character that straddles a chunk boundary', async () => {
    const logPath = writeLog(['/café/über', '/日本語']);

    for (const chunkBytes of [1, 2, 3, 5, 8, 13]) {
      expect(await collect(logPath, chunkBytes)).toEqual([
        '',
        '/日本語',
        '/café/über',
      ]);
    }
  });

  it('handles an empty file and a file that is one newline', async () => {
    expect(await collect(writeLog([]))).toEqual([]);
    const justNewline = path.join(dir, 'newline.log');
    fs.writeFileSync(justNewline, '\n');
    expect(await collect(justNewline, 1)).toEqual(['', '']);
  });

  // Laziness is what makes "the last hour" cheap: the caller breaks and the rest
  // of the file is never read. A line longer than the chunk also has to survive,
  // since that is the same carry mechanism under a different name.
  it('reads no further than the caller asks, even past a line longer than a chunk', async () => {
    const long = 'x'.repeat(5_000);
    const logPath = writeLog([
      long,
      ...Array.from({ length: 2_000 }, (_, n) => `line ${n}`),
    ]);

    const seen: string[] = [];
    for await (const line of linesFromEnd(logPath, 128)) {
      if (line !== '') seen.push(line);
      if (seen.length === 3) break;
    }
    expect(seen).toEqual(['line 1999', 'line 1998', 'line 1997']);

    expect((await collect(logPath, 128))[2_001]).toBe(long);
  });
});
