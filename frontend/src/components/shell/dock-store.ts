import type { TerminalOwner } from "@/components/console/live-terminal";
import type { TerminalTarget } from "@/components/console/terminal-target";
import type { LiveLogOwner } from "@/lib/realtime/live-log";

/**
 * How many shells the Dock holds at once (triage decision 1).
 *
 * Each one is a socket holding a `docker exec` or an SSH channel open and
 * renewing its lease every 30s (ADR-0012), and the backend sets no per-user
 * limit, so the console sets one. Enforced here only: `open` and `dock` refuse
 * past it, and every control that would add a shell — the Dock's `+`, a page's
 * Dock button, Open a shell — is disabled with
 * {@link DOCK_SHELLS_FULL_SENTENCE}.
 */
export const MAX_DOCK_SHELLS = 4;

/** Beside every control the shells cap disables. */
export const DOCK_SHELLS_FULL_SENTENCE =
  "The Dock holds four shells. Close one to open another.";

/**
 * How many logs the Dock holds at once, counted apart from the shells: a full
 * group of one kind never blocks the other. Every kind of log counts alike
 * (CONTEXT.md, **Docked log**).
 */
export const MAX_DOCK_LOGS = 4;

/** Beside every log card's Dock button the logs cap disables. */
export const DOCK_LOGS_FULL_SENTENCE =
  "The Dock holds four logs. Close one to dock another.";

/**
 * What the Dock needs of a shell — `LiveTerminal`'s shape, narrowed so the
 * rules below can be tested without a socket or an emulator. Its key is its
 * target; two shells on one target are two tabs.
 */
export type DockableShell = {
  readonly id: string;
  readonly target: TerminalTarget;
  owner: TerminalOwner;
  readonly disposed: boolean;
  dispose: () => void;
};

/**
 * What the Dock needs of a log — `LiveLog`'s shape, narrowed the same way. Its
 * key names what the log is (this Deployment, this container), and the Dock
 * holds at most one tab per key.
 */
export type DockableLog = {
  readonly id: string;
  readonly key: string;
  owner: LiveLogOwner;
  readonly disposed: boolean;
  dispose: () => void;
};

/** One tab in the Dock: a Docked shell or a Docked log. */
export type DockTab<S, L> =
  | { readonly kind: "shell"; readonly id: string; readonly session: S }
  | { readonly kind: "log"; readonly id: string; readonly log: L };

export type DockSnapshot<S, L> = {
  /** Every tab, shells and logs, in arrival order. Empty when closed. */
  tabs: readonly DockTab<S, L>[];
  /** The tab on screen, or `null` when the Dock is closed. */
  activeId: string | null;
};

/** `docked` — it is in the Dock and active now; `full` — refused at its cap. */
export type DockResult = "docked" | "full";

/** The docked shells, in arrival order. */
export function dockShells<S>(snapshot: DockSnapshot<S, unknown>): S[] {
  return snapshot.tabs.flatMap((tab) =>
    tab.kind === "shell" ? [tab.session] : [],
  );
}

/** The docked logs, in arrival order. */
export function dockLogs<L>(snapshot: DockSnapshot<unknown, L>): L[] {
  return snapshot.tabs.flatMap((tab) => (tab.kind === "log" ? [tab.log] : []));
}

/**
 * The tabs in the order the row draws them — the shells group, then the logs
 * group, each in arrival order. What the arrow keys walk and what a closed
 * tab's neighbour is read from.
 */
export function dockRow<T extends { readonly kind: "shell" | "log" }>(
  tabs: readonly T[],
): T[] {
  return [
    ...tabs.filter((tab) => tab.kind === "shell"),
    ...tabs.filter((tab) => tab.kind === "log"),
  ];
}

export function dockShellsFull(
  snapshot: DockSnapshot<unknown, unknown>,
): boolean {
  return dockShells(snapshot).length >= MAX_DOCK_SHELLS;
}

export function dockLogsFull(
  snapshot: DockSnapshot<unknown, unknown>,
): boolean {
  return dockLogs(snapshot).length >= MAX_DOCK_LOGS;
}

