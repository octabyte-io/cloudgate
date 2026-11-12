import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { LiveTerminal } from "@/components/console/live-terminal";
import { isDockShortcut } from "@/components/console/terminal-keys";
import type { TerminalTarget } from "@/components/console/terminal-target";
import { onTerminalsEnded } from "@/lib/realtime/gateways";
import type { LiveLog } from "@/lib/realtime/live-log";

import { readDockView, setDockView } from "./dock-state";
import { DockContext, useDock, type DockApi } from "./dock-context";
import { DOCK_LOG_ATTRIBUTE, DOCK_RETURN_ATTRIBUTE } from "./dock-log";
import { DockPanel } from "./dock-panel";
import {
  DockStore,
  dockLogs,
  dockLogsFull,
  dockShells,
  dockShellsFull,
  type DockSnapshot,
  type DockTab,
} from "./dock-store";
import { TerminalOfferRegistry } from "./terminal-offers";

/**
 * The Dock: up to four Docked shells and four Docked logs as tabs,
 * held by the console layout, full width along the bottom under the rail and
 * the page.
 *
 * - **It survives navigation** because it is the layout's and not a page's:
 *   the sessions live in `DockStore`, which this provider makes once
 *   for the console shell's lifetime. The store holds tabs of two kinds,
 *   shells and Live logs, with a cap of four each, and the panel draws
 *   either: a log card's Dock button moves its Live log here (`dockLog`), and
 *   the log fills the panel (`dock-log.tsx`).
 * - **Docking moves a session, it does not rebuild one** — `LiveTerminal`
 *   owns its socket and emulator outside React, so the Dock shows the same
 *   xterm the page did (`terminal-session.tsx`'s Dock control).
 * - **One tab per shell; only the active one is on screen.** The others keep
 *   their socket and their xterm (scrollback included), unmounted. Showing a
 *   tab mounts its well, which refits the emulator at once and tells the shell
 *   its size (`TerminalEmulator.mount`) — so one resized while hidden reports
 *   the right size. Each tab watches its own socket, so a background shell
 *   that ended says so on its tab.
 * - **`+` opens what the current page offers** (`useTerminalOffers`), and the
 *   cap disables it — and every page's Dock control — with
 *   `DOCK_SHELLS_FULL_SENTENCE`.
 * - **Closing a tab ends that shell**, which is the socket closing and the
 *   gateway reaping the processes behind it. Closing the panel ends
 *   them all, after a question when there is more than one. Minimising keeps
 *   every one running.
 * - **It never outlives the Organization or the sign-in it was opened
 *   under**: `endAllTerminals` (organization switch, sign-out) ends every
 *   shell at once, and the layout unmounting ends them too. So does leaving
 *   the page into the browser's back/forward cache (`endTerminalsOnPageHide`).
 * - **Its shape is the browser's**: height and minimised/maximised, on
 *   `<html>` before first paint (`dock-state.ts`). A reload brings it back
 *   closed; tabs are not restored.
 * - **⌃`** toggles it and acts on the active tab. From the page it restores
 *   the Dock and focuses that terminal, or a log's scroller; from inside the
 *   Dock it minimises and gives focus back to the page — to a docked log's
 *   Show the Dock when what had focus there was the Dock button it took. The listener is on `window` in the capture
 *   phase, so it hears the key before xterm's textarea does, and the emulator
 *   declines it as well.
 * - **Below the rail's drawer width it is full-screen** under the masthead
 *   rather than docked (`globals.css` section 7b).
 *
 * This file is the provider and the slot. The panel is
 * `dock-panel.tsx`, built from `dock-tabs.tsx`, the `+` menu
 * (`dock-add-shell.tsx`), the drag handle
 * (`dock-resize-handle.tsx`) and the close-all question
 * (`dock-close-all.tsx`).
 */

/**
 * The panel element, which the shortcut asks "is focus in here?", and how the
 * panel hands focus to a log tab once its scroller is on screen.
 */
type PanelSlot = {
  panel: React.RefObject<HTMLElement | null>;
  settleFocus: () => void;
};
const PanelContext = createContext<PanelSlot | null>(null);

function createDocked(target: TerminalTarget): LiveTerminal {
  const session = new LiveTerminal(target, "dock");
  session.start();
  return session;
}

