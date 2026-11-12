import { useEffect, useState } from "react";

import { useDock } from "@/components/shell/dock-context";
import { DOCK_SHELLS_FULL_SENTENCE } from "@/components/shell/dock-store";
import { Button } from "@/components/ui/button";
import { Icon } from "@/lib/design/icons";
import { useTerminalChannel } from "@/lib/realtime/gateways";

import { LiveTerminal } from "./live-terminal";
import { TerminalPending } from "./terminal";
import { endedWords, sessionStatus } from "./terminal-status";
import { targetNoun, type TerminalTarget } from "./terminal-target";
import { TerminalView } from "./terminal-view";
import TerminalWell from "./terminal-well";
import { useLiveTerminal } from "./use-live-terminal";

/**
 * A page's terminal session, and its **Dock** control.
 *
 * **The session is built inside the lazy boundary, on purpose.** Both gateways
 * speak first — "Connecting…", the local Server's "Setting up private SSH
 * key…", the `\x1bc` that clears the screen when the channel comes up — so a
 * socket opened by a parent while this chunk was still downloading would have
 * those lines land nowhere. (`TerminalEmulator` also queues frames, which covers
 * the window between the socket opening and xterm's own import resolving.)
 *
 * The page holds the session until it is docked. Unmounting — a navigation, a
 * change of target — ends a session the page still holds, which closes the
 * socket and has the gateway reap the shell. A docked session is the
 * Dock's, so the page lets go of it instead and says where it went; there is
 * no way back (triage, decision 1), but there is a fresh shell here for anyone
 * who wants one beside it.
 *
 * The Dock control is drawn wherever a `<Terminal>` is inside the console
 * shell, so every in-page shell — the Server's Terminal tab, the This host
 * card, and the Service Shell tab — has it without asking for it.
 */
export default function TerminalSession({
  target,
  footer,
}: {
  target: TerminalTarget;
  footer?: React.ReactNode;
}) {
  const dock = useDock();
  const [generation, setGeneration] = useState(0);
  const [session, setSession] = useState<LiveTerminal | null>(null);

  useEffect(() => {
    const live = new LiveTerminal(target, "page");
    live.start();
    // The session is an external resource with a teardown, so it is made
    // here and not in a state initialiser: React runs an initialiser twice in
    // development and keeps one, and the other would be a socket nothing
    // closes. One render to show it is the whole cost.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSession(live);
    return () => {
      if (live.owner === "page") live.dispose();
    };
    // `target` is not a dependency on purpose: `<Terminal>` keys this
    // component on it, so a different target is a different component, and an
    // identity that changed every render would be a new shell every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation]);

  if (!session) return <TerminalPending />;

  if (session.owner === "dock") {
    return (
      <Moved
        session={session}
        onShow={
          dock?.sessions.includes(session) ? () => dock.show(session.id) : null
        }
        onNew={() => setGeneration((was) => was + 1)}
      />
    );
  }

  return (
    <PageTerminal
      session={session}
      footer={footer}
      actions={
        dock ? (
          <>
            {/* At the cap the control is disabled, with the reason beside it
                rather than only in a tooltip. */}
            {dock.shellsFull ? (
              <span className="text-meta text-tx-2">
                {DOCK_SHELLS_FULL_SENTENCE}
              </span>
            ) : null}
            <Button
              size="xs"
              disabled={dock.shellsFull}
              onClick={() => dock.dock(session)}
              title={
                dock.shellsFull
                  ? DOCK_SHELLS_FULL_SENTENCE
                  : "Move this shell into a panel along the bottom of the console. It keeps running there while you go to other pages."
              }
            >
              <Icon name="dock" size={13} />
              Dock
            </Button>
          </>
        ) : null
      }
    />
  );
}

function PageTerminal({
  session,
  footer,
  actions,
}: {
  session: LiveTerminal;
  footer?: React.ReactNode;
  actions: React.ReactNode;
}) {
  const { stream, grid } = useLiveTerminal(session);
  const { target } = session;

  return (
    <TerminalView
      stream={stream}
      grid={grid}
      noun={targetNoun(target)}
      actions={actions}
      target={
        target.kind === "server" ? (
          <>
            <span className="font-medium text-tx">{target.name}</span>
            <span className="font-mono text-meta"> {target.address}</span>
          </>
        ) : (
          <>
            <span className="font-medium text-tx">{target.name}</span>
            <span className="text-meta"> on {target.host}</span>
            <span className="font-mono text-meta">
              {" "}
              · {target.shell ?? "sh"}
            </span>
          </>
        )
      }
      footer={
        footer ??
        (target.kind === "server"
          ? "You are the Server's SSH user. Anything you run here is outside Cloudgate's record of the machine."
          : "This shell is inside the container. It goes when the container does, and so does anything written outside a volume.")
      }
      well={<TerminalWell session={session} className="h-[min(65vh,28rem)]" />}
    />
  );
}

/**
 * Where the page's shell went — the Dock — and the way to another one.
 *
 * Read off the docked session's own socket, so it says what the Dock tab says:
 * a shell whose lease ended there (or which exited, or lost its machine) is not
 * "still running", which this used to say while the Dock tab read "No longer
 * authorized".
 */
function Moved({
  session,
  onShow,
  onNew,
}: {
  session: LiveTerminal;
  onShow: (() => void) | null;
  onNew: () => void;
}) {
  const stream = useTerminalChannel(session.channel);
  const closed = session.disposed;
  const endedThere = closed ? null : endedWords(stream);
  const ended = closed || endedThere !== null;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel px-3.5 py-3 shadow-panel">
      <Icon name="dock" size={15} className="text-tx-2" />
      <p className="min-w-0 flex-1 text-body text-tx-2">
        {closed
          ? "This shell moved to the Dock and has since been closed there."
          : endedThere !== null
            ? `This shell moved to the Dock and has ended there: ${lowerFirst(endedThere)}.`
            : sessionStatus(stream) === "running"
              ? "This shell is in the Dock at the bottom of the console, still running."
              : "This shell is in the Dock at the bottom of the console."}
      </p>
      {/* Still offered once it has ended there: the Dock tab keeps the reason
          and the scrollback until it is closed. */}
      {onShow && !closed ? (
        <Button size="sm" onClick={onShow}>
          Show the Dock
        </Button>
      ) : null}
      <Button size="sm" variant={ended ? "pri" : "gh"} onClick={onNew}>
        <Icon name="term" size={14} />
        Open a new shell here
      </Button>
    </div>
  );
}

/** `endedWords` leads a line of its own; here it follows a colon. */
const lowerFirst = (words: string): string =>
  words.charAt(0).toLowerCase() + words.slice(1);
