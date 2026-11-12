import * as fs from 'node:fs';
import { hourBucketFor, parseKeptLine } from './access-log.parser';

/**
 * A byte index of Traefik's access log, keyed by UTC hour.
 *
 * `processLogs` has always bucketed rows by UTC hour *after* reading them; this
 * is the same bucket carried as a byte offset, which is what turns "walk the
 * file looking for the window" into a seek. The earlier reader could make a
 * ranged read stop once it had gone past the start of the window, but nothing
 * could make it start anywhere but an end of the file — so a window whose start
 * precedes the log still read the log, and page 2 read it again.
 *
 * The index is built by one forward pass and then *extended* over appended bytes
 * only, so the whole-file pass happens once per log rather than once per query.
 * It is kept on disk beside the log (see `indexPathFor`) so that a restart does
 * not buy that pass back.
 */

/** One UTC hour of the log, and where in the file it starts. */
export interface HourBucket {
  /** `2026-01-01T07:00:00Z` — the key `processLogs` counts by. */
  hour: string;
  /** Byte offset of the *first* line of this hour, in file order. */
  offset: number;
  /**
   * Byte offset just past the *last* line of this hour, in file order — which
   * can be far past the next hour's lines, because a request is written when
   * it finishes and a long one lands late. What lets a ranged read stop at the
   * last line that can be in its window instead of guessing.
   */
  end: number;
  /** Lines of this hour the reader would keep (valid, not the dashboard's). */
  lines: number;
}

export interface AccessLogIndex {
  /**
   * Bytes of the log these buckets describe: the offset just past the last
   * *complete* line. A half-written trailing line is deliberately outside it.
   */
  indexedBytes: number;
  /** Identity of the file the offsets point into — see `fingerprintOf`. */
  fingerprint: string;
  /** Buckets, ascending by hour. Offsets need not ascend with them. */
  hours: HourBucket[];
  /** Bytes this update actually read. 0 when the log has not grown. */
  bytesScanned: number;
  /** Whether this update had to throw the previous index away and rebuild. */
  rotated: boolean;
  /**
   * The oldest hour the log still holds, when older hours are known to have
   * been rotated (or truncated) away. What lets a read that reaches back past
   * the file say so, instead of answering "no traffic".
   */
  droppedBefore?: string;
}

/** 64 KiB at a time, like the tail reader. */
const SCAN_CHUNK_BYTES = 64 * 1024;

const NEWLINE = 0x0a;

/**
 * Where the index for a log lives.
 *
 * **Not** `.json`, `.yml`, `.yaml` or `.toml`: the access log sits inside
 * Traefik's `dynamic/` directory, and its file provider tries to parse every
 * config-shaped file it finds there. `.hours` is inert to it, like `.log`.
 */
export function indexPathFor(logPath: string): string {
  return `${logPath}.hours`;
}

/**
 * Is this still the same file the offsets were measured in?
 *
 * Three ways the answer is no, and rotation is only the first: the log is
 * renamed away and Traefik reopens a fresh one on SIGUSR1 (new inode); it is
 * truncated in place (same inode, smaller); or it is replaced by a rewritten
 * copy, which is what the log-cleanup cron's `tail -n 1000 > tmp && mv` does
 * (new inode again). The head bytes are compared as well as the inode, because
 * an inode is reused eventually and a wrong offset is worse than a rebuild.
 *
 * The head is cut at its first newline, so that it is the log's *first line* and
 * not "the first 256 bytes" — the latter keeps changing while a young log is
 * still shorter than that, and every change would force a needless rebuild.
 */
const FINGERPRINT_HEAD_BYTES = 256;

async function fingerprintOf(logPath: string): Promise<string> {
  const handle = await fs.promises.open(logPath, 'r');
  try {
    const stat = await handle.stat();
    const head = Buffer.alloc(Math.min(FINGERPRINT_HEAD_BYTES, stat.size));
    if (head.length > 0) await handle.read(head, 0, head.length, 0);
    const firstNewline = head.indexOf(NEWLINE);
    const firstLine =
      firstNewline === -1 ? head : head.subarray(0, firstNewline);
    return `${stat.ino}:${firstLine.toString('base64')}`;
  } finally {
    await handle.close();
  }
}

