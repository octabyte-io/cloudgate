import { clockTime } from "@/lib/format/time";

import type { LogsSince } from "./gateways";
import type { DialParams, LogResume } from "./socket-stream-store";

/**
 * How a Docked log picks up after its socket drops: keep the lines it
 * holds, mark where it reconnected, and skip whatever the redial sends again.
 *
 * The gateways do not resume. `/listen-deployment` replays the build log from
 * its first line (`tail -n +1 -f`) and `/docker-container-logs` replays its
 * `--tail`, so a redial that kept its lines and took every frame would show
 * them twice. What differs is how much comes back and how to know a line is
 * one already held, so there is one policy per kind of log:
 *
 * - `replay`: the log is a file read from the start, so the first `n` lines of
 *   a redial are the `n` already received — the Deployment log, and a
 *   Server's setup run, whose watch-dial replays the run's buffer first.
 * - `since`: the log is a container's output, which `docker logs --timestamps`
 *   stamps, so a redial asks for output since the last stamped line held and
 *   skips the held lines it gets back — the Compose and database logs.
 *
 * Everything here but the two policies is pure, for `log-resume.test.ts`.
 */
export type LogResumeKind = "replay" | "since";

/**
 * Whether a line arriving after a redial is one already held. Called once per
 * line, in order. `done` once nothing more can be: the buffer stops asking.
 */
export interface HeldLines {
  held(line: string): boolean;
  readonly done: boolean;
}

/**
 * Docker's `--timestamps` stamp: RFC3339Nano, then a space. It always leads
 * the line: a Swarm service read with its task prefix (an Application's Logs
 * tab, #1341) puts the copy after it — `<stamp> web.1@node-1    | <line>`
 * (docker/cli `service/logs.go`, `logWriter.Write`).
 */
const STAMP =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})\s/;

/**
 * A stamped line's task prefix and its padding: `<stamp> name.N@node`, the
 * spaces Docker pads every copy's context with to the widest slot number,
 * then its own `    | `.
 */
const PREFIX_PADDING = /^(\S+\s[^\s|@]+@[^\s|]*)\s+\|/;

/**
 * A line with its task prefix's padding taken out, so a line held is known
 * again after a redial whose copies pad to another width. Only the padding:
 * the message after the prefix is compared as it came.
 */
const unpadded = (line: string): string =>
  STAMP.test(line) ? line.replace(PREFIX_PADDING, "$1 |") : line;

/**
 * When Docker says a line was written, in ms, or `null` for a line it did not
 * stamp. The fraction is cut to milliseconds before parsing: nanoseconds are
 * not a format `Date.parse` promises to read.
 */
export function lineTime(line: string): number | null {
  const match = STAMP.exec(line);
  if (!match) return null;
  const [, seconds, fraction = "", zone] = match;
  const ms = fraction.slice(0, 3).padEnd(3, "0");
  const time = Date.parse(`${seconds}.${ms}${zone}`);
  return Number.isNaN(time) ? null : time;
}

/** The last stamped line held, by its stamp. */
function lastStamp(held: readonly string[]): number | null {
  for (let index = held.length - 1; index >= 0; index -= 1) {
    const time = lineTime(held[index]!);
    if (time !== null) return time;
  }
  return null;
}

/**
 * Seconds added to a redial's `since`. The duration is counted from the
 * browser's clock and Docker applies it by the host's, so a browser a little
 * behind would otherwise ask from just after the last line held and lose what
 * came straight after it. Asking from earlier costs only lines that are then
 * skipped as held.
 */
const SINCE_SLACK_S = 5;

/**
 * `since` for a container redial: the time since the last stamped line held,
 * rounded up to whole seconds, plus {@link SINCE_SLACK_S}. The gateway takes
 * only a relative duration (`isValidSince`), not a timestamp, so this is as
 * close to "since that line" as it can be asked. `null` when no line held has
 * a stamp, and the redial asks what the page asked.
 */
export function sinceFor(
  held: readonly string[],
  now: number,
): LogsSince | null {
  const last = lastStamp(held);
  if (last === null) return null;
  const seconds = Math.max(1, Math.ceil((now - last) / 1000));
  return `${seconds + SINCE_SLACK_S}s`;
}

/** A replay from the start: its first `count` lines are the ones held. */
export function heldUpTo(count: number): HeldLines {
  let left = count;
  return {
    held() {
      if (left <= 0) return false;
      left -= 1;
      return true;
    },
    get done() {
      return left <= 0;
    },
  };
}

/**
 * A container redial asked from before the last stamped line held: a line is
 * held if it is one of the lines held, word for word, stamp included. Not
 * "anything older than the last line held" — a Swarm service's replicas
 * interleave, and a replica's line stamped a moment earlier may be one this
 * log never had. Done at the first line stamped after everything held, since
 * nothing after it can have been. With no stamp to go by, done at the first
 * line not held. A task prefix's padding is not part of the comparison.
 */
export function heldSince(held: readonly string[]): HeldLines {
  const lines = new Set(held.map(unpadded));
  const last = lastStamp(held);
  let done = held.length === 0;
  return {
    held(line) {
      if (done) return false;
      if (lines.has(unpadded(line))) return true;
      const time = lineTime(line);
      if (last === null || (time !== null && time > last)) done = true;
      return false;
    },
    get done() {
      return done;
    },
  };
}

/** The marked line a redial leaves where the log picked up again. */
export function reconnectedLine(when: Date): string {
  return `↻ Reconnected at ${clockTime(when.getTime())}`;
}

/**
 * The most lines `/docker-container-logs` sends for its `tail`
 * (`isValidTail`). A redial asks `since` the last line held and wants all of
 * it, not the page's last 200.
 */
const MAX_TAIL = 10_000;

/** The policy for a kind of log, as `SocketStreamStore` takes it. */
export function logResume(kind: LogResumeKind): LogResume {
  if (kind === "replay") {
    return { held: (_lines, received) => heldUpTo(received) };
  }
  return {
    params: (lines, now): DialParams | null => {
      const since = sinceFor(lines, now);
      return since ? { since, tail: MAX_TAIL } : null;
    },
    held: (lines) => heldSince(lines),
  };
}
