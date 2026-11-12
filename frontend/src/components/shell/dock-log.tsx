import { useEffect, useState, useSyncExternalStore } from "react";

import { LinkButton } from "@/components/console/link-button";
import {
  LogWell,
  toLogLines,
  type LogLine,
} from "@/components/console/log-well";
import { Button } from "@/components/ui/button";
import { Icon } from "@/lib/design/icons";
import { counted } from "@/lib/format/plural";
import { clockTime } from "@/lib/format/time";
import type { LiveLog, LiveLogSnapshot } from "@/lib/realtime/live-log";
import { useLiveLog } from "@/lib/realtime/use-socket-stream";
import { cn } from "@/lib/utils";

import { useDockView } from "./dock-state";

/**
 * A Docked log's tab and its body: what a Docked log looks like in the Dock.
 * `dock-tabs.tsx` places the tab in the "Logs n/4" group; `dock-panel.tsx`
 * draws the body for the active one.
 */

function subscribeVisibility(listener: () => void): () => void {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}
const documentShown = () => document.visibilityState !== "hidden";
const shownOnServer = () => true;

/**
 * Tell a docked log whether anyone can see it. Its body is drawn only while it
 * is the active tab, so it is on screen while drawn, the Dock is not minimised
 * and the browser tab is not hidden. Only the cloud Runtime log's poll acts on
 * it, pausing off screen; a socket stays connected.
 */
function useOnScreen(log: LiveLog): void {
  const view = useDockView();
  const shown = useSyncExternalStore(
    subscribeVisibility,
    documentShown,
    shownOnServer,
  );
  const onScreen = shown && view !== "minimised";
  useEffect(() => {
    log.setOnScreen(onScreen);
  }, [log, onScreen]);
  // Another tab in front, or the Dock gone: the body goes, and so does the log.
  useEffect(() => () => log.setOnScreen(false), [log]);
}

/** Where a docked log's body is drawn; what the Dock's `show` focuses in it. */
export const DOCK_LOG_ATTRIBUTE = "data-dock-log";

/**
 * On the page note's **Show the Dock**, naming its log: where ⌃` from inside
 * the Dock gives focus back to once the Dock button that had it is gone.
 */
export const DOCK_RETURN_ATTRIBUTE = "data-dock-return";

/** A log's tab name: what the page called it, else its key. */
export function logName(log: LiveLog): string {
  return log.about?.name ?? log.key;
}

type Mark = "running" | "finished" | "failed" | "stopped";

/** The status mark before a log's name. Each one also says it in words. */
const MARK: Record<Mark, { glyph: string; label: string; className: string }> =
  {
    running: {
      glyph: "●",
      label: "Running",
      className: "text-ok motion-safe:animate-pulse",
    },
    finished: { glyph: "✓", label: "Finished", className: "text-ok" },
    failed: { glyph: "✕", label: "Failed", className: "text-bad" },
    stopped: { glyph: "⊘", label: "Stopped", className: "text-tx-3" },
  };

function markOf(stream: LiveLogSnapshot): Mark {
  if (stream.ending) return stream.ending.mark;
  if (stream.resting) return stream.resting.mark;
  return stream.live ? "running" : "stopped";
}

/** The end word after a log's name, where a shell says "The shell exited". */
function endWordOf(stream: LiveLogSnapshot): string | null {
  if (stream.ending) return stream.ending.words;
  if (stream.resting) return stream.resting.words;
  return stream.live ? null : "Not following";
}

/**
 * One Docked log's tab: the lines icon, a status mark with its label, the
 * name, and the end word once it has ended. A failed log is underlined in red
 * as well as marked ✕ — the failure stands out, and never by hue alone.
 *
 * A tab not in front says "+N new lines": the lines its log was given since
 * the tab was last active. A count of what already arrived, so no timer and no
 * read of its own.
 */