/** A complete line of the log, with the byte range it occupies. */
interface IndexedLine {
  text: string;
  offset: number;
  /** Offset just past this line's newline. */
  next: number;
}

/**
 * Every **complete** line of the log from `fromOffset` on, forwards.
 *
 * A trailing fragment with no newline after it is not yielded: Traefik's last
 * line is routinely half-written, and indexing it would place a bucket at an
 * offset the next append rewrites.
 */
export async function* completeLinesFrom(
  logPath: string,
  fromOffset: number,
  chunkBytes: number = SCAN_CHUNK_BYTES,
  meter?: { bytesRead: number },
): AsyncGenerator<IndexedLine> {
  const handle = await fs.promises.open(logPath, 'r');
  try {
    const size = (await handle.stat()).size;
    let position = fromOffset;
    // The tail of the chunk just read, after its last newline: the head of a
    // line whose end is in a chunk we have not read yet.
    let carry = Buffer.alloc(0);
    let carryAt = fromOffset;

    while (position < size) {
      const length = Math.min(chunkBytes, size - position);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, position);
      position += length;
      if (meter) meter.bytesRead += length;

      const chunk = carry.length > 0 ? Buffer.concat([carry, buffer]) : buffer;
      let lineStart = 0;
      for (let at = 0; at < chunk.length; at += 1) {
        if (chunk[at] !== NEWLINE) continue;
        yield {
          text: chunk.subarray(lineStart, at).toString('utf8'),
          offset: carryAt + lineStart,
          next: carryAt + at + 1,
        };
        lineStart = at + 1;
      }
      carry = chunk.subarray(lineStart);
      carryAt += lineStart;
    }
  } finally {
    await handle.close();
  }
}

/** Reads the index off disk, or null when there is none or it is unusable. */
export function loadAccessLogIndex(logPath: string): AccessLogIndex | null {
  const indexPath = indexPathFor(logPath);
  if (!fs.existsSync(indexPath)) return null;
  try {
    const parsed = JSON.parse(
      fs.readFileSync(indexPath, 'utf8'),
    ) as AccessLogIndex;
    // An index written before buckets carried `end` cannot bound a read's far
    // end, so it costs one rebuild rather than a guess.
    if (
      !Array.isArray(parsed.hours) ||
      typeof parsed.fingerprint !== 'string' ||
      !parsed.hours.every((bucket) => typeof bucket.end === 'number')
    ) {
      return null;
    }
    return { ...parsed, bytesScanned: 0, rotated: false };
  } catch {
    // A half-written or hand-edited index costs one rebuild, never an answer.
    return null;
  }
}

/**
 * Writes the index beside the log. Best effort: the index is a cache, and a
 * read-only Traefik directory must not turn a working query into a 500.
 */
export function saveAccessLogIndex(
  logPath: string,
  index: AccessLogIndex,
): void {
  // `bytesScanned` and `rotated` describe the *update*, not the file, so they
  // are meaningless once reloaded and are left out.
  const persisted = {
    indexedBytes: index.indexedBytes,
    fingerprint: index.fingerprint,
    hours: index.hours,
    droppedBefore: index.droppedBefore,
  };
  try {
    fs.writeFileSync(indexPathFor(logPath), JSON.stringify(persisted), 'utf8');
  } catch (error) {
    console.error('Could not write the access-log hour index:', error);
  }
}

/**
 * The index for a log, extending `previous` over appended bytes when it still
 * describes this file and rebuilding from the top when it does not.
 */
