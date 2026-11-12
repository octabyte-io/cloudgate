import * as React from "react";

import { Button } from "@/components/ui/button";
import type { LogLine, LogTone } from "@/lib/realtime/log-line";
import { cn } from "@/lib/utils";

import { stripTerminalEscapes } from "./terminal-escapes";

export type { LogLine, LogTone } from "@/lib/realtime/log-line";

const TONE: Record<LogTone, string> = {
  ok: "text-well-ok",
  warn: "text-well-warn",
  bad: "text-well-bad",
  hl: "text-well-hl font-medium",
  dim: "opacity-62",
};

/**
 * Plain lines off a socket, as lines. `useSocketStream` hands back
 * `readonly string[]`; a screen that knows its own log format maps that to
 * tones and timestamps itself, because "what counts as a warning" is a property
 * of the tool writing the log, not of the component drawing it.
 *
 * Terminal escapes are the one thing removed whatever the tool — see
 * `terminal-escapes.ts`.
 */
export function toLogLines(lines: readonly string[]): LogLine[] {
  return lines.map((text) => ({ text: stripTerminalEscapes(text) }));
}

/** How close to the bottom still counts as following. */
const TAIL_SLACK = 24;

export type LogWellProps = {
  /** What this is a log of. "Deployment output", "Container logs". */
  label: string;
  lines: readonly LogLine[];
  /** Draw the tail cursor. On while the thing writing the log is still running. */
  live?: boolean;
  /** The stamp beside the cursor — usually the time of the last line. */
  stamp?: string;
  /** How many lines fell off the front of the buffer. From `useSocketStream`. */
  dropped?: number;
  /** Controlled follow-tail. Leave it off and the well keeps its own. */
  following?: boolean;
  onFollowingChange?: (following: boolean) => void;
  /**
   * Fill the height it is given instead of the page's fixed well — a Docked
   * log, read full width and full height, whose follow bar replaces the
   * floating "Follow output".
   */
  fill?: boolean;
  className?: string;
};

/**
 * Where output goes (e-console.html:756-780). Near-black in both themes, mono,
 * timestamps in a tabular column, and one tone per line.
 *
 * **Follow-tail detaches when the operator scrolls up**, which is the whole
 * behaviour worth getting right: someone scrolls back to read the error that
 * just went past, and a well that keeps yanking them to the bottom is a well
 * they cannot read. Scrolling back to the bottom re-attaches, and while
 * detached there is a control that says so and offers the way back.
 *
 * The cursor blinks in `steps(1)` — a caret snaps, it does not breathe — and
 * **stops** under `prefers-reduced-motion`, where the well settles into an
 * honest snapshot of a run still in progress rather than a faster flicker.
 *
 * Long lines wrap rather than scroll: `pre-wrap` keeps the whitespace a build
 * tool emitted, and `wrap-anywhere` breaks the digests and resource addresses
 * that no word boundary is ever found in. A log that scrolls sideways is a log
 * whose right-hand half nobody reads.
 */
export function LogWell({
  label,
  lines,
  live,
  stamp,
  dropped = 0,
  following: followingProp,
  onFollowingChange,
  fill = false,
  className,
}: LogWellProps) {
  const scroller = React.useRef<HTMLDivElement>(null);
  const [ownFollowing, setOwnFollowing] = React.useState(true);
  const following = followingProp ?? ownFollowing;

  // A DOM write, not a state update: the tail is a scroll position, and putting
  // it through React would mean a render per frame of a build's output.
  React.useEffect(() => {
    const node = scroller.current;
    if (!node || !following) return;
    node.scrollTop = node.scrollHeight;
  }, [lines, following]);

  function onScroll() {
    const node = scroller.current;
    if (!node) return;
    const atTail =
      node.scrollHeight - node.scrollTop - node.clientHeight <= TAIL_SLACK;
    if (atTail === following) return;
    setOwnFollowing(atTail);
    onFollowingChange?.(atTail);
  }

  function follow() {
    setOwnFollowing(true);
    onFollowingChange?.(true);
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }

  return (
    <div
      data-slot="log-well"
      className={cn("relative", fill && "flex min-h-0 flex-col", className)}
    >
      <div
        ref={scroller}
        onScroll={onScroll}
        role="log"
        aria-label={label}
        tabIndex={0}
        className={cn(
          "overflow-auto bg-well px-3.5 py-3 font-mono text-meta leading-log text-well-tx",
          fill ? "min-h-0 flex-1" : "max-h-log rounded-lg border border-line",
        )}
      >
        {dropped > 0 ? (
          <p className="mb-1.5 text-well-ts">
            {dropped} earlier {dropped === 1 ? "line" : "lines"} dropped to stay
            inside the buffer.
          </p>
        ) : null}
        {lines.map((line, index) => (
          <div key={index} className="flex gap-3 whitespace-pre-wrap">
            {line.ts ? (
              <span className="num flex-none text-well-ts">{line.ts}</span>
            ) : null}
            <span
              className={cn(
                "min-w-0 flex-1 wrap-anywhere",
                line.tone && TONE[line.tone],
              )}
            >
              {line.text}
            </span>
          </div>
        ))}
        {live ? (
          <div className="flex gap-3">
            {stamp ? (
              <span className="num flex-none text-well-ts">{stamp}</span>
            ) : null}
            <span className="min-w-0 flex-1">
              <span
                data-slot="log-cursor"
                aria-hidden="true"
                className="inline-block h-3.25 w-1.75 animate-blink bg-well-hl align-text-bottom"
              />
              <span className="sr-only">still running</span>
            </span>
          </div>
        ) : null}
      </div>

      {/* A Docked log says this in its follow bar instead (`dock-log.tsx`):
          one control for one thing. */}
      {following || fill ? null : (
        <Button
          size="xs"
          onClick={follow}
          className="absolute right-3 bottom-3 shadow-float"
        >
          Follow output
        </Button>
      )}
    </div>
  );
}
