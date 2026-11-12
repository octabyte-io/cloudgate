import { Icon } from "@/lib/design/icons";
import type { TerminalStream } from "@/lib/realtime/gateways";

import { StatusPill } from "./status-pill";
import { TerminalStatus, sessionStatus } from "./terminal-status";

/**
 * A page's terminal frame: the chrome around the well. Reached through
 * `terminal.tsx`, which is the `next/dynamic` boundary — never imported
 * directly.
 *
 * Presentational: `terminal-session.tsx` holds the session and passes the
 * well in. The Dock draws its own chrome around the same well, since a
 * panel along the bottom of the console has a header of controls rather than a
 * card's.
 */
export type TerminalViewProps = {
  stream: TerminalStream;
  /** The emulator's grid, for the readout. */
  grid: { cols: number; rows: number } | null;
  /** What this shell is attached to, at all times. A privileged surface says so. */
  target: React.ReactNode;
  /** Under the frame, while it is connected — what this session cannot do. */
  footer?: React.ReactNode;
  /**
   * What to call the far end inside a sentence — `terminal-target.ts`'s
   * `targetNoun`. The status line and the pty tooltip both name it, and neither
   * can work it out from `target`, which is a rendered node.
   */
  noun: string;
  /** Controls at the end of the header — the Dock button. */
  actions?: React.ReactNode;
  /** The emulator's well, `terminal-well.tsx`. */
  well: React.ReactNode;
};

export function TerminalView({
  stream,
  grid,
  target,
  footer,
  noun,
  actions,
  well,
}: TerminalViewProps) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel shadow-panel">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-panel-2 px-3.5 py-2.5">
        <span className="flex min-w-0 flex-1 items-center gap-2 text-ui text-tx-2">
          <Icon name="term" size={15} />
          <span className="min-w-0 truncate">{target}</span>
        </span>
        <span
          className="font-mono text-chip text-tx-3"
          title={`The size of the pty on ${noun}. It follows this window.`}
        >
          {grid ? `${grid.cols} × ${grid.rows}` : "—"}
        </span>
        <StatusPill status={sessionStatus(stream)} />
        {actions}
      </div>

      {well}

      <TerminalStatus stream={stream} footer={footer} noun={noun} />
    </div>
  );
}
