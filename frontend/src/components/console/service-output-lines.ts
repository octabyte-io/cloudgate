import { clockTime } from "@/lib/format/time";
import type { LogLine } from "@/lib/realtime/log-line";
import { lineTime } from "@/lib/realtime/log-resume";

import { stripTerminalEscapes } from "./terminal-escapes";

/** The stamp `--timestamps` puts first, and the space after it. */
const STAMP = /^\S+\s/;

/**
 * What follows the stamp when `docker service logs --timestamps` keeps its
 * task prefix (`--no-task-ids`, so the copy is `name.N`):
 * `web.1@node-1    | <line>`. Docker pads the context after the node name to
 * the widest slot number, then writes `    | ` (docker/cli
 * `service/logs.go`, `taskFormatter.format` and `logWriter.Write`).
 */
const PREFIXED = /^([^\s|@]+)@[^\s|]*\s+\| ?(.*)$/;

type Parsed = { at: number | null; line: LogLine };

function parse(raw: string): Parsed {
  const text = raw.replace(/\r$/, "");
  const at = lineTime(text);
  if (at === null) return { at, line: { text: stripTerminalEscapes(text) } };
  const unstamped = text.replace(STAMP, "");
  const prefixed = PREFIXED.exec(unstamped);
  const [copy, rest] = prefixed
    ? [prefixed[1], prefixed[2]!]
    : [null, unstamped];
  const message = stripTerminalEscapes(rest);
  return {
    at,
    line: {
      ts: clockTime(at),
      text: copy ? `[${copy}] ${message}` : message,
    },
  };
}

/**
 * A Swarm service's lines as the well draws them: every running copy merged
 * by time, each line naming its copy, the time in its own column (#1341,
 * CONTEXT.md **Runtime log**). Docker follows the copies side by side, but it
 * reads each one's tail on its own, so a first read arrives a copy at a time.
 *
 * **Only runs of stamped lines are reordered.** A line Docker did not stamp —
 * the daemon's own error, the Live log's `↻ Reconnected at …` — stays at its
 * index and nothing is merged across it: the Dock marks its own lines by
 * position, and a reconnect is a point in the log, not a time to sort by.
 * One line in, one line out, for the same reason.
 */
export function toCopyLines(lines: readonly string[]): LogLine[] {
  const parsed = lines.map(parse);
  const out: LogLine[] = [];
  let run: Parsed[] = [];
  const flush = () => {
    // `Array.prototype.sort` is stable, so lines written in the same
    // millisecond keep the order Docker sent them in.
    run.sort((a, b) => a.at! - b.at!);
    for (const entry of run) out.push(entry.line);
    run = [];
  };
  for (const entry of parsed) {
    if (entry.at === null) {
      flush();
      out.push(entry.line);
    } else {
      run.push(entry);
    }
  }
  flush();
  return out;
}
