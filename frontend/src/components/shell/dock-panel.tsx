import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

import type { LiveTerminal } from "@/components/console/live-terminal";
import { StatusPill } from "@/components/console/status-pill";
import {
  TerminalStatus,
  sessionStatus,
} from "@/components/console/terminal-status";
import {
  targetNoun,
  terminalTitle,
  type TerminalTarget,
} from "@/components/console/terminal-target";
import { useLiveTerminal } from "@/components/console/use-live-terminal";
import { Button } from "@/components/ui/button";
import { Icon } from "@/lib/design/icons";
import type { LiveLog } from "@/lib/realtime/live-log";

import { useDockView } from "./dock-state";
import { DockAddShell } from "./dock-add-shell";
import { DockCloseAll } from "./dock-close-all";
import type { DockApi } from "./dock-context";
import { DockLogBody, logName } from "./dock-log";
import { DockResizeHandle } from "./dock-resize-handle";
import {
  DOCK_LOGS_FULL_SENTENCE,
  DOCK_SHELLS_FULL_SENTENCE,
  type DockTab,
} from "./dock-store";
import { DockTabs } from "./dock-tabs";

const DockWell = dynamic(() => import("@/components/console/terminal-well"), {
  ssr: false,
  loading: () => <div className="min-h-0 flex-1 bg-well" aria-busy="true" />,
});

/**
 * The open dock: its header — tabs, `+`, the caps' sentences, the pty size
 * and status of an active shell, minimise, maximise and close — and the
 * active tab's body: a shell's well and its status line, or a log filling the
 * panel. `dock.tsx` says what the dock as a whole promises.
 */
export function DockPanel({
  dock,
  tab,
  panel,
  settleFocus,
}: {
  dock: DockApi;
  tab: DockTab<LiveTerminal, LiveLog>;
  panel: React.RefObject<HTMLElement | null>;
  /** Focus a log tab `show` asked for, now that its body is drawn. */
  settleFocus: () => void;
}) {
  const view = useDockView();
  const title =
    tab.kind === "shell" ? terminalTitle(tab.session.target) : logName(tab.log);
  const [confirmClose, setConfirmClose] = useState(false);

  // A tab that just arrived — opened here, or docked from a page — gets the
  // keyboard, and ⌃` learns where on the page to give it back to. Switching
  // tabs is not an arrival: the tab keeps focus, for its arrow keys.
  const arrived = useRef(new Set<string>());
  const show = dock.show;
  useEffect(() => {
    if (arrived.current.has(tab.id)) return;
    arrived.current.add(tab.id);
    show();
  }, [tab.id, show]);
  // A log shown from its page while another tab was in front is focused once
  // its body is here.
  useEffect(() => settleFocus(), [tab.id, settleFocus]);

  const count = dock.tabs.length;
  const closeAll = () => {
    if (count > 1) setConfirmClose(true);
    else dock.closeAll();
  };

  return (
    <section
      ref={panel}
      aria-label={tab.kind === "shell" ? `Terminal: ${title}` : `Log: ${title}`}
      data-slot="dock"
      className="dock-panel relative flex min-h-0 min-w-0 flex-col border-t border-line bg-panel shadow-pop"
    >
      <DockResizeHandle panel={panel} />

      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line bg-panel-2 pr-1.5 pl-2">
        {/* The active tab's kind: a shell's prompt, or a log's lines. */}
        <Icon
          name={tab.kind === "shell" ? "term" : "lines"}
          size={15}
          className="ml-1 shrink-0 text-tx-2"
        />
        <DockTabs dock={dock} />
        <DockAddShell dock={dock} />
        {dock.shellsFull ? (
          <span className="min-w-0 truncate text-meta text-tx-2 max-hd:hidden">
            {DOCK_SHELLS_FULL_SENTENCE}
          </span>
        ) : null}
        {dock.logsFull ? (
          <span className="min-w-0 truncate text-meta text-tx-2 max-hd:hidden">
            {DOCK_LOGS_FULL_SENTENCE}
          </span>
        ) : null}
        <span className="flex-1" />
        {tab.kind === "shell" ? <ShellMeta session={tab.session} /> : null}

        <span className="flex items-center gap-0.5">
          {view === "minimised" ? (
            <HeaderButton
              icon="chevU"
              label="Restore the Dock"
              onClick={() => dock.show()}
            />
          ) : (
            <HeaderButton
              icon="chevD"
              label="Minimise the Dock"
              onClick={dock.minimise}
            />
          )}
          {view === "maximised" ? (
            <HeaderButton
              icon="restore"
              label="Restore the Dock's height"
              onClick={dock.restore}
            />
          ) : (
            <HeaderButton
              icon="maximise"
              label="Maximise the Dock"
              onClick={dock.maximise}
            />
          )}
          <HeaderButton
            icon="x"
            label="Close the Dock"
            title={
              count > 1
                ? "Close the Dock. This ends every shell and log in it, and everything running in the shells."
                : tab.kind === "shell"
                  ? "Close the Dock. This ends the shell and everything running in it."
                  : "Close the Dock. This ends the log here."
            }
            onClick={closeAll}
          />
        </span>
      </div>

      <div className="dock-body flex min-h-0 flex-1 flex-col">
        {tab.kind === "shell" ? (
          <ShellBody session={tab.session} />
        ) : (
          <DockLogBody key={tab.id} log={tab.log} />
        )}
      </div>

      <DockCloseAll
        open={confirmClose}
        count={count}
        logs={dock.logs.length}
        onCancel={() => setConfirmClose(false)}
        onConfirm={() => {
          setConfirmClose(false);
          dock.closeAll();
        }}
      />
    </section>
  );
}