export async function readAccessLogIndex(
  logPath: string,
  previous?: AccessLogIndex,
): Promise<AccessLogIndex> {
  const size = fs.statSync(logPath).size;
  const fingerprint = await fingerprintOf(logPath);

  const usable =
    previous !== undefined &&
    previous.fingerprint === fingerprint &&
    size >= previous.indexedBytes;
  const rotated = previous !== undefined && !usable;

  const hours = new Map<string, HourBucket>();
  if (usable) {
    for (const bucket of previous.hours) hours.set(bucket.hour, { ...bucket });
  }

  const from = usable ? previous.indexedBytes : 0;
  let indexedBytes = from;

  for await (const line of completeLinesFrom(logPath, from)) {
    indexedBytes = line.next;
    const row = parseKeptLine(line.text);
    if (row === null) continue;
    const hour = hourBucketFor(row.StartUTC ?? '');
    if (hour === null) continue;

    const bucket = hours.get(hour);
    if (bucket === undefined) {
      hours.set(hour, {
        hour,
        offset: line.offset,
        end: line.next,
        lines: 1,
      });
      continue;
    }
    bucket.lines += 1;
    // Lines are written in completion order and bucketed by start, so an hour's
    // lines are not contiguous: the bucket spans the lowest offset and the
    // highest end it has ever seen.
    if (line.offset < bucket.offset) bucket.offset = line.offset;
    if (line.next > bucket.end) bucket.end = line.next;
  }

  const ordered = [...hours.values()].sort((a, b) =>
    a.hour < b.hour ? -1 : a.hour > b.hour ? 1 : 0,
  );

  return {
    indexedBytes,
    fingerprint,
    hours: ordered,
    bytesScanned: indexedBytes - from,
    rotated,
    droppedBefore: droppedBefore(logPath, previous, rotated, ordered),
  };
}

/**
 * The oldest hour still in the log, when something older than it has been
 * rotated or truncated away.
 *
 * Two ways to know that happened: this process watched the file be replaced, or
 * a rotated backup is sitting next to it — which is the case that matters after
 * a restart, when the index remembers nothing.
 */
function droppedBefore(
  logPath: string,
  previous: AccessLogIndex | undefined,
  rotated: boolean,
  hours: HourBucket[],
): string | undefined {
  const known = rotated || previous?.droppedBefore !== undefined;
  const evident = known || fs.existsSync(`${logPath}.1`);
  if (!evident || hours.length === 0) return undefined;
  return hours[0].hour;
}

/**
 * The byte offset a read of a window starting at `startMs` may begin at.
 *
 * The *lowest* offset of any bucket at or after the window's first hour, not
 * that hour's own offset: Traefik writes a line when its request finishes, so
 * hour H's first line can sit behind hour H+1's, and starting at H's offset
 * would then skip rows of H+1 that belong in the window. `indexedBytes` when every bucket is
 * older than the window — there is nothing indexed to read, only the tail that
 * has arrived since.
 */
export function seekOffsetFor(index: AccessLogIndex, startMs: number): number {
  if (!Number.isFinite(startMs)) return 0;
  const fromHour = hourBucketFor(new Date(startMs).toISOString());
  if (fromHour === null) return 0;

  let offset = Number.POSITIVE_INFINITY;
  for (const bucket of index.hours) {
    if (bucket.hour >= fromHour && bucket.offset < offset) {
      offset = bucket.offset;
    }
  }
  return Number.isFinite(offset) ? offset : index.indexedBytes;
}

/**
 * The byte offset a read of a window may stop at: just past the last line of
 * any hour the window covers. 0 when the window covers no indexed hour.
 *
 * **This is the platform host's stop rule for reading forwards**, and it is
 * exact. Walking forwards there is no rule a line can prove: a request that
 * started inside the window can finish — and be written — after any number of
 * requests that started after it, so a run of lines newer than the window is
 * no evidence the window is behind us. The rule this replaced stopped after
 * 100 of them and dropped every long download, long poll and WebSocket that
 * started near the end of the window. The bucket's `end` knows where the hour's
 * last line actually landed.
 */
export function endOffsetFor(
  index: AccessLogIndex,
  startMs: number,
  endMs: number,
): number {
  const fromHour = Number.isFinite(startMs)
    ? hourBucketFor(new Date(startMs).toISOString())
    : null;
  const toHour = Number.isFinite(endMs)
    ? hourBucketFor(new Date(endMs).toISOString())
    : null;

  let end = 0;
  for (const bucket of index.hours) {
    if (fromHour !== null && bucket.hour < fromHour) continue;
    if (toHour !== null && bucket.hour > toHour) continue;
    if (bucket.end > end) end = bucket.end;
  }
  return end;
}
