import type { LiveTerminal } from "@/components/console/live-terminal";
import { endedWords } from "@/components/console/terminal-status";
import { terminalTitle } from "@/components/console/terminal-target";
import { useLiveTerminal } from "@/components/console/use-live-terminal";
import { Icon } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

import type { DockApi } from "./dock-context";
import { DockLogTab } from "./dock-log";
import { MAX_DOCK_LOGS, MAX_DOCK_SHELLS, dockRow } from "./dock-store";

/**
 * The tab row, drawn as two labelled groups, "Shells n/4" and "Logs n/4",
 * each in arrival order. Both labels show whenever the Dock is open — an
 * empty group says "0/4" — so both caps are read at a glance.
 *
 * One tab per shell, named by the header's rule (`terminalTitle`), with its
 * own Close. A shell that ended — exited, revoked (`4010`), unreachable, no
 * shell in the image — says so on its tab, so one that died in the
 * background does not look like one sitting idle. A log's tab is
 * `dock-log.tsx`'s. The arrow keys move along the whole row, across groups.
 */
export function DockTabs({ dock }: { dock: DockApi }) {
  const shells = dock.tabs.filter((tab) => tab.kind === "shell");
  const logs = dock.tabs.filter((tab) => tab.kind === "log");
  // The order they are drawn in, which is the order the arrow keys walk.
  const row = dockRow(dock.tabs);
  const activeId = dock.activeTab?.id ?? null;

  const move = (event: React.KeyboardEvent, from: string) => {
    const step =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const at = row.findIndex((tab) => tab.id === from);
    const next = row[(at + step + row.length) % row.length];
    if (!next) return;
    dock.activate(next.id);
    const rowElement = event.currentTarget.closest("[data-dock-tabs]");
    rowElement?.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus();
  };

  return (
    <div
      data-dock-tabs
      className="flex min-w-0 shrink items-center gap-1.5 overflow-x-auto"
    >
      <span className="shrink-0 text-meta whitespace-nowrap text-tx-3">
        Shells {shells.length}/{MAX_DOCK_SHELLS}
      </span>
      {shells.length > 0 ? (
        <>
          <div
            role="tablist"
            aria-label="Shells in the Dock"
            className="flex min-w-0 items-center gap-1"
          >
            {shells.map((tab) =>
              tab.kind === "shell" ? (
                <DockShellTab
                  key={tab.id}
                  session={tab.session}
                  selected={tab.id === activeId}
                  onSelect={() => dock.activate(tab.id)}
                  onClose={() => dock.close(tab.id)}
                  onKeyDown={(event) => move(event, tab.id)}
                />
              ) : null,
            )}
          </div>
        </>
      ) : null}
      <span className="ml-1.5 shrink-0 text-meta whitespace-nowrap text-tx-3">
        Logs {logs.length}/{MAX_DOCK_LOGS}
      </span>
      {logs.length > 0 ? (
        <>
          <div
            role="tablist"
            aria-label="Logs in the Dock"
            className="flex min-w-0 items-center gap-1"
          >
            {logs.map((tab) =>
              tab.kind === "log" ? (
                <DockLogTab
                  key={tab.id}
                  log={tab.log}
                  selected={tab.id === activeId}
                  onSelect={() => dock.activate(tab.id)}
                  onClose={() => dock.close(tab.id)}
                  onKeyDown={(event) => move(event, tab.id)}
                />
              ) : null,
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

function DockShellTab({
  session,
  selected,
  onSelect,
  onClose,
  onKeyDown,
}: {
  session: LiveTerminal;
  selected: boolean;
  onSelect: () => void;
  onClose: () => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
}) {
  const { stream } = useLiveTerminal(session);
  const title = terminalTitle(session.target);
  const ended = endedWords(stream);

  return (
    <span
      role="presentation"
      className={cn(
        "flex h-7 max-w-64 min-w-0 shrink-0 items-center rounded-md",
        selected ? "bg-panel text-tx shadow-panel" : "text-tx-2 hover:bg-raise",
      )}
    >
      <button
        type="button"
        role="tab"
        data-tab={session.id}
        aria-selected={selected}
        tabIndex={selected ? 0 : -1}
        title={ended ? `${title} — ${ended}` : title}
        onClick={onSelect}
        onKeyDown={onKeyDown}
        className="flex h-full min-w-0 items-center gap-1.5 pr-1 pl-2.5 text-ui outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        <span className={cn("min-w-0 truncate", selected && "font-medium")}>
          {title}
        </span>
        {ended ? (
          <span className="shrink-0 text-meta text-bad">{ended}</span>
        ) : null}
      </button>
      <button
        type="button"
        aria-label={`Close ${title}`}
        title={`Close ${title}. This ends the shell and everything running in it.`}
        onClick={onClose}
        className="mr-0.5 grid size-5 shrink-0 place-items-center rounded text-tx-3 hover:bg-raise hover:text-tx"
      >
        <Icon name="x" size={12} />
      </button>
    </span>
  );
}