export function DockLogTab({
  log,
  selected,
  onSelect,
  onClose,
  onKeyDown,
}: {
  log: LiveLog;
  selected: boolean;
  onSelect: () => void;
  onClose: () => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
}) {
  const stream = useLiveLog(log);
  const name = logName(log);
  const mark = MARK[markOf(stream)];
  const ended = endWordOf(stream);
  const failed = stream.ending?.mark === "failed";

  // How many lines it had when last in front. Kept up while it is, and
  // brought down when a redial starts the count again.
  const [seen, setSeen] = useState(stream.received);
  if ((selected && seen !== stream.received) || stream.received < seen) {
    setSeen(stream.received);
  }
  const fresh = selected ? 0 : stream.received - seen;

  return (
    <span
      role="presentation"
      className={cn(
        "flex h-7 max-w-64 min-w-0 shrink-0 items-center rounded-md border-b-2",
        failed ? "border-bad" : "border-transparent",
        selected ? "bg-panel text-tx shadow-panel" : "text-tx-2 hover:bg-raise",
      )}
    >
      <button
        type="button"
        role="tab"
        data-tab={log.id}
        aria-selected={selected}
        tabIndex={selected ? 0 : -1}
        title={ended ? `${name} — ${ended}` : name}
        onClick={onSelect}
        onKeyDown={onKeyDown}
        className="flex h-full min-w-0 items-center gap-1.5 pr-1 pl-2.5 text-ui outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        <Icon name="lines" size={13} className="shrink-0 text-tx-3" />
        <span
          role="img"
          aria-label={mark.label}
          className={cn("shrink-0 text-meta", mark.className)}
        >
          {mark.glyph}
        </span>
        <span className={cn("min-w-0 truncate", selected && "font-medium")}>
          {name}
        </span>
        {ended ? (
          <span
            className={cn(
              "shrink-0 text-meta",
              failed ? "text-bad" : "text-tx-2",
            )}
          >
            {ended}
          </span>
        ) : null}
        {fresh > 0 ? (
          <span className="shrink-0 text-meta text-tx-2">
            +{counted(fresh, "new line", "new lines")}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        aria-label={`Close ${name}`}
        title={`Close ${name}. This ends the log here; what it shows carries on.`}
        onClick={onClose}
        className="mr-0.5 grid size-5 shrink-0 place-items-center rounded text-tx-3 hover:bg-raise hover:text-tx"
      >
        <Icon name="x" size={12} />
      </button>
    </span>
  );
}

/**
 * The log's own lines — where it reconnected — drawn as its own, not in the
 * page's tones: the page's map knows the source's lines, and these are not.
 * The line says what it is in words; the tone only sets it apart.
 */
function withMarks(
  lines: readonly LogLine[],
  marked: readonly number[],
): readonly LogLine[] {
  if (marked.length === 0) return lines;
  const out = [...lines];
  for (const index of marked) {
    const line = out[index];
    if (line) out[index] = { text: line.text, tone: "hl" };
  }
  return out;
}

/**
 * The active Docked log, filling the Dock's width and height, over its follow
 * bar. The lines are the Live log's, toned by the page's own map; following
 * is its flag, so a log paused on its page is paused here.
 *
 * **No key handlers.** The scroller is the browser's: the arrow keys, Page
 * Up/Down, Space, Home and End scroll it, Tab moves on, Escape does nothing,
 * and Find searches its lines. Reaching the bottom — End, or a scroll —
 * starts following again (`LogWell`), which is what Jump to latest does.
 */
export function DockLogBody({ log }: { log: LiveLog }) {
  const stream = useLiveLog(log);
  const toLines = log.about?.toLines ?? toLogLines;
  const lines = withMarks(stream.toned ?? toLines(stream.lines), stream.marked);
  useOnScreen(log);

  return (
    <div
      {...{ [DOCK_LOG_ATTRIBUTE]: log.id }}
      className="flex min-h-0 flex-1 flex-col"
    >
      {stream.ending && !stream.ending.refused ? (
        /* How it ended, in the source's own sentence — a setup run that
           ended while the log was disconnected says so, with the outcome
           stored on its Server. Above the well, which holds only lines. A
           refusal is said in the follow bar, where a docked shell says it. */
        <p className="px-3 py-1.5 text-meta text-tx-2">
          {stream.ending.sentence}
        </p>
      ) : null}
      <LogWell
        fill
        label={logName(log)}
        lines={lines}
        live={stream.live && stream.status === "open" && !stream.resting}
        dropped={stream.dropped}
        following={stream.following}
        onFollowingChange={stream.setFollowing}
        className="min-h-0 flex-1"
      />
      <DockFollowBar log={log} stream={stream} />
    </div>
  );
}

/**
 * Under a docked log, where a docked shell has its status line, and always
 * there: whether it is following, how many lines it has and when the last
 * came in, with Pause; once scrolled up, how many have come in below since,
 * with Jump to latest. Go to its page returns to the page it was docked from.
 *
 * A log that has ended has nothing left to follow, so its bar keeps the count
 * and drops Pause; how it ended is on its tab. One that lost access, or whose
 * target went, says so here instead, in a Docked shell's own refusal
 * sentence — the gateway's words first, then the tense — and keeps Go to its
 * page: a new dial is the page's to make (Read it here too). A finished log
 * docked as its stored record (`StoredLog`) offers **Reload** here too, which
 * reads the record again and never dials. A resting one (a stopped
 * database) drops the "● Following" as it drops the cursor, and keeps Pause:
 * its socket stays, and lines come in again once the source runs.
 */
function DockFollowBar({
  log,
  stream,
}: {
  log: LiveLog;
  stream: LiveLogSnapshot;
}) {
  const last =
    stream.lastLineAt === null
      ? ""
      : ` · last line ${clockTime(stream.lastLineAt)}`;

  return (
    <div
      data-follow-bar
      className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line bg-panel-2 px-3.5 py-2"
    >
      {stream.ending?.refused ? (
        <p
          role="status"
          className="min-w-0 flex-1 text-meta text-tx-2 wrap-anywhere"
        >
          {stream.ending.sentence}
        </p>
      ) : stream.following ? (
        <>
          <p className="min-w-0 flex-1 text-meta text-tx-2">
            {stream.live && !stream.resting ? (
              <>
                <span aria-hidden="true" className="text-ok">
                  ●
                </span>{" "}
                Following ·{" "}
              </>
            ) : null}
            {counted(stream.received, "line", "lines")}
            {last}
          </p>
          {stream.live ? (
            <Button
              size="xs"
              title="Stop the log moving. New lines keep arriving below."
              onClick={() => log.setFollowing(false)}
            >
              Pause
            </Button>
          ) : null}
        </>
      ) : (
        <>
          <p className="min-w-0 flex-1 text-meta text-tx-2">
            Paused · {counted(stream.newBelow, "new line", "new lines")} below
          </p>
          <Button size="xs" onClick={() => log.setFollowing(true)}>
            Jump to latest
          </Button>
        </>
      )}
      {log.reloadable ? (
        <Button
          size="xs"
          disabled={stream.reading}
          title="Read the stored log again. Its lines are replaced by what is read."
          onClick={log.reload}
        >
          <Icon name="refresh" size={13} />
          {stream.reading ? "Reading…" : "Reload"}
        </Button>
      ) : null}
      {log.page ? (
        <LinkButton size="xs" variant="qt" href={log.page}>
          Go to its page
        </LinkButton>
      ) : null}
    </div>
  );
}
