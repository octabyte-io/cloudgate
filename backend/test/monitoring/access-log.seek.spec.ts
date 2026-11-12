import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AccessLogService } from '../../src/monitoring/access-log.service';
import type { PermissionService } from '../../src/rbac/permission.service';

// An earlier fix stopped a ranged read walking *past* its window, but nothing could
// stop it starting at an end of the file. Everything here is about how much of
// the log a read touches, so every assertion is on bytes and offsets — the
// results being right is that fix's spec's job and is only re-checked in passing.
function service(): AccessLogService {
  return new AccessLogService({} as PermissionService);
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-log-seek-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A realistically fat Traefik line — ~800 bytes, like the ones on a real host. */
function line(at: string, tag: string): string {
  return JSON.stringify({
    ClientAddr: '203.0.113.24:52785',
    ClientHost: '203.0.113.24',
    ClientPort: '52785',
    ClientUsername: '-',
    DownstreamContentSize: 4096,
    DownstreamStatus: 200,
    Duration: 400167,
    OriginContentSize: 4096,
    OriginDuration: 312875,
    OriginStatus: 200,
    Overhead: 87292,
    RequestAddr: 'shop.example.com',
    RequestContentSize: 0,
    RequestCount: 196,
    RequestHost: 'shop.example.com',
    RequestMethod: 'GET',
    RequestPath: `/r/${tag}`,
    RequestPort: '-',
    RequestProtocol: 'HTTP/1.1',
    RequestScheme: 'http',
    RetryAttempts: 0,
    RouterName: 'shop-web@file',
    ServiceAddr: 'shop-web:80',
    ServiceName: 'shop-web@docker',
    ServiceURL: 'http://shop-web:80',
    StartLocal: at,
    StartUTC: at,
    entryPointName: 'web',
    level: 'info',
    msg: '',
    'request_User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    time: at,
  });
}

/** A day of traffic: `perHour` requests in each of the 24 hours of 2026-01-01. */
function writeDay(perHour: number, name = 'access.log'): string {
  const logPath = path.join(dir, name);
  const lines: string[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    for (let n = 0; n < perHour; n += 1) {
      const at = `2026-01-01T${String(hour).padStart(2, '0')}:${String(
        Math.floor((n / perHour) * 60),
      ).padStart(2, '0')}:00Z`;
      lines.push(line(at, `${hour}-${n}`));
    }
  }
  fs.writeFileSync(logPath, `${lines.join('\n')}\n`);
  return logPath;
}

function hoursIn(raw: string): string[] {
  return raw
    .split('\n')
    .filter((each) => each.trim() !== '')
    .map((each) =>
      (JSON.parse(each) as { StartUTC: string }).StartUTC.slice(11, 13),
    );
}

// `inDateRange` is inclusive at both ends, so the hour stops a second short of
// the next one rather than dragging its first requests in.
const oneHour = { start: '2026-01-01T20:00:00Z', end: '2026-01-01T20:59:59Z' };

describe('a ranged read over an indexed log', () => {
  // The defect, stated in bytes: a window late in a big file used to cost the
  // file. It now costs an index seek plus the window.
  it('reads its own window and not the whole file', async () => {
    const logPath = writeDay(250);
    const size = fs.statSync(logPath).size;
    expect(size).toBeGreaterThan(4_000_000);
    const reader = service();

    // The first ranged read is the one that pays for the index: one forward pass
    // over the log, once per log rather than once per query.
    const cold = await reader.readWindow(oneHour, logPath);
    expect(cold?.bytesIndexed).toBeGreaterThan(size * 0.9);

    const warm = await reader.readWindow(oneHour, logPath);

    expect(warm?.bytesIndexed).toBe(0);
    // It started at hour 20, not at either end of the file.
    expect(warm?.fromOffset).toBeGreaterThan(size * 0.8);
    // And read the window plus at most a chunk of slack, not 4 MB.
    expect(warm?.bytesRead).toBeLessThan(size / 10);
    expect(hoursIn(warm?.raw ?? '')).toEqual(Array(250).fill('20'));
  });

  // The other half of that fix's residue: pagination happens after the walk, so page
  // 2 used to re-read everything page 1 read, from the top.
  it('serves page 2 of a window without re-walking from the top', async () => {
    const logPath = writeDay(250);
    const size = fs.statSync(logPath).size;
    const reader = service();
    await reader.readWindow(oneHour, logPath);

    const pageOne = await reader.readWindow(oneHour, logPath);
    const pageTwo = await reader.readWindow(oneHour, logPath);

    // Page 2 costs page 1, and neither costs the bytes in front of the window.
    expect(pageTwo?.bytesRead).toBe(pageOne?.bytesRead);
    expect(pageTwo?.bytesRead).toBeLessThan(pageTwo?.fromOffset ?? 0);
    expect(pageTwo?.bytesIndexed).toBe(0);
    expect(
      (pageTwo?.fromOffset ?? 0) + (pageTwo?.bytesRead ?? 0),
    ).toBeLessThanOrEqual(size);
  });

  it('stops once it is past the end of the window, not just past the start', async () => {
    const logPath = writeDay(250);
    const reader = service();
    await reader.readWindow(oneHour, logPath);

    // Hours 20 and 21 of 24: the read must reach neither end of the file.
    const middle = await reader.readWindow(
      { start: '2026-01-01T20:00:00Z', end: '2026-01-01T21:59:59Z' },
      logPath,
    );

    expect(new Set(hoursIn(middle?.raw ?? ''))).toEqual(new Set(['20', '21']));
    const size = fs.statSync(logPath).size;
    expect((middle?.fromOffset ?? 0) + (middle?.bytesRead ?? 0)).toBeLessThan(
      size,
    );
  });

  it('answers the same rows as the walk it replaces', async () => {
    const logPath = writeDay(20);
    const reader = service();
    const first = await reader.readWindow(oneHour, logPath);
    const second = await reader.readWindow(oneHour, logPath);

    expect(second?.raw).toBe(first?.raw);
    expect(second?.raw).toBe(await reader.readAccessLog(oneHour, logPath));
  });
});

describe('a log rotated out from under the index', () => {
  it('rebuilds the index rather than seeking into the file that is gone', async () => {
    const logPath = writeDay(20);
    const reader = service();
    await reader.readWindow(oneHour, logPath);

    // What rotation does: the log is renamed aside and Traefik reopens a fresh
    // one at the same path on SIGUSR1.
    fs.renameSync(logPath, `${logPath}.1`);
    fs.writeFileSync(logPath, `${line('2026-01-02T09:00:00Z', 'new')}\n`);

    const after = await reader.readWindow(
      { start: '2026-01-02T00:00:00Z', end: '2026-01-03T00:00:00Z' },
      logPath,
    );

    expect(after?.bytesIndexed).toBe(fs.statSync(logPath).size);
    expect(hoursIn(after?.raw ?? '')).toEqual(['09']);
  });

  // Silently answering "no traffic" for a window the log no longer covers is
  // the lie the ticket names: the screen would show an empty hour rather than say the
  // hour is gone.
  it('says how far back the log still goes instead of answering nothing', async () => {
    const logPath = writeDay(20);
    const reader = service();
    await reader.readWindow(oneHour, logPath);

    fs.renameSync(logPath, `${logPath}.1`);
    fs.writeFileSync(logPath, `${line('2026-01-02T09:00:00Z', 'new')}\n`);

    const gone = await reader.readWindow(oneHour, logPath);

    expect(gone?.raw).toBe('');
    expect(gone?.retainedFrom).toBe('2026-01-02T09:00:00Z');
  });

  it('says so for a window that only partly predates the rotation, too', async () => {
    const logPath = writeDay(20);
    const reader = service();
    fs.renameSync(logPath, `${logPath}.1`);
    fs.writeFileSync(logPath, `${line('2026-01-02T09:00:00Z', 'new')}\n`);

    const straddling = await reader.readWindow(
      { start: '2026-01-01T00:00:00Z', end: '2026-01-03T00:00:00Z' },
      logPath,
    );

    expect(hoursIn(straddling?.raw ?? '')).toEqual(['09']);
    expect(straddling?.retainedFrom).toBe('2026-01-02T09:00:00Z');
  });

  // A young log that has never been rotated holds nothing older than itself
  // either, but that is not a gap — there was never anything there to lose.
  it('claims no gap when nothing has been rotated away', async () => {
    const logPath = writeDay(20);
    const reader = service();

    const early = await reader.readWindow(
      { start: '2019-01-01T00:00:00Z', end: '2019-02-01T00:00:00Z' },
      logPath,
    );

    expect(early?.raw).toBe('');
    expect(early?.retainedFrom).toBeUndefined();
  });
});

describe('a half-written trailing line', () => {
  // Traefik buffers (`bufferingSize` 100) and the last line on disk is routinely
  // a fragment. Index it and the bucket points at an offset the next append
  // rewrites; count it and the hour totals are wrong for good.
  it('is left out of the index and picked up once it is complete', async () => {
    const logPath = writeDay(20);
    const reader = service();
    const before = await reader.readWindow(oneHour, logPath);
    const complete = line('2026-01-01T20:45:00Z', 'late');
    const cut = complete.slice(0, 300);

    fs.appendFileSync(logPath, cut);
    const partial = await reader.readWindow(oneHour, logPath);
    expect(partial?.raw).toBe(before?.raw);

    fs.appendFileSync(logPath, `${complete.slice(300)}\n`);
    const whole = await reader.readWindow(oneHour, logPath);
    // The day's own 20 requests in hour 20, plus the line that has just landed.
    expect(hoursIn(whole?.raw ?? '')).toEqual(Array<string>(21).fill('20'));
    expect(whole?.raw).toBe(`${before?.raw}${complete}\n`);
  });

  it('does not shift the offsets already in the index', async () => {
    const logPath = writeDay(20);
    const reader = service();
    const before = await reader.readWindow(oneHour, logPath);

    fs.appendFileSync(logPath, '{"ServiceName":"shop-web@docker","Reques');
    const after = await reader.readWindow(oneHour, logPath);

    expect(after?.fromOffset).toBe(before?.fromOffset);
    expect(after?.bytesIndexed).toBe(0);
  });
});