/**
 * The console layout's owner of the docked shells and logs.
 *
 * Held by the `(console)` layout, not a page, so a tab survives navigation:
 * moving between Projects, Services and Servers re-renders everything under
 * the layout and leaves this alone. It owns no socket of its own — a shell is
 * a `LiveTerminal` and a log a `LiveLog`, and docking one is taking ownership
 * of it, so the page's socket and what it already holds arrive intact.
 *
 * **One ordered list of tabs of two kinds.** Opening or docking adds a tab and
 * makes it active. Each kind has its own cap of four ({@link MAX_DOCK_SHELLS},
 * {@link MAX_DOCK_LOGS}); past it the new one is refused (`"full"`) and
 * nothing is built or taken. A log is in the Dock at most once, by its key.
 * Closing a tab ends that shell or log only; `closeAll` ends them all (the
 * panel asks first when there is more than one). A background tab keeps
 * running — its socket is outside React.
 *
 * The Dock's view (minimised, maximised, height) is not here: it is a
 * per-browser preference held on `<html>`, `dock-state.ts`.
 */
export class DockStore<S extends DockableShell, L extends DockableLog> {
  private snapshot: DockSnapshot<S, L> = { tabs: [], activeId: null };
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly deps: {
      /** A new session for `target`, owned by the Dock and already dialling. */
      create: (target: TerminalTarget) => S;
      /** Bring the Dock into view — a tab just arrived in it. */
      reveal: () => void;
    },
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): DockSnapshot<S, L> => this.snapshot;

  /** Open a new shell in the Dock — the container shell's way in, and `+`. */
  open = (target: TerminalTarget): DockResult => {
    if (dockShellsFull(this.snapshot)) return "full";
    const session = this.deps.create(target);
    this.install({ kind: "shell", id: session.id, session }, session);
    return "docked";
  };

  /** Move a page's live session into the Dock. There is no way back. */
  dock = (session: S): DockResult => {
    if (dockShells(this.snapshot).includes(session)) {
      this.activate(session.id);
      this.deps.reveal();
      return "docked";
    }
    if (dockShellsFull(this.snapshot)) return "full";
    this.install({ kind: "shell", id: session.id, session }, session);
    return "docked";
  };

  /**
   * Move a page's Live log into the Dock. There is no way back. A log already
   * docked under the same key is shown instead, and the page keeps the one it
   * passed.
   */
  dockLog = (log: L): DockResult => {
    const there = dockLogs(this.snapshot).find((held) => held.key === log.key);
    if (there) {
      this.activate(there.id);
      this.deps.reveal();
      return "docked";
    }
    if (dockLogsFull(this.snapshot)) return "full";
    this.install({ kind: "log", id: log.id, log }, log);
    return "docked";
  };

  /** Show another tab. Ends nothing. */
  activate = (id: string): void => {
    if (this.snapshot.activeId === id) return;
    if (!this.snapshot.tabs.some((tab) => tab.id === id)) return;
    this.emit({ ...this.snapshot, activeId: id });
  };

  /**
   * End one shell or log and drop its tab. The active tab passes to its
   * right-hand neighbour on screen, else the left, whatever its kind — the
   * row's order (`dockRow`), not the order they arrived in; the last one
   * closes the Dock.
   */
  close = (id: string): void => {
    const { tabs, activeId } = this.snapshot;
    const closing = tabs.find((tab) => tab.id === id);
    if (!closing) return;
    heldBy(closing).dispose();
    const rest = tabs.filter((tab) => tab !== closing);
    const row = dockRow(tabs);
    const at = row.indexOf(closing);
    const left = row.filter((tab) => tab !== closing);
    const nextActive =
      activeId !== id
        ? activeId
        : ((left[at] ?? left[at - 1] ?? null)?.id ?? null);
    this.emit({ tabs: rest, activeId: nextActive });
  };

  /** End every shell and every log, and close the Dock. */
  closeAll = (): void => {
    for (const tab of this.snapshot.tabs) heldBy(tab).dispose();
    this.emit({ tabs: [], activeId: null });
  };

  /**
   * The layout is going, or the Organization or the person changed: every
   * tab ends at once (triage decision 2).
   */
  dispose = (): void => this.closeAll();

  private install(tab: DockTab<S, L>, taken: S | L): void {
    // Taking it is setting its owner, which a `LiveLog` publishes: the page
    // box reading it renders again and shows its note.
    taken.owner = "dock";
    this.emit({ tabs: [...this.snapshot.tabs, tab], activeId: tab.id });
    this.deps.reveal();
  }

  private emit(next: DockSnapshot<S, L>): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

/** What a tab holds, which closing the tab ends. */
function heldBy<S extends DockableShell, L extends DockableLog>(
  tab: DockTab<S, L>,
): S | L {
  return tab.kind === "shell" ? tab.session : tab.log;
}
