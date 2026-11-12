import { useDock } from "@/components/shell/dock-context";
import { DOCK_RETURN_ATTRIBUTE } from "@/components/shell/dock-log";
import { DOCK_LOGS_FULL_SENTENCE } from "@/components/shell/dock-store";
import { Button } from "@/components/ui/button";
import { Icon } from "@/lib/design/icons";
import type { LiveLog, LiveLogSnapshot } from "@/lib/realtime/live-log";

/**
 * A log card's **Dock** control: the same word, icon and place as a page
 * shell's (`terminal-session.tsx`). Drawn only inside the console shell,
 * where the Dock exists, and only once the card has a log to hand over.
 * At the logs cap it is disabled with the reason beside it, not only in a
 * tooltip.
 *
 * `log` is the card's Live log, or — for a finished log read once over REST,
 * which has no Live log until it is docked — what builds its stored record
 * (`StoredLog`) at the press, from the lines the card read by then. A record
 * built for a key already in the Dock is not taken: the tab already there is
 * shown. `onDocked` hears every press the Dock did not refuse as full.
 */
export function LogDockButton({
  log,
  onDocked,
}: {
  log: LiveLog | (() => LiveLog) | null;
  onDocked?: () => void;
}) {
  const dock = useDock();
  if (!dock || !log) return null;
  // A builder is always a finished log's; a Live log says whether it is.
  const following = typeof log === "function" ? false : log.getSnapshot().live;
  return (
    <>
      {dock.logsFull ? (
        <span className="text-meta text-tx-2">{DOCK_LOGS_FULL_SENTENCE}</span>
      ) : null}
      <Button
        size="xs"
        disabled={dock.logsFull}
        onClick={() => {
          const taken = typeof log === "function" ? log() : log;
          if (dock.dockLog(taken) === "docked") onDocked?.();
        }}
        title={
          dock.logsFull
            ? DOCK_LOGS_FULL_SENTENCE
            : following
              ? "Move this log into a panel along the bottom of the console. It keeps following there while you go to other pages."
              : "Move this log into a panel along the bottom of the console. It stays there while you go to other pages."
        }
      >
        <Icon name="dock" size={13} />
        Dock
      </Button>
    </>
  );
}

/**
 * Where the page's log went — the Dock — in the log's place, like a docked
 * shell's `Moved` note. Read off the docked log itself, so it says what its
 * tab says: still following, or how it ended.
 *
 * **Show the Dock** brings the tab into view and puts focus in it, and is
 * where ⌃` gives focus back to once the log is docked: the Dock button that
 * had it is gone. **Read it
 * here too** opens a fresh box of the page's own beside the docked one, with
 * its own connection: closing either leaves the other alone.
 */
export function DockedLogNote({
  log,
  stream,
  onReadHere,
}: {
  log: LiveLog;
  /** The docked log's snapshot, which the page is still reading. */
  stream: LiveLogSnapshot;
  onReadHere: () => void;
}) {
  const dock = useDock();
  const closed = log.disposed;
  const docked = dock?.logs.includes(log) ?? false;
  // How it ended, else why it is writing nothing for now.
  const said = stream.ending ?? stream.resting;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel px-3.5 py-3 shadow-panel">
      <Icon name="dock" size={15} className="text-tx-2" />
      <p className="min-w-0 flex-1 text-body text-tx-2">
        {closed
          ? "This log moved to the Dock and has since been closed there."
          : said
            ? `This log is in the Dock at the bottom of the console. ${said.sentence}`
            : stream.live
              ? "This log is in the Dock at the bottom of the console, still following."
              : "This log is in the Dock at the bottom of the console."}
      </p>
      {dock && docked && !closed ? (
        <Button
          size="sm"
          {...{ [DOCK_RETURN_ATTRIBUTE]: log.id }}
          onClick={() => dock.show(log.id)}
        >
          Show the Dock
        </Button>
      ) : null}
      <Button size="sm" variant={closed ? "pri" : "gh"} onClick={onReadHere}>
        <Icon name="lines" size={14} />
        Read it here too
      </Button>
    </div>
  );
}
