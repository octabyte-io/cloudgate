import type { LogLine } from "@/components/console/log-well";
import { stripTerminalEscapes } from "@/components/console/terminal-escapes";
import type {
  RuntimeLogLine,
  RuntimeLogSource,
} from "@/lib/api/endpoints/applications";

/** How many lines the log tab holds before the oldest fall off. */
export const RUNTIME_LOG_HELD = 2_000;

/** How many characters of a copy's id (an ECS task's, a Cloud Run instance's) name it on a line. */
const TASK_CHARS = 8;

/**
 * How far back a read reaches, whatever `since` asks: the backend's
 * `RUNTIME_LOG_LOOKBACK_MS` (`project-config/runtime-log/runtime-log.ts`).
 */
export const RUNTIME_LOG_LOOKBACK_MS = 60 * 60_000;

/** A span of the log no read covered: from the cursor to the lookback's start. */
export interface UnreadSpan {
  from: number;
  to: number;
}

/**
 * A held line: a line read, or the one marked line a docked log leaves where
 * it was paused past the lookback (`unread`).
 */
export interface HeldRuntimeLine extends RuntimeLogLine {
  unread?: UnreadSpan;
}

export interface HeldRuntimeLog {
  lines: readonly HeldRuntimeLine[];
  /** How many lines fell off the front. */
  dropped: number;
}

/**
 * What a read made `now` from cursor `since` can no longer reach: the backend
 * starts no further back than its lookback, so a log paused longer than that
 * skips from `since` to `now - lookback`. `null` when nothing is skipped, or
 * before a first read has given a cursor.
 */
export function unreadSpan(
  since: number | undefined,
  now: number,
  lookback = RUNTIME_LOG_LOOKBACK_MS,
): UnreadSpan | null {
  if (since === undefined) return null;
  const to = now - lookback;
  return to > since ? { from: since, to } : null;
}

/**
 * The held lines with one marked line naming a span that was not read. It is
 * placed where the next read starts, so it sits between what was held and
 * what comes after; it is not filled and not hidden.
 */
export function withUnreadSpan(
  held: HeldRuntimeLog,
  span: UnreadSpan,
  cap = RUNTIME_LOG_HELD,
): HeldRuntimeLog {
  const marked: HeldRuntimeLine = {
    id: `unread:${span.from}-${span.to}`,
    at: span.to,
    task: "",
    message: unreadSentence(span),
    unread: span,
  };
  return mergeRuntimeLines(held, [marked], cap);
}

function unreadSentence(span: UnreadSpan): string {
  return `Lines between ${clock(span.from, false)} and ${clock(span.to, false)} were not read.`;
}

/**
 * One poll's lines into what the tab holds. Each read starts a few
 * seconds back, for lines CloudWatch takes in late, so a line already held is
 * read again and kept once, by its id; a late one goes in its place by time,
 * with every task's lines merged as the backend merges them.
 */
export function mergeRuntimeLines(
  held: HeldRuntimeLog,
  incoming: readonly HeldRuntimeLine[],
  cap = RUNTIME_LOG_HELD,
): HeldRuntimeLog {
  const seen = new Set(held.lines.map((line) => line.id));
  const fresh = incoming.filter((line) => !seen.has(line.id));
  if (fresh.length === 0) return held;
  const merged = [...held.lines, ...fresh].sort(
    (a, b) =>
      a.at - b.at || a.task.localeCompare(b.task) || a.id.localeCompare(b.id),
  );
  const over = Math.max(0, merged.length - cap);
  return { lines: merged.slice(over), dropped: held.dropped + over };
}

/** How a Cloud Run line is marked by what wrote it. */
const SOURCE_MARK: Record<RuntimeLogSource, string> = {
  stdout: "stdout",
  stderr: "stderr",
  app: "app",
  "cloud-run": "Cloud Run",
};

/**
 * The well's lines: the local time, then the copy by the start of its id. A
 * Cloud Run line also names its revision by its number and suffix, and is
 * marked by what wrote it.
 */
export function toRuntimeLogLines(
  lines: readonly HeldRuntimeLine[],
): LogLine[] {
  return lines.map((line) =>
    line.unread
      ? { text: line.message, tone: "warn" }
      : {
          ts: clock(line.at),
          text: `${labelOf(line)} ${stripTerminalEscapes(line.message)}`,
        },
  );
}

function labelOf(line: RuntimeLogLine): string {
  const copy = line.task.slice(0, TASK_CHARS);
  if (!line.source) return `[${copy}]`;
  const names = [copy, line.revision ? revisionOf(line.revision) : ""]
    .filter(Boolean)
    .join(" ");
  return `${names ? `[${names}] ` : ""}${SOURCE_MARK[line.source]}:`;
}

/** `00002-xyz` from `cloudgate-abc-00002-xyz`: Cloud Run's revision number and suffix. */
function revisionOf(revision: string): string {
  return /\d{5}-[a-z0-9]+$/.exec(revision)?.[0] ?? revision;
}

function clock(at: number, seconds = true): string {
  const time = new Date(at);
  const parts = [time.getHours(), time.getMinutes(), time.getSeconds()];
  return (seconds ? parts : parts.slice(0, 2))
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}
