import * as fs from 'node:fs';
import * as path from 'node:path';
import { Injectable } from '@nestjs/common';
import { PermissionService } from '../rbac/permission.service';
import type { PermissionCtx } from '../rbac/permission.service';
import {
  accessLogOn,
  mainTraefikDirectory,
} from '../settings/traefik-files.service';
import { dynamicTraefikDirectory } from '../traefik/traefik-writer.service';
import {
  completeLinesFrom,
  endOffsetFor,
  loadAccessLogIndex,
  readAccessLogIndex,
  saveAccessLogIndex,
  seekOffsetFor,
} from './access-log.index';
import type { AccessLogIndex } from './access-log.index';
import {
  inDateRange,
  parseKeptLine,
  parseRawConfig,
  processLogs,
  retainedFrom,
  windowBounds,
} from './access-log.parser';
import type { DateRange, LogEntry } from './access-log.parser';

/** Traefik's access log next to the dynamic config it watches. */
export const accessLogPath = () =>
  path.join(dynamicTraefikDirectory(), 'access.log');

/**
 * The unfiltered view's cap: the newest 500 lines rather than the oldest.
 *
 * It caps the *unfiltered* view only. A caller that sends a date range is
 * bounded by the range instead, because that is the number the row count and the
 * pager under the table have to agree with: capping a ranged read would make
 * `totalCount` a count of what was read rather than of the traffic in the
 * window, which is the same lie in a new place.
 */
export const UNFILTERED_LINE_LIMIT = 500;

/** 64 KiB a time: a few hundred access-log lines, one syscall. */
const TAIL_CHUNK_BYTES = 64 * 1024;

const NEWLINE = 0x0a;

/**
 * Every line of a file, **last to first**, read a chunk at a time.
 *
 * The point is that a request-analytics screen wants the end of the
 * access log and both of the reader's two modes used to start at the beginning
 * of it: the unfiltered one streamed 500 lines off the top, the ranged one read
 * the entire file into a string. Traefik appends, so the answer to every
 * question this service is asked is in the file's tail — and there is no way to
 * reach a file's tail by line except to read it backwards.
 *
 * Lazy on purpose: the caller `break`s out as soon as it has what it needs and
 * the rest of the file is never touched. That is what makes "the last hour" cost
 * the last hour instead of the log.
 *
 * The carried remainder is a `Buffer`, not a string, because a chunk boundary
 * can land in the middle of a UTF-8 sequence and decoding half of one produces a
 * replacement character that never comes back. `0x0a` cannot occur inside a
 * multi-byte sequence, so scanning bytes for it is safe.
 */