export function DockProvider({
  children,
  create = createDocked,
}: {
  children: React.ReactNode;
  /** How the Dock opens a shell of its own. Tests pass one without xterm. */
  create?: (target: TerminalTarget) => LiveTerminal;
}) {
  const panel = useRef<HTMLElement | null>(null);
  /** Where focus was on the page before the shortcut took it to the Dock. */
  const pageFocus = useRef<HTMLElement | null>(null);
  /**
   * A log tab asked to be focused before its scroller was drawn — shown from
   * the page while another tab was in front. The panel settles it once drawn.
   */
  const pendingLog = useRef<string | null>(null);

  const [store] = useState(
    () =>
      new DockStore<LiveTerminal, LiveLog>({
        create,
        // A shell arriving is a shell wanted on screen; a maximised Dock stays
        // maximised.
        reveal: () => {
          if (readDockView() === "minimised") setDockView("normal");
        },
      }),
  );
  const [offers] = useState(() => new TerminalOfferRegistry());
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  // An organization switch or a sign-out ends every terminal; the panel goes
  // with its shells.
  useEffect(() => onTerminalsEnded(store.dispose), [store]);
  // The console layout going — a navigation out to a door — ends them too.
  useEffect(() => () => store.dispose(), [store]);

  const settleFocus = useCallback(() => {
    const id = pendingLog.current;
    if (!id) return;
    const scroller = panel.current?.querySelector<HTMLElement>(
      `[${DOCK_LOG_ATTRIBUTE}="${id}"] [role="log"]`,
    );
    if (!scroller) return;
    pendingLog.current = null;
    scroller.focus();
  }, []);

  const api = useMemo(() => {
    const show = (id?: string) => {
      if (id) store.activate(id);
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && !panel.current?.contains(focused)) {
        pageFocus.current = focused;
      }
      if (readDockView() === "minimised") setDockView("normal");
      // Focus per kind: a shell's emulator, a log's `role="log"` scroller.
      const tab = activeTabOf(store.getSnapshot());
      if (tab?.kind === "shell") tab.session.emulator.focus();
      else if (tab?.kind === "log") {
        pendingLog.current = tab.id;
        settleFocus();
      }
    };
    const value: DockApi & { focusPage: () => void } = {
      tabs: snapshot.tabs,
      activeTab: activeTabOf(snapshot),
      sessions: dockShells(snapshot),
      active: activeOf(snapshot),
      logs: dockLogs(snapshot),
      shellsFull: dockShellsFull(snapshot),
      logsFull: dockLogsFull(snapshot),
      open: store.open,
      dock: store.dock,
      dockLog: (log: LiveLog) => {
        // A log already docked under its key is shown, as a tab arriving
        // is: in front, restored and with the keyboard on its scroller. The
        // panel focuses only a tab it has not seen, so this one is asked
        // for here. It keeps the address it came with.
        const there = dockLogs(store.getSnapshot()).find(
          (held) => held.key === log.key,
        );
        if (there) {
          show(there.id);
          return "docked";
        }
        // Where it came from, for its follow bar's Go to its page.
        log.page = `${location.pathname}${location.search}`;
        return store.dockLog(log);
      },
      activate: store.activate,
      close: store.close,
      closeAll: store.closeAll,
      minimise: () => setDockView("minimised"),
      maximise: () => setDockView("maximised"),
      restore: () => setDockView("normal"),
      show,
      offers,
      focusPage: () => {
        const back = pageFocus.current;
        if (back?.isConnected && back !== document.body) {
          back.focus();
          return;
        }
        // A log docked from its page took its Dock button with it: the
        // page's note, in its place, has Show the Dock, which is where the
        // keyboard was in all but name.
        const tab = activeTabOf(store.getSnapshot());
        const note =
          tab?.kind === "log"
            ? document.querySelector<HTMLElement>(
                `[${DOCK_RETURN_ATTRIBUTE}="${tab.id}"]`,
              )
            : null;
        if (note) note.focus();
        else document.getElementById("main")?.focus();
      },
    };
    return value;
  }, [snapshot, store, offers, settleFocus]);

  const slot = useMemo(() => ({ panel, settleFocus }), [settleFocus]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isDockShortcut(event)) return;
      if (!activeTabOf(store.getSnapshot())) return;
      event.preventDefault();
      event.stopPropagation();

      const inside = panel.current?.contains(document.activeElement) ?? false;
      if (inside) {
        setDockView("minimised");
        api.focusPage();
      } else {
        api.show();
      }
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [api, store]);

  return (
    <DockContext.Provider value={api}>
      <PanelContext.Provider value={slot}>{children}</PanelContext.Provider>
    </DockContext.Provider>
  );
}

/** The tab on screen; `null` while the Dock is closed. */
function activeTabOf(
  snapshot: DockSnapshot<LiveTerminal, LiveLog>,
): DockTab<LiveTerminal, LiveLog> | null {
  return snapshot.tabs.find((each) => each.id === snapshot.activeId) ?? null;
}

/** The active tab's shell; `null` while a log or nothing is on screen. */
function activeOf(
  snapshot: DockSnapshot<LiveTerminal, LiveLog>,
): LiveTerminal | null {
  const tab = activeTabOf(snapshot);
  return tab?.kind === "shell" ? tab.session : null;
}

/**
 * The panel itself, the console grid's third row. Nothing while the Dock is
 * closed.
 */
export function Dock() {
  const dock = useDock();
  const slot = use(PanelContext);
  if (!dock?.activeTab || !slot) return null;
  return (
    <DockPanel
      dock={dock}
      tab={dock.activeTab}
      panel={slot.panel}
      settleFocus={slot.settleFocus}
    />
  );
}