/** The active shell's pty size and status, in the header. */
function ShellMeta({ session }: { session: LiveTerminal }) {
  const { stream, grid } = useLiveTerminal(session);
  const noun = targetNoun(session.target);
  return (
    <>
      <span
        className="font-mono text-chip text-tx-3 max-hd:hidden"
        title={`The size of the pty on ${noun}. It follows this panel.`}
      >
        {grid ? `${grid.cols} × ${grid.rows}` : "—"}
      </span>
      <StatusPill status={sessionStatus(stream)} />
    </>
  );
}

/** The active shell's well and its status line. */
function ShellBody({ session }: { session: LiveTerminal }) {
  const { stream } = useLiveTerminal(session);
  return (
    <>
      {/* Keyed on the session: a new well is a mount, and a mount refits
          the emulator and sends the shell its size. */}
      <DockWell key={session.id} session={session} className="min-h-0 flex-1" />
      <TerminalStatus
        stream={stream}
        noun={targetNoun(session.target)}
        footer={<DockFooter target={session.target} />}
      />
    </>
  );
}

/**
 * Under a connected docked shell: what it is, and what ends it.
 *
 * A container's shell is `sh`, which the Dock opens it with. The sentence the
 * container-shell dialog carried says so without claiming every image has one
 * — distroless images and those built from scratch carry none.
 */
function DockFooter({ target }: { target: TerminalTarget }) {
  return (
    <>
      {target.kind === "container" && (target.shell ?? "sh") === "sh" ? (
        <>
          This opens <code className="font-mono">sh</code>, which most images
          carry — not all do. Run <code className="font-mono">bash</code> inside
          it if the image has one.{" "}
        </>
      ) : null}
      It stays open while you move around the console. Closing its tab ends it;
      minimising does not.
    </>
  );
}

function HeaderButton({
  icon,
  label,
  title,
  onClick,
}: {
  icon: "chevU" | "chevD" | "maximise" | "restore" | "x";
  label: string;
  title?: string;
  onClick: () => void;
}) {
  return (
    <Button
      size="icon-xs"
      variant="qt"
      aria-label={label}
      title={title ?? label}
      onClick={onClick}
    >
      <Icon name={icon} size={14} />
    </Button>
  );
}