export async function* linesFromEnd(
  logPath: string,
  chunkBytes: number = TAIL_CHUNK_BYTES,
  meter?: { bytesRead: number },
): AsyncGenerator<string> {
  const handle = await fs.promises.open(logPath, 'r');
  try {
    const size = (await handle.stat()).size;
    let position = size;
    // The head of the chunk just read, when no newline preceded it: the tail of a
    // line whose beginning is in a chunk we have not read yet.
    let carry = Buffer.alloc(0);

    while (position > 0) {
      const length = Math.min(chunkBytes, position);
      position -= length;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, position);
      if (meter) meter.bytesRead += length;

      const chunk = carry.length > 0 ? Buffer.concat([buffer, carry]) : buffer;
      let lineEnd = chunk.length;
      for (let at = chunk.length - 1; at >= 0; at -= 1) {
        if (chunk[at] === NEWLINE) {
          yield chunk.subarray(at + 1, lineEnd).toString('utf8');
          lineEnd = at;
        }
      }
      carry = chunk.subarray(0, lineEnd);
    }

    // Whatever is left is the first line of the file, which no newline precedes.
    // Guarded on the size and not on the carry, so that a file whose first line
    // is empty still has one: an empty file has no lines, a file that is one
    // newline has two, and `String.split` is the arbiter of the difference.
    if (size > 0) yield carry.toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * One read of a window of the log, and what it cost.
 *
 * The cost is part of the answer because the whole problem was that the cost
 * used to be the file. A test that only checks the rows cannot tell a seek from
 * a walk that happened to filter correctly.
 */
export interface AccessLogWindow {
  /** The kept lines, oldest first, newline-terminated — what a caller parses. */
  raw: string;
  /** Byte offset the read began at. Non-zero is the index having done its job. */
  fromOffset: number;
  /** Bytes of the log this read touched, `fromOffset` onwards. */
  bytesRead: number;
  /** Bytes the index had to scan to serve this read. 0 once it is warm. */
  bytesIndexed: number;
  /**
   * The oldest hour the log still holds, set only when the window reached back
   * past it *and* older hours are known to have been rotated away. The console
   * must say "the log only goes back to here" rather than present an empty
   * window as a quiet hour.
   */
  retainedFrom?: string;
}

export interface ReadStatsLogsInput {
  page?: { pageIndex: number; pageSize: number };
  sort?: { id: string; desc: boolean };
  /** Matched against `RequestHost` first, then path/service name. */
  search?: string;
  status?: string[];
  /** HTTP verbs; any of them matches, case-insensitively. */
  method?: string[];
  dateRange?: DateRange;
}

/**
 * Request analytics over the local Traefik access log: the log reader plus
 * the two request queries, {@link AccessLogService.getStatsLogs} and
 * {@link AccessLogService.getStats}, backed by the pure parsers in
 * access-log.parser.ts.
 *
 * There is one access log on the instance and every organization's traffic
 * is in it, so both queries take instance authority;
 * {@link AccessLogService.getStatsLogs} carries the reasoning (H-64, ADR-0013).
 */
@Injectable()
export class AccessLogService {
  constructor(private readonly permissions: PermissionService) {}

  /**
   * The hour index per log path, so a second query in the same process pays
   * nothing for it. The map is keyed by path because tests point the reader at
   * temp logs, and a stale index for the wrong file is the one thing an index
   * must not have.
   */
  private readonly indexes = new Map<string, AccessLogIndex>();

  /**
   * Whether the platform host's Traefik has request logging on: its
   * traefik.yml carries an `accessLog` block, read the way a Server's is
   * (`accessLogOn`). No traefik.yml is logging off. Asked by the Requests
   * read so a reader who cannot switch it is told it is off (ADR-0061),
   * rather than shown "0 requests".
   */
  loggingOn(
    configPath: string = path.join(mainTraefikDirectory(null), 'traefik.yml'),
  ): boolean {
    if (!fs.existsSync(configPath)) return false;
    return accessLogOn(fs.readFileSync(configPath, 'utf8'));
  }

  /**
   * One in-flight index update per path. Two concurrent ranged reads on a cold
   * index would otherwise both scan the whole log.
   */
  private readonly indexing = new Map<string, Promise<AccessLogIndex>>();

  /**
   * Read the access log from its end rather than its start, *seeking*
   * into it rather than walking it.
   *
   * Two modes, and the date range is what picks between them — not a `readAll`
   * boolean, which is how the two callers came to disagree about when to set it
   * (`start && end` in one, `start || end` in the other) and how "the whole
   * file" became a mode at all:
   *
   * - **No range**: the newest `UNFILTERED_LINE_LIMIT` valid lines, read
   *   backwards from the end. Previously the *oldest* 500, which
   *   `parseRawConfig` then sorted newest-first, so a screen opened with no
   *   filter presented the log's opening minutes as the recent past. No index is
   *   consulted: the newest 500 lines are the last few chunks of the file, and
   *   building an index to find the end of a file would be absurd.
   * - **A range**: the hour index says which byte the window's first hour starts
   *   at and where its last hour's last line ends (`endOffsetFor`), and the read
   *   runs *forward* between the two. Both ends of the read are bounded by the
   *   window, and both are exact — including for a request that started inside
   *   the window and was written long after it, because Traefik writes a line
   *   when its request finishes. The earlier reader could only
   *   bound one of them — backwards from the end it could stop when it went past
   *   the window's start, which left a window whose start preceded the log
   *   walking the whole log, and left page 2 re-walking what page 1 walked.
   *
   * Both modes return only lines this service would keep: valid JSON objects
   * that are not the dashboard's own traffic, in **file order** (oldest first),
   * so the result reads as a slice of the log.
   *
   * The residual cost is one forward pass per log to build the index, not one
   * per query — and `TraefikFilesService.rotateAccessLog` is what bounds *that*,
   * because Traefik 3.x cannot bound the file itself (see its comment).
   */
  async readWindow(
    dateRange?: DateRange,
    logPath: string = accessLogPath(),
  ): Promise<AccessLogWindow | null> {
    if (!fs.existsSync(logPath)) return null;

    const ranged = !!dateRange?.start || !!dateRange?.end;
    return ranged
      ? this.readRangedWindow(dateRange, logPath)
      : this.readNewest(logPath);
  }

  /**
   * `readWindow` for the callers that only want the lines — the earlier
   * signature, kept so that "the raw access log as a string" stays one thing.
   */
  async readAccessLog(
    dateRange?: DateRange,
    logPath: string = accessLogPath(),
  ): Promise<string | null> {
    const window = await this.readWindow(dateRange, logPath);
    return window === null ? null : window.raw;
  }

  /** The newest `UNFILTERED_LINE_LIMIT` kept lines, backwards from the end. */
  private async readNewest(logPath: string): Promise<AccessLogWindow> {
    const size = fs.statSync(logPath).size;
    const meter = { bytesRead: 0 };
    const kept: string[] = [];

    for await (const line of linesFromEnd(logPath, undefined, meter)) {
      if (parseKeptLine(line) === null) continue;
      kept.push(line.trim());
      if (kept.length >= UNFILTERED_LINE_LIMIT) break;
    }

    return {
      raw: kept.length === 0 ? '' : `${kept.reverse().join('\n')}\n`,
      fromOffset: Math.max(0, size - meter.bytesRead),
      bytesRead: meter.bytesRead,
      bytesIndexed: 0,
    };
  }

  /** Every kept line inside the window, seeking to the window's first hour. */
  private async readRangedWindow(
    dateRange: DateRange,
    logPath: string,
  ): Promise<AccessLogWindow> {
    const index = await this.indexFor(logPath);
    const { startsAt, endsAt } = windowBounds(dateRange);

    const fromOffset = seekOffsetFor(index, startsAt);
    const toOffset = endOffsetFor(index, startsAt, endsAt);
    const meter = { bytesRead: 0 };
    const kept: string[] = [];

    if (toOffset > fromOffset) {
      for await (const line of completeLinesFrom(
        logPath,
        fromOffset,
        undefined,
        meter,
      )) {
        if (line.offset >= toOffset) break;
        const log = parseKeptLine(line.text);
        // A line with no usable timestamp is in no window.
        if (log === null || !log.StartUTC) continue;
        if (inDateRange(log.StartUTC, dateRange)) kept.push(line.text.trim());
      }
    }

    return {
      raw: kept.length === 0 ? '' : `${kept.join('\n')}\n`,
      fromOffset,
      bytesRead: meter.bytesRead,
      bytesIndexed: index.bytesScanned,
      retainedFrom: retainedFrom(index.droppedBefore, startsAt),
    };
  }

  /**
   * The hour index for a log: from memory, else from disk, extended over
   * whatever has been appended since. Persisted so that the first ranged read
   * after a restart still seeks (`indexPathFor` explains why it is not a
   * `.json`).
   */
  private async indexFor(logPath: string): Promise<AccessLogIndex> {
    const running = this.indexing.get(logPath);
    if (running) return running;

    const update = (async () => {
      const previous =
        this.indexes.get(logPath) ?? loadAccessLogIndex(logPath) ?? undefined;
      const index = await readAccessLogIndex(logPath, previous);
      this.indexes.set(logPath, index);
      if (index.bytesScanned > 0 || previous === undefined) {
        saveAccessLogIndex(logPath, index);
      }
      return index;
    })();

    this.indexing.set(logPath, update);
    try {
      return await update;
    } finally {
      this.indexing.delete(logPath);
    }
  }

  /**
   * The raw request rows, filtered, sorted and paged — instance authority
   * (H-64).
   *
   * **There is one access log.** `accessLogPath()` is the platform Traefik's
   * own file, and that Traefik fronts every organization's Domain on the
   * instance, so a row in it can belong to anybody: its `RequestHost`,
   * `RequestPath` and `ServiceName` name another organization's hostnames, URLs
   * and services outright. The route used to take no caller at all — no
   * `@CurrentUser`, no gate — so every signed-in member of every organization
   * read the whole instance's traffic.
   *
   * This is the read ADR-0013's *"reads move with writes, on this surface"*
   * consequence is about, and it is the case that consequence was written for:
   * "a read is cheaper than a write" is false when the disclosure **is** the
   * attack. `GET /settings/traefik/requests` is not a precedent for leaving it
   * open either — that answers one boolean about whether logging is on, and
   * this answers what was logged.
   *
   * {@link getStats} below is the sibling and the model: same file, same
   * question, one boundary. It is asked here rather than in the controller so
   * that a caller reaching the service directly gets the same refusal, which is
   * where the gate already lived for `getStats`.
   */
  async getStatsLogs(
    ctx: PermissionCtx,
    input: ReadStatsLogsInput,
  ): Promise<{
    data: LogEntry[];
    totalCount: number;
    /** See `AccessLogWindow.retainedFrom` — absent when the window is covered. */
    retainedFrom?: string;
  }> {
    await this.permissions.checkInstanceAuthority(ctx);
    const window = await this.readWindow(input.dateRange);
    const parsed = parseRawConfig(
      window?.raw ?? '',
      input.page,
      input.sort,
      input.search,
      input.status,
      input.dateRange,
      input.method,
    );
    return window?.retainedFrom
      ? { ...parsed, retainedFrom: window.retainedFrom }
      : parsed;
  }

  /**
   * Requests per UTC hour — instance authority, and it moved here from
   * owner/admin (H-64).
   *
   * This route was the *gated* one of the pair, and gating it on the caller's
   * role in their **own** organization was the wrong question for a file no
   * organization owns: an owner of a second organization, never a member of the
   * first, was answered with the instance's hourly request volume. That is
   * H-51's shape one notch quieter — the counts disclose less than
   * {@link getStatsLogs}'s rows, but they are the same instance-wide file read
   * by the same caller who should not have it.
   *
   * So the pair takes one boundary rather than two. Leaving this at owner/admin
   * while the rows beside it took instance authority would have been a third
   * pattern on one screen: the chart and the table under it read the same log,
   * and answering them with two different authorities is how the two callers
   * came to disagree about `readAll` in the first place.
   */
  async getStats(
    ctx: PermissionCtx,
    input: { dateRange?: DateRange },
  ): Promise<{ hour: string; count: number }[]> {
    await this.permissions.checkInstanceAuthority(ctx);
    const window = await this.readWindow(input.dateRange);
    return processLogs(window?.raw ?? '', input.dateRange);
  }
}
