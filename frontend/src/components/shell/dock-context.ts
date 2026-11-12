import { createContext, use, useEffect } from "react";

import type { LiveTerminal } from "@/components/console/live-terminal";
import {
  terminalKey,
  type TerminalTarget,
} from "@/components/console/terminal-target";
import type { LiveLog } from "@/lib/realtime/live-log";

import type { DockResult, DockTab } from "./dock-store";
import type { TerminalOffer, TerminalOfferRegistry } from "./terminal-offers";

/**
 * The Dock, as every page sees it. Provided by
 * `DockProvider` in the console shell; `null` outside it — a door, a
 * test — where nothing can be docked and no Dock control is drawn.
 */
export type DockApi = {
  /** Every tab, shells and logs, in arrival order. */
  tabs: readonly DockTab<LiveTerminal, LiveLog>[];
  /** The tab on screen, or `null` while the Dock is closed. */
  activeTab: DockTab<LiveTerminal, LiveLog> | null;
  /** The docked shells, in tab order. Empty while the Dock holds none. */
  sessions: readonly LiveTerminal[];
  /** The active tab's shell, or `null` while a log or nothing is shown. */
  active: LiveTerminal | null;
  /** The Docked logs, in tab order, counted apart from the shells. */
  logs: readonly LiveLog[];
  /**
   * The Dock holds `MAX_DOCK_SHELLS` shells: every control that would add one
   * is disabled, with `DOCK_SHELLS_FULL_SENTENCE` beside it. A full logs
   * group never sets it.
   */
  shellsFull: boolean;
  /**
   * The Dock holds `MAX_DOCK_LOGS` logs: every log card's Dock button is
   * disabled, with `DOCK_LOGS_FULL_SENTENCE` beside it. A full shells group
   * never sets it.
   */
  logsFull: boolean;
  /** Open a new shell straight into the Dock, as a new active tab. */
  open: (target: TerminalTarget) => DockResult;
  /** Move a page's live session into the Dock — same socket, same scrollback. */
  dock: (session: LiveTerminal) => DockResult;
  /**
   * Move a page's Live log into the Dock — same socket, the lines it holds,
   * its following flag. A log already docked under its key is shown instead,
   * and the page keeps the one it passed.
   */
  dockLog: (log: LiveLog) => DockResult;
  /** Show another tab. */
  activate: (id: string) => void;
  /** End one shell or log; a shell's gateway reaps it. */
  close: (id: string) => void;
  /** End every shell and log. The panel asks first when there is more than one. */
  closeAll: () => void;
  /** Collapse to the header bar. Every shell keeps running. */
  minimise: () => void;
  /** Fill the viewport below the masthead. */
  maximise: () => void;
  /** Back to the dragged height. */
  restore: () => void;
  /** Make `id` (else the active tab) shown, restore if minimised, focus it. */
  show: (id?: string) => void;
  /** What this page offers under `+` — see `useTerminalOffers`. */
  offers: TerminalOfferRegistry;
};

export const DockContext = createContext<DockApi | null>(null);

export function useDock(): DockApi | null {
  return use(DockContext);
}

/**
 * Offer shells under the Dock's `+` while this component is mounted.
 *
 * A page, layout or card calls it with the shells *its* subject can open —
 * the Server page its Server, the fleet screen this host, a Service page its
 * running container — and **only those the caller may open**: work the
 * permission out first and pass `[]` (or leave the entry out) when the answer
 * is no. The `+` lists offers as given.
 *
 * Pass a new array every render if that is easiest: the registration is
 * replaced only when the set of targets (`terminalKey`) changes. Outside the
 * console shell it does nothing.
 */
export function useTerminalOffers(offers: readonly TerminalOffer[]): void {
  const registry = useDock()?.offers ?? null;
  const identity = offers.map((offer) => terminalKey(offer.target)).join("|");

  useEffect(() => {
    if (!registry) return;
    return registry.register(offers);
    // `identity` stands for `offers`, which is a new array every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, identity]);
}
